import assert from "node:assert/strict";
import { access, mkdir, readFile, writeFile, rm, readdir } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join, resolve, dirname, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { request } from "node:https";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import * as api from "arsi-evaluator";
import { openPluginRegistry } from "./dist/application/plugins/open-registry.js";
import { verifyPackageDirectory } from "./dist/infrastructure/provenance/package.js";
import { createPiRuntimeInstallation } from "./dist/runtimes/pi/package-runtime.js";
import { piAgentBundleRuntimeInstallation } from "./dist/runtimes/pi/agentbundle-runtime.js";

import { WorkflowTransferSession } from "./dist/infrastructure/ray/workflow-transfer.js";
import { workflowDigest } from "./dist/core/workflow/values.js";
import { workflowDispatchFingerprint } from "./dist/core/workflow/unit-request.js";
import { LocalWorkflowStore } from "./dist/plugins/stores/workflow-local.js";
import { readPreparedTask } from "./dist/infrastructure/ray/preparation-receipt.js";

const root = process.cwd(), checks = [], skipped = [];
function record(message) { checks.push(message); console.log(message); }
const dir = join(root, ".validation");
await mkdir(dir, { recursive: true });
for (const name of ["src", "scripts"]) await assert.rejects(access(join(root, name)), { code: "ENOENT" });
const distributedFiles = await readdir(join(root, "dist"), { recursive: true });
assert.deepEqual(distributedFiles.filter(file => /(?:^|[\\/])__pycache__(?:[\\/]|$)|\.py[co]$/u.test(file)), []);
const packageFiles = (await readdir(root, { withFileTypes: true }))
  .filter(entry => entry.isFile() && entry.name !== "check-distribution.mjs");
for (const directory of ["dist", "playbook"]) {
  const files = await readdir(join(root, directory), { recursive: true, withFileTypes: true });
  packageFiles.push(...files.filter(entry => entry.isFile()));
}
const archiveUrl = /https:\/\/(?:www\.)?modelscope\.cn\/datasets\/evolving-foundry\/ember-evaluator(?=[/\s)"']|$)/gu;
const hasObsoleteName = text => /(?<![A-Za-z0-9])ember(?![A-Za-z0-9])/iu.test(text) || /\b[Ee]mber[A-Z]/u.test(text);
for (const { parentPath, name } of packageFiles) {
  const file = join(parentPath, name);
  const packagePath = relative(root, file);
  const contents = await readFile(file, "utf8");
  assert.ok(!hasObsoleteName(packagePath), `Obsolete evaluator name in file path ${packagePath}`);
  assert.ok(!hasObsoleteName(contents.replaceAll(archiveUrl, "")), `Obsolete evaluator name in ${packagePath}`);
}
record("installed files use ARSI-Evaluator except for the ModelScope archive URL");
const paths = ["index.js", "index.d.ts", "cli.js", "cli-runtime.js", "adapters/ray/node-worker.js",
  "application/ray/workflow-worker.js", "application/ray/entries/jobs-entry.mjs", "application/ray/workflow-job.js",
  "adapters/ray/jobs-entry.js", "adapters/ray/jobs-gateway.js",
  "adapters/ray/python/requirements.txt", "adapters/harness/pi/runner.js",
  "adapters/harness/pi/runtime-package.json", "adapters/harness/pi/runtime-lock.json",
  "adapters/harness/agentx/assets/ascend_metrics.py"];
for (const path of paths) await access(join(root, "dist", path));
const digest = await verifyPackageDirectory(join(root, "dist"));
const legacyPi = join(root, "dist/adapters/harness/pi");
for (const name of await readdir(legacyPi)) {
  if (!name.endsWith(".js")) continue;
  const file = join(legacyPi, name), content = await readFile(file, "utf8");
  for (const match of content.matchAll(/(?:from\s+|import\s*\()(["'])(\.[^"']+)\1/g))
    await access(resolve(dirname(file), match[2]));
  for (const match of content.matchAll(/new URL\(\s*["'](\.[^"']*)["']\s*,\s*import.meta.url\s*\)/g))
    await access(new URL(match[1], pathToFileURL(file)));
}
record("declared assets and complete distribution digest");
const piInstallation = await createPiRuntimeInstallation(new AbortController().signal);
for (const file of piInstallation.files) await access(file.source);
// Preparation must keep its coordinator resource paths, independently of the
// runner dependency copies used in standalone installations.
const bundleInstallation = await piAgentBundleRuntimeInstallation(new AbortController().signal,
  { root: dir, pythonPackages: [], pythonRequiredModules: [] }, "fixture-artifact", "fixture-configuration");
const agentBundleEntry = bundleInstallation.files.find(file => file.target === "agentbundle/run.mjs");
assert.ok(agentBundleEntry);
await access(agentBundleEntry.source);
record("installed Pi and AgentBundle preparation resolve coordinator resources");

function launch(file, args = [], env = {}, executable = process.execPath) {
  const child = spawn(executable, [file, ...args], { cwd: root, env: { ...process.env, ...env }, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", data => { stdout += data; });
  child.stderr.on("data", data => { stderr += data; });
  const done = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error(`Process timeout: ${file}\n${stderr}`)); }, 30_000);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("exit", code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
  return { child, done, output: () => stdout + stderr };
}
async function run(file, args = [], input = "", env = {}, executable) {
  const process = launch(file, args, env, executable);
  process.child.stdin.end(input);
  return process.done;
}
const { name, bin } = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
assert.equal(name, "arsi-evaluator");
assert.deepEqual(bin, { "arsi-evaluator": "./dist/cli.js" });
for (const [runtime, lockFile] of [["claudecode", "package-lock.json"], ["codebuddy", "package-lock.json"],
  ["codex", "package-lock.json"], ["dsh", "runtime-lock.json"]]) {
  const assets = join(root, "dist", "runtimes", runtime, "assets");
  const runtimePackage = JSON.parse(await readFile(join(assets, "package.json"), "utf8"));
  const runtimeLock = JSON.parse(await readFile(join(assets, lockFile), "utf8"));
  assert.equal(runtimePackage.name, `arsi-evaluator-${runtime}-runtime`);
  assert.equal(runtimeLock.name, runtimePackage.name);
  assert.equal(runtimeLock.packages[""].name, runtimePackage.name);
}
const help = await run(bin[name], ["--help"]);
assert.equal(help.code, 0, help.stderr);
assert.match(help.stdout, /^Usage: arsi-evaluator\b/m);
record("installed CLI name, help and exit code");
const pi = await run("dist/adapters/harness/pi/runner.js", [], "{}\n");
assert.equal(pi.code, 1, pi.stderr);
assert.equal(JSON.parse(pi.stdout.trim().split("\n").at(-1)).type, "error");
record("standalone Pi entry rejects invalid protocol input");
const model = createServer(async (req, res) => {
  let body = ""; for await (const data of req) body += data;
  const input = JSON.parse(body);
  res.writeHead(200, { "content-type": "text/event-stream" });
  const chunk = { id: "controlled", object: "chat.completion.chunk", created: 1, model: input.model };
  for (const choice of [{ delta: { role: "assistant", content: "controlled answer" }, finish_reason: null }, { delta: {}, finish_reason: "stop" }])
    res.write(`data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, ...choice }] })}\n\n`);
  res.end("data: [DONE]\n\n");
});
await new Promise(done => model.listen(0, "127.0.0.1", done));
try {
  const workdir = join(dir, "pi-work"), outputDir = join(dir, `pi-output-${randomUUID()}`);
  await mkdir(workdir, { recursive: true }); await mkdir(outputDir, { recursive: true });
  const input = { schemaVersion: 1, key: { runId: "run", taskId: "task", attemptId: "attempt" }, input: { id: "task", prompt: "Return the controlled answer." },
    model: { name: "fixture", endpoint: `http://127.0.0.1:${model.address().port}/v1`, provider: "openai", api: "openai-completions" },
    auth: { value: "controlled-key", reference: null }, workdir, outputDir };
  const completed = await run("dist/adapters/harness/pi/runner.js", [], JSON.stringify(input) + "\n");
  assert.equal(completed.code, 0, completed.stderr + completed.stdout);
  const reply = completed.stdout.trim().split("\n").map(line => JSON.parse(line)).find(event => event.type === "result");
  assert.equal(reply.result.finalText, "controlled answer");
  await access(join(outputDir, "trajectory.jsonl"));
  record("standalone Pi runner completes a controlled model request and saves its trajectory");
} finally { model.closeAllConnections(); await new Promise(done => model.close(done)); }

const network = join(dir, "network.yaml");
await writeFile(network, "{}\n");
const fixture = join(dir, "plugin.mjs"), patch = join(dir, "patch.yaml");
await writeFile(patch, JSON.stringify([{ insert: [{ id: "distribution-fixture", name: "./plugin.mjs" }] }]));
const config = join(dir, "experiment.yaml");
await writeFile(config, JSON.stringify({ schemaVersion: 2, workflow: "benchmark.evaluate", output: { directory: "./results" }, with: {
  services: { default: { model: "fixture", base_url: "https://fixture.invalid", apiKeyEnv: "DISTRIBUTION_MODEL_KEY" } },
  benchmark: { name: "cli-fixture", solver: { name: "cli-fixture" } }, environment: "local" } }));
const result = await new api.Evaluator().run({ configPath: config, patchPath: patch, networkConfigPath: network,
  env: { DISTRIBUTION_MODEL_KEY: "controlled-model-key" } });
assert.equal(result.exitCode, 0);
await new api.Evaluator().report(result.runDirectory);
record("package-name SDK, patch, evaluation and offline report");

// Jobs inputs must be consumed even when validation fails; mere module loading cannot pass.
const jobsRoot = join(dir, "jobs"), security = join(dir, "security"), jobId = randomUUID();
await mkdir(join(jobsRoot, jobId), { recursive: true });
await mkdir(security, { recursive: true });
await writeFile(join(jobsRoot, jobId, "input.json"), JSON.stringify({ operation: "invalid-operation" }));
const jobsEnv = { EVALUATOR_JOBS_ROOT: jobsRoot, EVALUATOR_JOBS_SECURITY: security, EVALUATOR_NETWORK_CONFIG: network };
const job = await run("dist/adapters/ray/jobs-entry.js", [jobId], "", jobsEnv);
assert.equal(job.code, 1); assert.match(job.stderr, /Unsupported job submission format/);
await assert.rejects(access(join(jobsRoot, jobId, "input.json")), { code: "ENOENT" });
record("Jobs consumes rejected input without creating an authentication file");

const openssl = process.env.OPENSSL_BIN ?? "openssl";
if (spawnSync(openssl, ["version"], { windowsHide: true }).status !== 0) {
  skipped.push("worker HTTPS transfer and Jobs gateway: OpenSSL unavailable");
} else {
  const opensslConfig = join(security, "openssl.cnf");
  await writeFile(opensslConfig, "[req]\ndistinguished_name = dn\n[dn]\n");
  const certificate = spawnSync(openssl, ["req", "-config", opensslConfig, "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-keyout", join(security, "key.pem"), "-out", join(security, "cert.pem"), "-subj", "/CN=localhost", "-addext", "subjectAltName=IP:127.0.0.1", "-addext", "basicConstraints=critical,CA:TRUE"], { windowsHide: true });
  assert.equal(certificate.status, 0, certificate.stderr.toString());
  const token = randomUUID() + randomUUID(), cert = await readFile(join(security, "cert.pem"));
  let transfer;
  const collector = await api.startTransferReceiver({ token, cert, key: await readFile(join(security, "key.pem")),
    control: async (route, input) => input.op ? transfer.handle(input) : route === "runtime"
      ? { services: { default: { model: { name: "fixture", endpoint: "https://fixture.invalid", api: "openai-completions", provider: null }, auth: { value: "controlled-model-key", reference: null } } } }
      : { cancelled: false } });
  const registry = await openPluginRegistry(patch);
  try {
    const nodePath = join(dir, "node.json");
    await writeFile(nodePath, JSON.stringify({ nodeExecutable: process.execPath, workerEntry: resolve("dist/adapters/ray/node-worker.js"), configDirectory: dir,
      outputRoot: join(dir, "worker"), caFile: join(security, "cert.pem"), pluginPatchPath: patch, tokenEnv: "DISTRIBUTION_TRANSFER_TOKEN" }));
    const workerEnv = { EVALUATOR_NODE_CONFIG: nodePath, DISTRIBUTION_TRANSFER_TOKEN: token };
    const remote = { schemaVersion: 1, job: { runId: randomUUID(), taskId: "task", attemptId: randomUUID(), ref: { id: "task", recordKey: 0 }, configFingerprint: "a".repeat(64) },
      source: { source: "cli-fixture", revision: "fixed", files: [], metadata: {} },
      safeConfig: { benchmark: { name: "cli-fixture", config: {} }, environment: { name: "local", config: {} }, solver: { name: "cli-fixture", service: "default", config: {} }, timeoutSeconds: 20 },
      pluginVersions: registry.pluginVersions, packageDigest: digest, uploadEndpoint: collector.url, previousAttempts: [] };
    const plan = api.compileWorkflow(api.parseWorkflowDocument({ schemaVersion: 2, pathBase: dir,
      workflow: { steps: [{ id: "samples", forEach: { items: { value: [{ id: "task" }] }, mode: "units" },
        steps: [{ id: "evidence", use: "artifact.text", inputs: { text: { value: "controlled worker evidence" } } }],
        outputs: { artifact: { ref: "evidence.outputs.artifact" } } }] } }), registry.ctx.evaluator.workflows, registry.pluginVersions);
    const identity = { caseId: "task", variantId: "default", repetition: 0 }, identityDigest = workflowDigest(identity);
    const item = { id: "task" }, variant = { id: "default" };
    const assignment = { plan, runId: randomUUID(), blockPath: "workflow.samples", path: `workflow.samples[${identityDigest.slice(0, 16)}]`,
      bindings: { item, variant, repetition: 0 }, unit: { ...identity, key: `workflow.samples:${identityDigest}`, attemptId: randomUUID(), ordinal: 1,
        inputFingerprint: workflowDigest({ item, variant, repetition: 0, bindings: {} }), status: "running", cleanupStatus: "cleaned", outputs: {}, errors: [] } };
    assignment.dispatchFingerprint = workflowDispatchFingerprint(assignment);
    const storage = new LocalWorkflowStore(join(dir, "workflow-received"));
    transfer = new WorkflowTransferSession(assignment, "controlled-node", digest, storage, new AbortController().signal);
    const workflowJob = { schemaVersion: 3, kind: "workflow", action: "execute", nodeId: "controlled-node", uploadEndpoint: collector.url,
      job: { runId: assignment.runId, taskId: "task", attemptId: assignment.unit.attemptId }, safeConfig: { timeoutSeconds: 20 } };
    const worker = await run("dist/application/ray/workflow-worker.js", [], JSON.stringify({ remote: workflowJob, nodeId: "controlled-node", hostname: "controlled-host" }), workerEnv);
    assert.equal(worker.code, 0, worker.stderr + worker.stdout);
    assert.equal(JSON.parse(worker.stdout).completed, true);
    assert.equal(transfer.lastSnapshot.status, "completed");
    assert.equal(transfer.lastSnapshot.artifacts.length, 1);
    const artifact = transfer.lastSnapshot.artifacts[0];
    assert.equal(Buffer.from(await storage.artifacts(artifact.producer).read(artifact)).toString(), "controlled worker evidence");
    record("workflow worker executes an assigned sample and uploads verified evidence over HTTPS");
    const batch = { ...remote, schemaVersion: 2, job: { ...remote.job, runId: randomUUID(), attemptId: randomUUID() },
      preparation: { mode: "prepare", roundId: randomUUID(), nodeId: "controlled-node", deadlineAt: null, digest: null,
        concurrency: 1, defaultTimeoutSeconds: 30, environmentTimeoutSeconds: null } };
    const workerInput = job => JSON.stringify({ remote: job, nodeId: "controlled-node", hostname: "controlled-host" });
    const ready = await run("dist/adapters/ray/node-worker.js", [], workerInput(batch), workerEnv);
    assert.equal(ready.code, 0, ready.stderr + ready.stdout);
    const { preparationDigest } = JSON.parse(ready.stdout);
    assert.match(preparationDigest, /^[a-f0-9]{64}$/u);
    const receipt = { ...batch.preparation, mode: "execute", digest: preparationDigest };
    const expected = { packageDigest: digest, configFingerprint: batch.job.configFingerprint, source: batch.source };
    assert.equal((await readPreparedTask(join(dir, "worker"), batch.job, receipt, expected)).input.id, "task");
    await assert.rejects(readPreparedTask(join(dir, "worker"), batch.job, { ...receipt, digest: "0".repeat(64) }, expected));
    record("preparation worker saves a verified receipt and rejects altered evidence");
    const removed = await run("dist/adapters/ray/node-worker.js", [], workerInput(remote), workerEnv);
    assert.equal(removed.code, 1, "Native worker must not execute an evaluation outside a workflow");
    const bad = await run("dist/adapters/ray/node-worker.js", [], workerInput({ ...batch, job: { ...batch.job, attemptId: randomUUID() }, packageDigest: "sha256:" + "0".repeat(64) }), workerEnv);
    assert.equal(bad.code, 1); assert.equal(JSON.parse(bad.stdout).errorCode, "SOURCE_CHANGED");
    record("worker rejects native evaluation dispatch and mismatched package digests");
    const maintenance = { pluginVersions: registry.pluginVersions, packageDigest: digest, environment: { name: "distribution-maintenance", config: {} }, request: { all: true, execute: false } };
    const cleanup = await run("dist/adapters/ray/node-worker.js", ["--image-cleanup"], JSON.stringify(maintenance), workerEnv);
    assert.equal(cleanup.code, 0, cleanup.stderr); assert.equal(JSON.parse(cleanup.stdout).nodeId, "fixture-node");
    await rm(join(dir, "lease-released"), { force: true });
    const lease = launch("dist/adapters/ray/node-worker.js", ["--image-lease"], workerEnv);
    lease.child.stdin.write(JSON.stringify(maintenance) + "\n");
    for (let i = 0; i < 100 && !lease.output().includes("ready"); i++) await delay(50);
    assert.match(lease.output(), /ready/); lease.child.stdin.end();
    assert.equal((await lease.done).code, 0);
    assert.equal(await readFile(join(dir, "lease-released"), "utf8"), "released");
    record("legacy worker image cleanup and lease release");
  } finally { await registry.dispose(); await collector.close(); }
  await writeFile(join(security, "jobs-token"), token);
  const gateway = launch("dist/adapters/ray/jobs-gateway.js", [], { ...jobsEnv, EVALUATOR_JOBS_PORT: "0" });
  try {
    for (let i = 0; i < 100 && !/HTTPS :(\d+)/.test(gateway.output()); i++) await delay(50);
    const port = /HTTPS :(\d+)/.exec(gateway.output())?.[1]; assert.ok(port, gateway.output());
    const status = await new Promise((done, fail) => {
      const req = request({ hostname: "127.0.0.1", port, path: "/unknown", ca: cert }, res => { res.resume(); res.on("end", () => done(res.statusCode)); });
      req.on("error", fail); req.end();
    });
    assert.equal(status, 401);
    record("legacy Jobs gateway listens and enforces authentication");
  } finally { gateway.child.kill(); await gateway.done; }
}

const python = process.env.PYTHON_BIN ?? "python";
if (spawnSync(python, ["--version"], { windowsHide: true }).status !== 0) skipped.push("AgentX Python command: Python unavailable");
else {
  const help = await run("dist/adapters/harness/agentx/assets/ascend_metrics.py", ["--help"], "", {}, python);
  assert.equal(help.code, 0, help.stderr); assert.match(help.stdout, /--device-id/);
  const controlled = await run(join(dir, "telemetry.py"), [resolve("dist/adapters/harness/agentx/assets/ascend_metrics.py")], "", {}, python);
  assert.equal(controlled.code, 0, controlled.stderr); assert.match(controlled.stdout, /ascend_npu_utilization_percent/);
  record("AgentX legacy Python CLI, controlled sampler HTTP output and orderly shutdown");
}
const report = { checks, skipped };
await writeFile(join(dir, "verification.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));
