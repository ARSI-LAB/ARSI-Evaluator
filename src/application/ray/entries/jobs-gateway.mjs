import { rejectUnknown } from "../../../../dist/core/validation/input.js";
import { parseMaintenanceRequest } from "../../../../dist/core/workflow/maintenance.js";
// Trusted single-tenant gateway. Ray Dashboard stays on the private cluster network.
import { controlTransaction, submitRetry } from "../../../../dist/application/retry-control/mailbox.js";
import { createServer } from "node:https";
import { request as rayRequest } from "node:http";
import { readFile, writeFile, mkdir, readdir, open, rm, stat } from "node:fs/promises";
import { createHash, timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import { buildFileManifest, checkedPath } from "../../../../dist/core/artifacts/artifacts.js";
import { JobsProgressMailbox } from "../../../../dist/infrastructure/ray/jobs-progress.js";
import { JobsCredentialVault } from "../../../../dist/infrastructure/ray/jobs-credential-vault.js";
import { JobsSeedUploads } from "../../../../dist/infrastructure/ray/jobs-seed.js";

const root = process.env.EVALUATOR_JOBS_ROOT ?? "/jobs";
const ray = new URL(process.env.EVALUATOR_RAY_DASHBOARD ?? "http://head:8265");
const security = process.env.EVALUATOR_JOBS_SECURITY ?? "/security";
const digest = value => createHash("sha256").update(value).digest();
const token = (await readFile(join(security, "jobs-token"), "utf8")).trim();
if (token.length < 32) throw new Error("Jobs credential must be at least 32 characters");
const credential = digest(`Bearer ${token}`);
await mkdir(root, { recursive: true, mode: 0o700 });
// Node fetch auto-sends Sec-Fetch-* headers, which Ray's dashboard classifies as
// browser traffic and rejects; the plain HTTP client keeps server calls clean.
function rayCall(path, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = rayRequest(
      {
        host: ray.hostname,
        port: ray.port,
        path: `${ray.pathname.replace(/\/$/u, "")}/api/jobs/${path}`,
        method: data === undefined ? "GET" : "POST",
        timeout: 20000,
        headers: {
          "content-type": "application/json",
          ...(data === undefined ? {} : { "content-length": Buffer.byteLength(data) }),
        },
      },
      res => {
        const chunks = [];
        let size = 0;
        res.on("data", chunk => {
          size += chunk.length;
          if (size > 32 * 1024 * 1024) {
            res.destroy(new Error("Ray API response too large"));
            return;
          }
          chunks.push(chunk);
        });
        res.on("error", reject);
        res.on("end", () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            const error = new Error(`Ray Jobs HTTP ${res.statusCode}`);
            error.status = res.statusCode;
            reject(error);
            return;
          }
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          } catch {
            reject(new Error("Invalid Ray API response"));
          }
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("Ray API timeout")));
    req.on("error", reject);
    req.end(data);
  });
}
async function bodyOf(req, limit = 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error("Request too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
const terminal = status => ["SUCCEEDED", "FAILED", "STOPPED"].includes(status);
const submissions = new Map();
const credentials = new JobsCredentialVault();
const seeds = new JobsSeedUploads(join(root, ".seeds"));
const progress = new JobsProgressMailbox();
const progressOrigin = process.env.EVALUATOR_JOBS_PROGRESS_ORIGIN ?? "https://gateway:9443";
async function submit(id, input) {
  const dir = join(root, id);
  const { credentialValues: values, ...metadata } = input;
  const safeInput = { ...metadata, credentialNames: Object.keys(values).sort() };
  const hash = digest(JSON.stringify(safeInput)).toString("hex");
  try {
    await mkdir(dir, { mode: 0o700 });
    await writeFile(join(dir, "input.json"), JSON.stringify(safeInput), { mode: 0o600, flag: "wx" });
    await writeFile(join(dir, "request.sha256"), hash, { mode: 0o600, flag: "wx" });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    if ((await readFile(join(dir, "request.sha256"), "utf8")) !== hash)
      throw new Error("Job ID reused with different input");
    credentials.put(id, "run", values);
    try {
      return await rayCall(id);
    } catch (lookup) {
      if (lookup.status !== 404) throw lookup;
    }
    await accessInput(dir);
  }
  credentials.put(id, "run", values);
  try {
    return await rayCall("", {
      submission_id: id,
      entrypoint: `node /opt/evaluator/dist/application/ray/entries/jobs-entry.mjs ${id}`,
      entrypoint_num_cpus: 0,
      runtime_env: { env_vars: { EVALUATOR_JOBS_ROOT: root, EVALUATOR_JOBS_SECURITY: security,
        EVALUATOR_JOBS_PROGRESS_ORIGIN: progressOrigin,
        ...(process.env.EVALUATOR_PLUGIN_PATCH_PATH ? { EVALUATOR_PLUGIN_PATCH_PATH: process.env.EVALUATOR_PLUGIN_PATCH_PATH } : {}) } },
    });
  } catch (error) {
    // Lost acknowledgements are recovered by identity, never by assigning a new ID.
    try {
      return await rayCall(id);
    } catch {
      throw error;
    }
  }
}
async function accessInput(dir) {
  await stat(join(dir, "input.json"));
}
const server = createServer(
  {
    cert: await readFile(join(security, "cert.pem")),
    key: await readFile(join(security, "key.pem")),
    minVersion: "TLSv1.2",
    requestTimeout: 30000,
  },
  async (req, res) => {
    const reply = (code, value) => {
      res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(value));
    };
    if (!timingSafeEqual(credential, digest(req.headers.authorization ?? ""))) {
      reply(401, { error: "Unauthorized" });
      return;
    }
    try {
      const url = new URL(req.url, "https://gateway");
      const match =
        /^\/jobs\/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})(?:\/(submit|logs|cancel|manifest|file|retry|progress|maintenance|credential|seed))?$/u.exec(
          url.pathname,
        );
      if (!match) {
        reply(404, { error: "Unknown route" });
        return;
      }
      const [, id, action] = match;
      const dir = join(root, id);
      if (action === "seed" && req.method === "POST") {
        reply(200, await seeds.handle(id, await bodyOf(req, 16 * 1024 * 1024)));
        return;
      }
      if (action === "credential" && req.method === "POST") {
        const input = await bodyOf(req);
        if (typeof input.scope !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u.test(input.scope) ||
            input.name !== undefined && typeof input.name !== "string") throw new Error("Invalid credential request");
        if (input.release === true) { credentials.remove(id, input.scope); reply(200, { released: true }); }
        else reply(200, credentials.read(id, input.scope, input.name));
        return;
      }
      if (action === "maintenance" && req.method === "GET") {
        reply(200, JSON.parse(await readFile(join(dir, `${action}.json`), "utf8")));
        return;
      }
      if (action === "progress") {
        // Only an already admitted job may consume bounded gateway memory.
        await stat(dir);
        if (req.method === "POST") { progress.put(id, await bodyOf(req, 2 * 1024 * 1024)); reply(200, { accepted: true }); }
        else if (req.method === "GET") reply(200, progress.get(id));
        else reply(405, { error: "Method not allowed" });
        return;
      }
      if (action === "submit" && req.method === "POST") {
        // Workflow resume evidence is uploaded separately; submissions carry only its verified digest.
        const input = await bodyOf(req, 16 * 1024 * 1024);
        rejectUnknown(input, ["kind", "operation", "maintenance", "plan", "requestedRunId", "resumeRunId", "seedDigest", "retry", "credentialValues"], "Jobs submission");
        if (input.kind !== "workflow") throw new Error("Unsupported job submission format");
        const warmup = input.operation === "maintenance";
        if (input.operation === "maintenance") {
          input.maintenance = parseMaintenanceRequest(input.maintenance);
          if (input.retry !== undefined) throw new Error("Maintenance cannot retry an evaluation");
        } else if (input.maintenance !== undefined) throw new Error("Unexpected maintenance request");
        if ((input.operation !== undefined && !["run", "maintenance"].includes(input.operation)) || !input.plan ||
            (warmup ? input.requestedRunId !== undefined || input.resumeRunId !== undefined || input.seedDigest !== undefined
              : !/^[0-9a-f-]{36}$/u.test(input.requestedRunId ?? "")) ||
            !input.credentialValues || typeof input.credentialValues !== "object" || Array.isArray(input.credentialValues) ||
            Object.values(input.credentialValues).some(value => typeof value !== "string" || !value))
          throw new Error("Invalid workflow submission");
        if (input.resumeRunId !== undefined) {
          if (input.resumeRunId !== input.requestedRunId || typeof input.seedDigest !== "string") throw new Error("Invalid workflow resume identity");
          await seeds.ready(id, input.resumeRunId, input.seedDigest);
        } else if (input.seedDigest !== undefined) throw new Error("Seed requires a resume run ID");
        if (submissions.has(id)) await submissions.get(id);
        const pending = submit(id, input);
        submissions.set(id, pending);
        let result;
        try {
          result = await pending;
        } finally {
          submissions.delete(id);
        }
        reply(200, result);
        return;
      }
      if (action === "retry" && req.method === "GET") {
        const saved = JSON.parse(await readFile(join(dir, "workflow-run.json"), "utf8"));
        if (!/^[0-9a-f-]{36}$/u.test(saved.runId ?? "")) throw new Error("Invalid workflow identity");
        const requestId = url.searchParams.get("requestId");
        const entry = await controlTransaction(join(root, "workflow-runs", saved.runId), async state => state.requests.find(item => item.requestId === requestId));
        if (!entry) throw new Error("Workflow retry request is unavailable");
        reply(200, entry); return;
      }
      if (action === "retry" && req.method === "POST") {
        const input = await bodyOf(req);
        rejectUnknown(input, ["kind", "runId", "requestId", "taskIds", "reason", "fingerprint"], "Workflow retry");
        if (input.kind !== "workflow") throw new Error("Unsupported retry format");
        if (!/^[0-9a-f-]{36}$/u.test(input.runId ?? "") || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u.test(input.requestId ?? "") ||
            !Array.isArray(input.taskIds) || input.taskIds.some(value => typeof value !== "string") || typeof input.reason !== "string") throw new Error("Invalid workflow retry");
        const saved = JSON.parse(await readFile(join(dir, "workflow-run.json"), "utf8"));
        const runRoot = join(root, "workflow-runs", input.runId);
        const plan = JSON.parse(await readFile(join(runRoot, "plan.json"), "utf8"));
        if (saved.runId !== input.runId || plan.fingerprint !== input.fingerprint) throw new Error("Workflow identity changed");
        const current = await rayCall(id);
        if (!terminal(current.status)) {
          const submitted = await submitRetry(runRoot, { requestId: input.requestId, taskIds: input.taskIds, reason: input.reason }, { requireActive: true });
          const record = JSON.parse(await readFile(join(runRoot, "run.json"), "utf8"));
          reply(200, { active: true, request: submitted.request, record }); return;
        }
        const request = await controlTransaction(runRoot, async state => state.requests.find(item => item.requestId === input.requestId));
        if (request && JSON.stringify(request.taskIds) !== JSON.stringify([...new Set(input.taskIds)].sort())) throw new Error("Retry ID reused with another selection");
        reply(200, { active: false, ...(request ? { request } : {}) }); return;
      }
      if (action === "cancel" && req.method === "POST") {
        const status = await rayCall(id);
        if (!terminal(status.status)) {
          try {
            await writeFile(join(dir, "cancel"), "cancel", { mode: 0o600, flag: "wx" });
          } catch (error) {
            if (error.code !== "EEXIST") throw error;
          }
        }
        reply(200, { id, cancellationRequested: !terminal(status.status) });
        return;
      }
      if (req.method !== "GET") {
        reply(405, { error: "Method not allowed" });
        return;
      }
      if (!action || action === "logs") {
        reply(200, await rayCall(action ? `${id}/logs` : id));
        return;
      }
      if (!terminal((await rayCall(id)).status)) throw new Error("Download requires a terminal job");
      const workflowRun = JSON.parse(await readFile(join(dir, "workflow-run.json"), "utf8"));
      if (!/^[0-9a-f-]{36}$/u.test(workflowRun.runId ?? "")) throw new Error("Invalid saved workflow identity");
      const runRoot = join(root, "workflow-runs", workflowRun.runId);
      if (!(await stat(runRoot)).isDirectory()) throw new Error("Saved run is not a directory");
      try { await stat(join(runRoot, ".workflow.lock")); throw new Error("Workflow is still being written"); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      if (action === "manifest") {
        reply(200, { runId: workflowRun.runId, ...(await buildFileManifest(runRoot, [])) });
        return;
      }
      if (action === "file") {
        const file = await checkedPath(runRoot, url.searchParams.get("path") ?? "");
        const offset = Number(url.searchParams.get("offset") ?? 0);
        if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Invalid offset");
        const handle = await open(file, "r");
        try {
          if (!(await handle.stat()).isFile()) throw new Error("Not a file");
          const buffer = Buffer.alloc(1024 * 1024);
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
          reply(200, { data: buffer.subarray(0, bytesRead).toString("base64") });
        } finally {
          await handle.close();
        }
        return;
      }
      reply(404, { error: "Unknown route" });
    } catch (error) {
      if (error.status === 404 || error.code === "ENOENT") reply(404, { error: "Requested job or saved file is unavailable" });
      else reply(409, { error: "Operation not completed; inspect job status. Do not resubmit blindly." });
    }
  },
);
// Durable cancellation markers survive gateway restart. Allow normal evidence collection first.
let sweeping = false;
setInterval(async () => {
  progress.prune();
  credentials.prune();
  if (sweeping) return;
  sweeping = true;
  try {
    for (const id of await readdir(root)) {
      if (!/^[0-9a-f-]{36}$/u.test(id)) continue;
      try {
        const status = await rayCall(id);
        if (terminal(status.status)) {
          credentials.remove(id, "run");
          await rm(join(root, id, "input.json"), { force: true });
          continue;
        }
        credentials.keepAlive(id, "run");
        const handle = await open(join(root, id, "cancel"), "r");
        const stat = await handle.stat();
        await handle.close();
        if (Date.now() - stat.mtimeMs > 180000) await rayCall(`${id}/stop`, {});
      } catch (error) {
        // Expire staged credentials that never became a Ray job after an interrupted submit.
        if (error.status === 404) {
          try {
            const path = join(root, id, "input.json");
            if (Date.now() - (await stat(path)).mtimeMs > 86400000) await rm(path);
          } catch {
            /* Already cleaned. */
          }
        }
      }
    }
  } catch {
    console.error("Jobs housekeeping failed; retrying on the next interval");
  } finally {
    sweeping = false;
  }
}, 5000).unref();
server.listen(Number(process.env.EVALUATOR_JOBS_PORT ?? 9443), "0.0.0.0", () =>
  console.log(`Jobs gateway listening on HTTPS :${server.address().port}`),
);
