import { parseNetworkProbePlan } from "../../infrastructure/network/probe-plan.js";
import { resolveConfigurationCredentials } from "../../core/validation/credential.js";
import { nativeResourceTransport } from "../../plugins/workflows/benchmark/component-resource.js";
import { networkCredentialNames, restoreNetworkTemplate, validateNetworkSnapshot } from "../../config/network-schema.js";
import { parseRuntimeServices } from "../../infrastructure/ray/runtime-services.js";
import { readFile, mkdir, writeFile, rename } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { createPreparationComponents } from "./preparation-components.js";
import { openPluginRegistry, type PluginRegistry } from "../plugins/open-registry.js";
import { DEFAULT_METRICS } from "../../config/defaults.js";
import { type ExecutionConfig } from "../../core/contracts/config.js";
import { PACKAGE_RUNTIME_ID } from "../../core/results/runtime-identity.js";
import { loadPackageDigest } from "../../infrastructure/provenance/package.js";
import { fingerprintConfig } from "../../core/results/run-manifest.js";
import { assertSolverProvenance, resolveSolverProvenance } from "../../core/results/solver-provenance.js";
import { classifyError } from "../../core/errors/classify.js";
import { credentialSecrets, redactDiagnostic } from "../../core/errors/diagnostics.js";
import { EvaluatorError } from "../../core/errors/evaluator-error.js";
import type { TaskPreparationTiming } from "../../core/contracts/result.js";
import type { JsonValue } from "../../core/contracts/task.js";
import { safeTaskKey } from "../../core/artifacts/artifacts.js";
import { TransferClient } from "../../infrastructure/transfer/client.js";
import { assertWorkerVersions, localizePortableSelection, portableCredentialNames, validateRemoteJob } from "../../infrastructure/ray/protocol.js";
import { parseNodeConfig, type NodeConfig } from "../../infrastructure/ray/node-config.js";
import { ProgressPublisher } from "../../core/progress/progress-wire.js";
import { progressOperation } from "../../core/progress/progress-operation.js";
import { assertEnvironmentTimeouts } from "../../core/preparation/preparation-validation.js";
import { createTaskMaterializer } from "../../core/preparation/materialize-task.js";

export async function executeRemotePreparation(input: unknown, node: NodeConfig, token: string, registry: PluginRegistry): Promise<unknown> {
  if (Number(process.versions.node.split(".")[0]) !== 24) throw new Error("Ray node requires Node 24");
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).sort().join(",") !== "hostname,nodeId,remote"
  )
    throw new TypeError("Invalid Ray worker envelope");
  const envelope = input as { remote: unknown; nodeId: unknown; hostname: unknown };
  for (const label of [envelope.nodeId, envelope.hostname])
    if (typeof label !== "string" || !label || label.length > 4096 || /[\u0000-\u001f]/u.test(label))
      throw new TypeError("Invalid Ray node identity");
  const nodeId = envelope.nodeId as string,
    hostname = envelope.hostname as string;
  const lookup = (role: string, name: string) => nativeResourceTransport(registry.ctx.evaluator.workflows, role, name);
  const remote = validateRemoteJob(envelope.remote, lookup);
  if (remote.preparation?.mode !== "prepare") throw new TypeError("Native Ray worker accepts preparation only; evaluation requires a workflow dispatch");
  if (remote.preparation.nodeId !== nodeId)
    throw new Error("Ray worker differs from prepared node placement");
  const key = { runId: remote.job.runId, taskId: remote.job.taskId, attemptId: remote.job.attemptId };
  await registry.loadRecordedPlugins(remote.pluginVersions);
  const packageDigest = await loadPackageDigest();
  const versions = registry.pluginVersions;
  assertWorkerVersions(remote.pluginVersions, versions, remote.packageDigest, packageDigest);
  const client = new TransferClient({
    endpoint: remote.uploadEndpoint,
    token,
    ca: await readFile(node.caFile),
    timeoutMs: 5000,
    retries: 1,
  });
  const runtimeResponse = await client.control(
    "runtime",
    { key, nodeId, hostname, packageDigest, pluginVersions: versions },
    AbortSignal.timeout(30_000),
  );
  const bindings = parseRuntimeServices(runtimeResponse, { preparation: remote.preparation?.mode === "prepare" });
  const runtimeEnv = { ...process.env };
  const allowed = [...new Set([...networkCredentialNames(remote.safeConfig.network?.template ?? {}), ...portableCredentialNames(remote.safeConfig, lookup)])];
  if (runtimeResponse && typeof runtimeResponse === "object" && "credentialNames" in runtimeResponse) {
    const names = runtimeResponse.credentialNames;
    if (!Array.isArray(names) || names.some(name => typeof name !== "string" || !allowed.includes(name))) throw new TypeError("Invalid Ray resource credential names");
    await Promise.all(names.map(async name => {
      if (runtimeEnv[name]) return;
      const response = await client.control("runtime", { key, nodeId, hostname, packageDigest, pluginVersions: versions, name }, AbortSignal.timeout(30_000));
      if (!response || typeof response !== "object" || !("value" in response) || response.value !== null && typeof response.value !== "string") throw new TypeError("Invalid Ray credential response");
      if (typeof response.value === "string") runtimeEnv[name] = response.value;
    }));
  }
  const secrets = [...allowed.map(name => runtimeEnv[name]).filter((value): value is string => Boolean(value)).flatMap(credentialSecrets), ...Object.values(bindings).map(binding => binding.auth.value), token];
  const progress = new ProgressPublisher((snapshot, signal) => client.control("progress", { key, nodeId, snapshot }, signal), secrets);
  const cancellation = new AbortController();
  if (remote.preparation?.mode === "prepare" && remote.preparation.deadlineAt !== null) {
    const remaining = Date.parse(remote.preparation.deadlineAt) - Date.now();
    if (remaining <= 0 || remaining > 2_147_483_647) throw new Error("Batch preparation deadline exceeded");
    const deadline = AbortSignal.timeout(Math.ceil(remaining));
    deadline.addEventListener("abort", () => cancellation.abort(deadline.reason), { once: true });
  }
  const heartbeatStop = new AbortController();
  const heartbeat = (async () => {
    let failures = 0;
    while (!heartbeatStop.signal.aborted) {
      try {
        const response = (await client.control(
          "control",
          { key, nodeId, state: "running" },
          heartbeatStop.signal,
        )) as { cancelled?: unknown; reason?: unknown };
        if (typeof response.cancelled !== "boolean") throw new Error("Invalid Ray control response");
        if (response.cancelled) cancellation.abort(response.reason === "infrastructure-timeout"
          ? Object.assign(new Error("Ray coordinator detected infrastructure timeout"), { code: "RAY_HEARTBEAT_TIMEOUT" })
          : new Error("Coordinator cancelled Ray task"));
        failures = 0;
      } catch {
        if (++failures >= 3) cancellation.abort(Object.assign(new Error("Ray coordinator heartbeat unavailable"), { code: "RAY_HEARTBEAT_TIMEOUT" }));
      }
      try {
        await delay(1000, undefined, { signal: heartbeatStop.signal });
      } catch {
        break;
      }
    }
  })();
  const root = join(node.outputRoot, "jobs", key.attemptId);
  let preparationTiming: TaskPreparationTiming | undefined;
  const warnings = new Set<string>();
  try {
    async function localized<T extends import("../../core/contracts/config.js").Selection>(selection: T, role: string): Promise<T> {
      const local = localizePortableSelection(selection, role, node, lookup);
      return { ...local, config: await resolveConfigurationCredentials(local.config, lookup(role, local.name)?.secretFields ?? [], async name => runtimeEnv[name]) };
    }
    const benchmark = await localized(remote.safeConfig.benchmark, "benchmark");
    const environment = await localized(remote.safeConfig.environment, "environment");
    const service = remote.safeConfig.solver.service;
    const config: ExecutionConfig = {
      ...(remote.safeConfig.network ? { network: restoreNetworkTemplate(remote.safeConfig.network.template, runtimeEnv), benchmarkName: remote.safeConfig.network.benchmarkName } : {}),
      experiment: {
        hardware: remote.safeConfig.hardware ?? "npu",
        services: Object.fromEntries(Object.entries(bindings).map(([name, binding]) => [name, binding.model])),
        benchmark,
        environment,
        solver: await localized(remote.safeConfig.solver, "solver"),
        ...(remote.safeConfig.verifier ? { verifier: await localized(remote.safeConfig.verifier, "verifier") } : {}),
        metrics: [...DEFAULT_METRICS],
        reporter: { name: "markdown", config: {} },
        store: { name: "local", config: {} },
        scheduler: { name: "local", config: { concurrency: 1 } },
        run: {
          taskIds: [key.taskId],
          maxTasks: null,
          timeoutSeconds: remote.safeConfig.timeoutSeconds,
          ...(remote.safeConfig.solveTimeoutSeconds === undefined ? {} : { solveTimeoutSeconds: remote.safeConfig.solveTimeoutSeconds }),
          ...(remote.safeConfig.verifyTimeoutSeconds === undefined ? {} : { verifyTimeoutSeconds: remote.safeConfig.verifyTimeoutSeconds }),
          ...(remote.safeConfig.scoreAfterSolveTimeout === undefined ? {} : { scoreAfterSolveTimeout: remote.safeConfig.scoreAfterSolveTimeout }),
        },
        output: { directory: root },
      },
      auths: Object.fromEntries(Object.entries(bindings).map(([name, binding]) => [name, binding.auth])),
      persisted: remote.safeConfig as unknown as JsonValue,
    };
    const components = await createPreparationComponents(registry, config, node.configDirectory, message => {
      if (warnings.size < 8) warnings.add(redactDiagnostic(message, secrets)
        .replace(/[\u0000-\u001f\u007f]/gu, " ").slice(0, 4096));
    }, remote.imageConfigFingerprint);
    const solverProvenance = await resolveSolverProvenance(components.solver, cancellation.signal, [
      ...secrets,
      token,
    ], remote.solverProvenance);
    assertSolverProvenance(remote.solverProvenance, solverProvenance);
    assertWorkerVersions(
      remote.pluginVersions,
      { ...components.pluginVersions, [PACKAGE_RUNTIME_ID]: packageDigest },
      remote.packageDigest,
      packageDigest,
    );
    const validateSource = () => progressOperation(progress.observe,
      { phase: "source", message: "Validating the node data source", taskId: key.taskId, attemptId: key.attemptId }, cancellation.signal, async activity => {
      const source = await components.benchmark.resolveSource(remote.source, cancellation.signal, activity);
      if (fingerprintConfig(source) !== fingerprintConfig(remote.source)) throw new Error("Ray node source lock mismatch");
      let matches = 0;
      for await (const ref of components.benchmark.enumerate(source, cancellation.signal, activity)) {
        if (ref.id !== key.taskId) continue;
        if (fingerprintConfig(ref) !== fingerprintConfig(remote.job.ref)) throw new Error("Ray node task reference mismatch");
        matches++;
      }
      if (matches !== 1) throw new Error("Ray node task not uniquely present in locked source");
      return source;
    });
    const preparationFile = join(node.outputRoot, "preparations", key.runId, remote.preparation.roundId, `${safeTaskKey(key.taskId)}.json`);
    const source = await validateSource();
    if (!components.environment.materialize) throw new Error("Node environment lacks batch materialization");
    const task = await progressOperation(progress.observe,
      { phase: "prepare", message: "Reading node task files", taskId: key.taskId, attemptId: key.attemptId }, cancellation.signal,
      activity => components.benchmark.prepare(remote.job.ref, source, cancellation.signal, activity));
    if (task.input.id !== key.taskId || (task.transfer !== null && task.verifyEnv === null))
      throw new Error("Invalid prepared task identity or transfer");
    const timing: TaskPreparationTiming = preparationTiming = { taskId: key.taskId, status: "preparing", queuedAt: new Date().toISOString(),
      startedAt: new Date().toISOString(), finishedAt: null, queueDurationMs: 0, durationMs: null, phaseDurationMs: {} };
    const ready = await createTaskMaterializer(components, { sensitiveValues: secrets, onProgress: progress.observe })(
      { state: "described", task }, cancellation.signal, { roundId: remote.preparation.roundId, attemptId: key.attemptId, timing,
        concurrency: remote.preparation.concurrency, defaultTimeoutSeconds: remote.preparation.defaultTimeoutSeconds,
        roundSignal: cancellation.signal,
        ...(remote.preparation.environmentTimeoutSeconds === null ? {} : { environmentTimeoutSeconds: remote.preparation.environmentTimeoutSeconds }) });
    const evidence = { task: ready.task, packageDigest, source, configFingerprint: remote.job.configFingerprint };
    const digest = fingerprintConfig(evidence);
    cancellation.signal.throwIfAborted();
    await mkdir(dirname(preparationFile), { recursive: true });
    const temporary = `${preparationFile}.${key.attemptId}.tmp`;
    await writeFile(temporary, JSON.stringify(evidence) + "\n", { flag: "wx", mode: 0o600 });
    await rename(temporary, preparationFile);
    cancellation.signal.throwIfAborted();
    return { preparationDigest: digest, nodeId, hostname, environmentTimeouts: timing.environmentTimeouts,
      ...(warnings.size ? { warnings: [...warnings] } : {}) };
  } catch (error) {
    await mkdir(root, { recursive: true });
    const message = redactDiagnostic(error instanceof Error ? error.message : "Ray node failed", secrets);
    const failure = classifyError(error, { phase: "environment", component: "environment",
      secrets: secrets });
    await writeFile(join(root, "worker-error.json"), JSON.stringify({ key, message, failure, environmentTimeouts: preparationTiming?.environmentTimeouts }) + "\n");
    // The original error may contain a key in its cause; only return the sanitized message.
    throw Object.assign(new EvaluatorError(failure.code, message, failure.details), { environmentTimeouts: preparationTiming?.environmentTimeouts });
  } finally {
    cancellation.abort(new DOMException("Ray worker finished", "AbortError"));
    heartbeatStop.abort();
    await heartbeat;
    await progress.close();
  }
}

export async function startNodeWorker(): Promise<void> {
  const filename = process.env.EVALUATOR_NODE_CONFIG;
  if (!filename) throw new Error("EVALUATOR_NODE_CONFIG is required");
  const node = parseNodeConfig(JSON.parse(await readFile(filename, "utf8")), dirname(resolve(filename)));
  process.env.EVALUATOR_CACHE_DIR ??= join(node.outputRoot, "cache");
  if (process.argv[2] === "--network-doctor") {
    const { NetworkRuntime } = await import("../../infrastructure/network/runtime.js");
    const { diagnoseNetwork } = await import("../../infrastructure/network/diagnostics.js");
    const { loadPackageDigest } = await import("../../infrastructure/provenance/package.js");
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of process.stdin) {
      size += chunk.length;
      if (size > 2 * 1024 * 1024) throw new Error("Network diagnosis input too large");
      chunks.push(Buffer.from(chunk));
    }
    const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    validateNetworkSnapshot(input.network);
    const plan = parseNetworkProbePlan(input.plan);
    if (input.packageDigest !== await loadPackageDigest() || typeof input.location !== "string") throw new Error("Network diagnosis node package mismatch");
    const network = new NetworkRuntime(restoreNetworkTemplate(input.network.template, process.env));
    const controller = new AbortController();
    const cancel = () => controller.abort();
    process.once("SIGTERM", cancel); process.once("SIGINT", cancel);
    try {
      const results = await diagnoseNetwork(network, controller.signal, { plan, benchmark: input.network.benchmarkName,
        location: input.location, ...(node.dockerExecutable ? { docker: node.dockerExecutable } : {}) });
      process.stdout.write(JSON.stringify(results) + "\n");
    } finally { process.removeListener("SIGTERM", cancel); process.removeListener("SIGINT", cancel); await network.dispose(); }
    return;
  }
  if (process.argv[2] === "--image-lease") {
    const { createInterface } = await import("node:readline");
    const { guardNodeImages } = await import("./image-cleanup-worker.js");
    const lines = createInterface({ input: process.stdin });
    const closed = Promise.withResolvers<void>();
    const payload = Promise.withResolvers<unknown>();
    let received = false;
    lines.on("line", line => {
      if (received || Buffer.byteLength(line) > 2 * 1024 * 1024) { payload.reject(new Error("Invalid image lease input")); lines.close(); return; }
      received = true;
      try { payload.resolve(JSON.parse(line)); } catch (error) { payload.reject(error); }
    });
    lines.on("close", () => { closed.resolve(); if (!received) payload.reject(new Error("Missing image lease input")); });
    const cancel = () => { closed.resolve(); lines.close(); };
    process.once("SIGTERM", cancel); process.once("SIGINT", cancel);
    console.log = console.info = console.warn = console.error = () => {};
    try { await guardNodeImages(await payload.promise, node, closed.promise, () => process.stdout.write("ready\n")); }
    finally { process.removeListener("SIGTERM", cancel); process.removeListener("SIGINT", cancel); lines.close(); }
    return;
  }
  if (process.argv[2] === "--image-cleanup") {
    const { cleanupNodeImages } = await import("./image-cleanup-worker.js");
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of process.stdin) {
      size += chunk.length;
      if (size > 2 * 1024 * 1024) throw new Error("Image cleanup input too large");
      chunks.push(Buffer.from(chunk));
    }
    console.log = console.info = console.warn = console.error = () => {};
    const result = await cleanupNodeImages(JSON.parse(Buffer.concat(chunks).toString("utf8")), node);
    process.stdout.write(JSON.stringify(result) + "\n");
    return;
  }
  const token = process.env[node.tokenEnv];
  if (!token) throw new Error("Ray transfer token is unavailable");
  delete process.env[node.tokenEnv];
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 2 * 1024 * 1024) throw new Error("Ray input too large");
    chunks.push(Buffer.from(chunk));
  }
  // Reserve stdout for the bridge response, including while third-party plugins load.
  console.log = console.info = console.warn = console.error = () => {};
  const input = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { remote?: unknown };
  const registry = await openPluginRegistry(node.pluginPatchPath);
  try {
    const result = await executeRemotePreparation(input, node, token, registry);
    process.stdout.write(JSON.stringify(result) + "\n");
  } catch (error) {
    // Preflight can fail before executeRemotePreparation has obtained runtime auth or
    // opened a run store. Preserve a bounded, credential-free diagnostic there too.
    const remote = validateRemoteJob(input.remote, (role, name) => nativeResourceTransport(registry.ctx.evaluator.workflows, role, name));
    const root = join(node.outputRoot, "jobs", remote.job.attemptId);
    await mkdir(root, { recursive: true });
    const message = error instanceof Error ? error.message : "";
    const code = /(?:version mismatch|package .*digest|package provenance)/iu.test(message)
      ? "SOURCE_CHANGED"
      : classifyError(error, { phase: "environment" }).code;
    try {
      await writeFile(
        join(root, "worker-error.json"),
        JSON.stringify({
          key: { runId: remote.job.runId, taskId: remote.job.taskId, attemptId: remote.job.attemptId },
          code,
        }) + "\n",
        { flag: "wx" },
      );
    } catch (diagnosticError) {
      if ((diagnosticError as NodeJS.ErrnoException).code !== "EEXIST") throw diagnosticError;
    }
    // Only the canonical code and validated numeric timing evidence cross the boundary. Detailed causes
    // remain in the node's sanitized evidence, never in Ray exception strings.
    const failure = classifyError(error, { phase: "environment", component: "environment" });
    const environmentTimeouts = error && typeof error === "object" && "environmentTimeouts" in error ? error.environmentTimeouts : undefined;
    assertEnvironmentTimeouts(environmentTimeouts);
    process.stdout.write(JSON.stringify({ errorCode: code, ...(environmentTimeouts === undefined ? {} : { environmentTimeouts }), ...(code === "NETWORK_FAILURE" ? { network: failure.details } : {}) }) + "\n");
    throw error;
  } finally { await registry.dispose(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  void startNodeWorker().catch(() => {
    process.stderr.write("Ray node execution failed; retained node evidence may contain details.\n");
    process.exitCode = 1;
  });
