import { credentialSecrets } from "../../core/errors/diagnostics.js";
import { ProgressPublisher } from "../../core/progress/progress-wire.js";
import { safeProgress } from "../../core/progress/live-progress.js";
import type { WorkflowEvent } from "../../core/contracts/workflow.js";
import { workflowCredentialNames } from "../../core/workflow/credentials.js";
import { readFile, mkdir, writeFile, access } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseCompiledWorkflowDocument } from "../../config/workflow-schema.js";
import type { WorkflowUnitRequest } from "../../core/contracts/workflow.js";
import { compileWorkflow } from "../../core/workflow/compile.js";
import { executeWorkflowUnit, recoverWorkflowUnit } from "../../core/workflow/execute.js";
import { parseWorkflowRun, parseWorkflowUnitRecord } from "../../core/workflow/record.js";
import { workflowObject } from "../../core/workflow/values.js";
import { expectNonEmptyString, expectRecord } from "../../core/validation/input.js";
import { parseNodeConfig, type NodeConfig } from "../../infrastructure/ray/node-config.js";
import { parseWorkflowRemoteJob } from "../../infrastructure/ray/workflow-protocol.js";
import { workflowTransferClient } from "../../infrastructure/ray/workflow-transfer.js";
import { TransferClient } from "../../infrastructure/transfer/client.js";
import { loadPackageDigest } from "../../infrastructure/provenance/package.js";
import { acquireRuntimeLock } from "../../infrastructure/runtime-installation/lock.js";
import { LocalWorkflowStore } from "../../plugins/stores/workflow-local.js";
import { openPluginRegistry, type PluginRegistry } from "../plugins/open-registry.js";

async function assignment(value: unknown, registry: PluginRegistry): Promise<WorkflowUnitRequest> {
  const raw = expectRecord(value, "workflow assignment"), saved = expectRecord(raw.plan, "workflow plan");
  await registry.loadRecordedPlugins(saved.sources);
  const sources = { ...registry.pluginVersions };
  for (const key of Object.keys(expectRecord(saved.sources, "workflow sources"))) if (key.startsWith("template:"))
    sources[key] = registry.ctx.evaluator.workflows.template(key.slice(9)).version;
  const plan = compileWorkflow(parseCompiledWorkflowDocument(saved.document), registry.ctx.evaluator.workflows, sources);
  if (plan.fingerprint !== saved.fingerprint) throw new TypeError("Workflow source or plugin version changed on the worker");
  return { dispatchFingerprint: expectNonEmptyString(raw.dispatchFingerprint, "dispatch fingerprint"), ...(raw.nodeId === undefined ? {} : { nodeId: expectNonEmptyString(raw.nodeId, "prepared node ID") }), plan, runId: expectNonEmptyString(raw.runId, "run ID"), blockPath: expectNonEmptyString(raw.blockPath, "block path"),
    path: expectNonEmptyString(raw.path, "execution path"), bindings: workflowObject(raw.bindings), unit: parseWorkflowUnitRecord(raw.unit) };
}

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

export async function executeWorkflowNode(value: unknown, node: NodeConfig, token: string, registry: PluginRegistry) {
  const envelope = expectRecord(value, "workflow Ray envelope");
  const job = parseWorkflowRemoteJob(envelope.remote);
  const nodeId = expectNonEmptyString(envelope.nodeId, "worker node ID"), hostname = expectNonEmptyString(envelope.hostname, "worker hostname");
  if (job.nodeId !== nodeId) throw new TypeError("Workflow worker placement changed");
  const directory = join(node.outputRoot, "workflow", job.job.runId, job.job.attemptId);
  await mkdir(directory, { recursive: true });
  const transportSignal = AbortSignal.timeout((job.safeConfig.timeoutSeconds + 300) * 1000);
  const release = await acquireRuntimeLock(join(directory, ".worker.lock"), transportSignal);
  const controller = new AbortController();
  const terminate = () => controller.abort(new Error("Workflow worker interrupted"));
  process.on("SIGINT", terminate); process.on("SIGTERM", terminate);
  const client = workflowTransferClient(new TransferClient({ endpoint: job.uploadEndpoint, token,
    ca: await readFile(node.caFile), timeoutMs: 5000, retries: 1 }), job.job.attemptId, nodeId, transportSignal);
  let polling = false;
  const heartbeat = setInterval(() => {
    if (polling) return;
    polling = true;
    void client.call({ op: "heartbeat" }).then(value => {
      if (workflowObject(value).cancelled) controller.abort(new Error("Coordinator cancelled this unit"));
    }).catch(() => controller.abort(new Error("Coordinator heartbeat lost"))).finally(() => { polling = false; });
  }, 1000);
  heartbeat.unref();
  let progress: ProgressPublisher | undefined;
  let pendingEvents = 0, sending = Promise.resolve();
  const eventTransport = new AbortController();
  try {
    const local = new LocalWorkflowStore(directory);
    const tombstone = join(directory, "recovered.json"), requestFile = join(directory, "request.json");
    if (job.action === "recover" && !await exists(requestFile)) {
      // The lock and tombstone also prevent a delayed original dispatch from allocating later.
      await writeFile(tombstone, "{}\n");
      return { completed: true, nodeId, hostname };
    }
    const response = job.action === "execute" ? expectRecord(await client.call({ op: "assignment" }), "workflow runtime") :
      expectRecord(JSON.parse(await readFile(requestFile, "utf8")), "saved workflow runtime");
    if (response.packageDigest !== await loadPackageDigest()) throw new Error("Workflow worker package digest mismatch");
    const request = await assignment(response.request, registry);
    if (job.action === "execute" && request.nodeId !== undefined && request.nodeId !== nodeId) throw new TypeError("Prepared workflow node differs from dispatch");
    if (request.runId !== job.job.runId || request.unit.attemptId !== job.job.attemptId || request.unit.caseId !== job.job.taskId)
      throw new TypeError("Workflow assignment differs from Ray routing identity");
    const credentials = { ...process.env };
    const allowedCredentials = workflowCredentialNames(request, registry.ctx.evaluator.workflows);
    const secrets = Object.entries(credentials).flatMap(([key, value]) => /KEY|TOKEN|PASSWORD|SECRET/i.test(key) && value ? [value] : []);
    const pendingCredentials = new Map<string, Promise<string | undefined>>();
    const credential = (name: string): Promise<string | undefined> => {
      if (!allowedCredentials.includes(name)) return Promise.reject(new TypeError("Workflow resource requested an undeclared credential"));
      const cached = pendingCredentials.get(name);
      if (cached) return cached;
      const pending = (async () => {
        const value = credentials[name] || workflowObject(await client.call({ op: "credential", name })).value;
        if (value !== null && value !== undefined && typeof value !== "string") throw new TypeError("Invalid workflow credential response");
        if (value) secrets.push(...credentialSecrets(value));
        return value ?? undefined;
      })();
      pendingCredentials.set(name, pending);
      return pending;
    };
    if (job.action === "execute") progress = new ProgressPublisher((snapshot, signal) => client.call({ op: "progress", snapshot }, signal), secrets);
    const onEvent = (event: WorkflowEvent) => {
      if (job.action !== "execute") return;
      const value = safeProgress(event.progress ?? { phase: "workflow", message: `${event.path}: ${event.message}` }, secrets);
      progress?.observe(value);
      if (value.transient || pendingEvents >= 128) return;
      pendingEvents++;
      sending = sending.then(async () => {
        await client.call({ op: "event", event: value }, AbortSignal.any([eventTransport.signal, AbortSignal.timeout(2000)]));
      }).catch(() => {}).finally(() => { pendingEvents--; });
    };
    const options = { signal: AbortSignal.any([controller.signal, transportSignal]), workerId: `${nodeId}:${process.pid}`,
      secrets, onEvent,
      runtime: { directory, resolvePath: (path: string) => resolve(node.configDirectory, path), credential },
      store: { async save(record: Parameters<LocalWorkflowStore["save"]>[0]) {
        await local.save(record);
        if (job.action === "execute") await client.store.save(record);
      }, artifacts: client.store.artifacts },
    };
    if (job.action === "recover") {
      if (await exists(join(directory, "run.json"))) {
        const previous = parseWorkflowRun(JSON.parse(await readFile(join(directory, "run.json"), "utf8")));
        const recovered = await recoverWorkflowUnit(request, previous, registry.ctx.evaluator.workflows, options);
        if (recovered.resources.some(resource => resource.state !== "released")) throw new Error("Workflow worker cleanup remains unconfirmed");
      }
      await writeFile(tombstone, "{}\n");
      return { completed: true, nodeId, hostname };
    }
    if (await exists(tombstone)) throw new Error("Workflow attempt was already recovered; use a fresh attempt ID");
    await writeFile(requestFile, JSON.stringify(response), { flag: "wx", mode: 0o600 });
    await executeWorkflowUnit(request, registry.ctx.evaluator.workflows, options);
    return { completed: true, nodeId, hostname };
  } finally {
    await progress?.close();
    const flushDeadline = setTimeout(() => eventTransport.abort(), 2000);
    try { await sending; } finally { clearTimeout(flushDeadline); eventTransport.abort(); }
    clearInterval(heartbeat);
    process.off("SIGINT", terminate); process.off("SIGTERM", terminate);
    await release();
  }
}

export async function startWorkflowWorker(): Promise<void> {
  const configFile = process.env.EVALUATOR_NODE_CONFIG;
  if (!configFile) throw new Error("EVALUATOR_NODE_CONFIG is required");
  const node = parseNodeConfig(JSON.parse(await readFile(configFile, "utf8")), dirname(configFile));
  const token = process.env[node.tokenEnv];
  if (!token) throw new Error("Workflow transfer token is unavailable");
  delete process.env[node.tokenEnv];
  let content = "";
  for await (const chunk of process.stdin) {
    content += String(chunk);
    if (Buffer.byteLength(content) > 2 * 1024 * 1024) throw new Error("Workflow routing envelope exceeds protocol limit");
  }
  console.log = console.info = console.warn = console.error = () => {};
  const registry = await openPluginRegistry(node.pluginPatchPath);
  try { process.stdout.write(JSON.stringify(await executeWorkflowNode(JSON.parse(content), node, token, registry)) + "\n"); }
  finally { await registry.dispose(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  void startWorkflowWorker().catch(() => { process.stdout.write('{"errorCode":"INTERNAL_ERROR"}\n'); process.exitCode = 1; });
