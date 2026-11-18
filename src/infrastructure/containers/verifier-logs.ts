import { randomUUID } from "node:crypto";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { AttemptKey } from "../../core/contracts/result.js";
import { stopDockerContainer } from "./cleanup.js";
import { EVALUATOR_NODE_EXECUTABLE, PROCESS_HELPER, type DockerCommand } from "./runtime-contract.js";

export type VerifierLogStorage = { storage: "container"; reason: string };
type LogKind = "agent" | "verifier";

/** Explicit worker-local I/O policy; persisted benchmark config remains unchanged. */
export function parseVerifierLogStorage(storage: unknown, reason: unknown): VerifierLogStorage | undefined {
  if (storage === undefined || storage === "bind") return undefined;
  if (storage !== "container" || typeof reason !== "string" || !reason.trim() || /[\u0000-\u001f]/u.test(reason))
    throw new TypeError("Container verifier logs require storage=container and a non-empty audit reason");
  return { storage, reason: reason.trim() };
}

export async function prepareContainerVerifierLogs(command: DockerCommand, id: string, signal: AbortSignal, kind: LogKind = "verifier"): Promise<void> {
  const script = "const f=require('node:fs/promises'),c=require('node:fs').constants;" +
    `(async()=>{await f.mkdir('/logs/${kind}',{recursive:true});const h=await f.open('/logs/${kind}',c.O_RDONLY|c.O_DIRECTORY|c.O_NOFOLLOW);` +
    "try{await h.chmod(0o777)}finally{await h.close()}})().catch(e=>{console.error(e);process.exit(1)});";
  await command(["exec", "--user", "0:0", id, EVALUATOR_NODE_EXECUTABLE, "-e", script], { signal });
}

async function regularTree(path: string): Promise<void> {
  const stat = await lstat(path);
  if (stat.isSymbolicLink() || !stat.isDirectory() && !stat.isFile()) throw new Error("Unsafe verifier log export entry");
  if (stat.isDirectory()) for (const name of await readdir(path)) await regularTree(join(path, name));
}

async function mergeAgentLogs(source: string, target: string): Promise<void> {
  for (const name of await readdir(source)) {
    const from = join(source, name), to = join(target, name), info = await lstat(from);
    if (info.isDirectory()) { await mkdir(to, { recursive: true }); await mergeAgentLogs(from, to); }
    else {
      const existing = await readFile(to).catch(error => { if (error.code === "ENOENT") return null; throw error; });
      if (existing !== null) {
        if (!existing.equals(await readFile(from))) throw new Error("Container agent logs conflict with saved host evidence");
      } else await cp(from, to, { force: false, errorOnExist: true });
    }
  }
}

/** Snapshot after writers stop; callers must retain the container if this fails. */
export async function exportContainerVerifierLogs(command: DockerCommand, id: string, target: string, signal: AbortSignal, kind: LogKind = "verifier"): Promise<void> {
  const staging = await mkdtemp(join(tmpdir(), "evaluator-verifier-logs-")), token = randomUUID();
  let attempted = false;
  let failure: unknown;
  try {
    signal.throwIfAborted();
    await mkdir(target, { recursive: true });
    await regularTree(target);
    attempted = true;
    await command(["exec", "--user", "0:0", id, EVALUATOR_NODE_EXECUTABLE, PROCESS_HELPER,
      "snapshot", token, `/logs/${kind}`, `/logs/${kind}`], { signal });
    const payload = join(staging, "payload");
    await command(["cp", `${id}:/opt/evaluator/downloads/${token}/payload`, payload], { signal });
    await regularTree(payload);
    signal.throwIfAborted();
    if (kind === "agent") await mergeAgentLogs(payload, target);
    else await cp(payload, target, { recursive: true, dereference: false, force: true });
    signal.throwIfAborted();
  } catch (error) { failure = error; }
  const cleanup: unknown[] = [];
  if (attempted) try {
    await command(["exec", "--user", "0:0", id, EVALUATOR_NODE_EXECUTABLE, PROCESS_HELPER,
      "remove-snapshot", token], { signal: AbortSignal.timeout(5_000) });
  } catch (error) { cleanup.push(error); }
  try { await rm(staging, { recursive: true, force: true }); } catch (error) { cleanup.push(error); }
  if (cleanup.length) throw new AggregateError(failure === undefined ? cleanup : [failure, ...cleanup], "Verifier log snapshot cleanup failed");
  if (failure !== undefined) throw failure;
}

/** Recovery never rewrites results; agent evidence merges without overwriting saved bytes. */
export async function recoverContainerVerifierLogs(command: DockerCommand, id: string, target: string, key: AttemptKey, signal: AbortSignal, kind: LogKind = "verifier"): Promise<void> {
  const path = resolve(target), attempt = dirname(path);
  if (basename(path) !== kind || basename(attempt) !== key.attemptId || await realpath(path) !== path)
    throw new Error("Invalid container verifier log recovery path");
  const allocation = JSON.parse(await readFile(join(attempt, "allocation.json"), "utf8")) as { key?: Partial<AttemptKey> };
  if (!allocation.key || allocation.key.runId !== key.runId || allocation.key.taskId !== key.taskId || allocation.key.attemptId !== key.attemptId)
    throw new Error("Container verifier log recovery allocation differs");
  const committed = await lstat(join(attempt, "result.json")).catch(error => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (committed && kind === "verifier") return;
  const inspected = JSON.parse((await command(["inspect", id], { signal })).stdout) as { State?: { Status?: string; StartedAt?: string } }[];
  // Preparation may stop after create, before the private directory is initialized.
  // Do not start that task entrypoint just to export logs it could not have written.
  if (inspected[0]?.State?.Status === "created" && inspected[0].State.StartedAt === "0001-01-01T00:00:00Z") return;
  await stopDockerContainer(command, id, signal);
  await command(["start", id], { signal });
  await exportContainerVerifierLogs(command, id, path, signal, kind);
}
