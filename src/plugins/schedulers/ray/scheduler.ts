import { networkCredentialNames, networkSnapshot } from "../../../config/network-schema.js";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { EffectiveConfig } from "../../../core/contracts/config.js";
import type { PluginFactoryContext } from "../../../core/contracts/plugin.js";
import type { SchedulerPreparationContext, TaskScheduler, TaskJob } from "../../../core/contracts/scheduler.js";
import type { AttemptKey, PreparationRound } from "../../../core/contracts/result.js";
import { PACKAGE_RUNTIME_ID } from "../../../core/results/runtime-identity.js";
import { loadPackageDigest } from "../../../infrastructure/provenance/package.js";
import { runPreparationQueue } from "../shared/preparation-queue.js";
import { failureDecision } from "../../../core/policies/error-policy.js";
import { classifyError } from "../../../core/errors/classify.js";
import { EvaluatorError } from "../../../core/errors/evaluator-error.js";
import { isErrorCode } from "../../../core/errors/registry.js";
import { RayClient } from "../../../infrastructure/ray/client.js";
import type { RayConnection } from "../../../infrastructure/ray/connection.js";
import { RayControl } from "../../../infrastructure/ray/control.js";
import { portableCredentialNames, projectRemoteJob, projectPortableSelection, validateRemoteJob, type RemotePreparation } from "../../../infrastructure/ray/protocol.js";
import { startTransferReceiver } from "../../../infrastructure/transfer/https.js";
import type { RaySchedulerConfig } from "../../../config/ray.js";
import type { ConfigTransportLookup } from "../../../core/contracts/config-transport.js";
import type { BenchmarkRunPlan } from "../../../core/contracts/benchmark.js";
import type { PreparationContext, ScheduledPreparation, TaskPlacement } from "../../../core/contracts/preparation.js";
import { runPreparationRound } from "../../../core/preparation/preparation-round.js";
import { preparationConcurrency } from "../../../core/preparation/preparation-timeout.js";
import type { ImageCleanupRequest, ImageCleanupNode } from "../../../core/contracts/image-cleanup.js";
import type { Selection } from "../../../core/contracts/config.js";

export class RayScheduler implements TaskScheduler {
  readonly executionLocation = "remote" as const;
  private preparationContext: SchedulerPreparationContext | undefined;
  private control: RayControl | undefined;
  private client: RayClient | undefined;
  private server: Awaited<ReturnType<typeof startTransferReceiver>> | undefined;
  private connection: RayConnection | undefined;
  private credential: ((name: string) => Promise<string | undefined>) | undefined;
  private unbind: (() => void) | undefined;
  private packageDigest = "";
  private readonly prepared = new Map<string, RemotePreparation>();
  constructor(
    private readonly config: RaySchedulerConfig,
    private readonly runtime: PluginFactoryContext,
    private readonly configTransport?: ConfigTransportLookup,
  ) {}
  bindConnection(connection: RayConnection, credential: (name: string) => Promise<string | undefined>): void {
    if (this.preparationContext || this.connection) throw new Error("Ray connection must be bound before scheduler setup");
    this.connection = connection;
    this.credential = credential;
  }
  preparation(taskId: string): RemotePreparation | undefined {
    const receipt = this.prepared.get(taskId);
    return receipt && structuredClone(receipt);
  }
  async setupPreparation(context: SchedulerPreparationContext, signal: AbortSignal): Promise<void> {
    await this.connect(context, signal);
  }
  async cleanupImages(request: ImageCleanupRequest,
    environment: Selection, pluginVersions: Record<string, string>, signal: AbortSignal): Promise<ImageCleanupNode[]> {
    const client = this.createClient();
    try {
      await client.start(signal);
      const payload = { environment: projectPortableSelection(environment, "environment", this.configTransport),
        pluginVersions, packageDigest: await loadPackageDigest(), request: { ...request, execute: false } };
      const preview = await client.cleanupImages(payload, client.nodes, signal);
      if (!request.execute || signal.aborted) return preview;
      const conflicting = new Set(preview.filter(node => node.daemonId && preview.some(other => other.nodeId !== node.nodeId && other.daemonId === node.daemonId && other.inventoryId !== node.inventoryId)).map(node => node.daemonId));
      for (const node of preview) if (conflicting.has(node.daemonId)) {
        node.error = "Nodes share a Docker daemon but have different image inventories; configure a shared EVALUATOR_CACHE_DIR before deleting images";
      }
      const seen = new Set<string>();
      const nodes = preview.filter(node => {
        if (node.error || !node.daemonId || seen.has(node.daemonId)) return false;
        seen.add(node.daemonId); return true;
      }).map(node => node.nodeId);
      const results = nodes.length ? await client.cleanupImages({ ...payload, request }, nodes, signal) : [];
      return [...results, ...preview.filter(node => node.error), ...preview.filter(node => !nodes.includes(node.nodeId) && !node.error).map(node => ({
        nodeId: node.nodeId, daemonId: node.daemonId, items: [],
      }))];
    } finally { await client.close(); }
  }
  private async connect(context: SchedulerPreparationContext, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (this.preparationContext) throw new Error("Ray scheduler cannot be reused for another session");
    this.preparationContext = context;
    this.packageDigest = await loadPackageDigest();
    if (context.session.pluginVersions[PACKAGE_RUNTIME_ID] !== this.packageDigest)
      throw new Error("Coordinator package differs from locked Ray run");
    const token = process.env[this.config.collector.tokenEnv] ?? "";
    if (!this.connection && (!token || Object.values(this.runtime.services).some(binding => binding.auth.value === token)))
      throw new Error("Ray requires a separate transfer token environment variable");
    this.control = new RayControl(this.runtime.services, async () => {
      throw new Error("Preparation sessions cannot admit evaluation attempts");
    }, context.onProgress, { names: [...new Set([...networkCredentialNames(this.runtime.network?.document.template ?? {}),
      ...portableCredentialNames(context.safeConfig as unknown as EffectiveConfig, this.configTransport)])],
      resolve: this.credential ?? (async name => process.env[name]) });
    try {
      const config = context.safeConfig as unknown as EffectiveConfig;
      const imageGuard = { environment: projectPortableSelection(config.environment, "environment", this.configTransport),
        pluginVersions: context.session.pluginVersions, packageDigest: this.packageDigest };
      if (this.connection) {
        const control = this.control;
        this.client = this.connection.client;
        this.unbind = this.connection.subscribe("run", context.session.runId, (route, body) => control.handle(route, body));
        await this.client.guardImages(imageGuard, signal);
      } else {
        this.server = await startTransferReceiver({
          token,
          key: await readFile(this.runtime.resolvePath(this.config.collector.keyFile)),
          cert: await readFile(this.runtime.resolvePath(this.config.collector.certFile)),
          host: this.config.collector.host,
          port: this.config.collector.port,
          control: (route, body) => this.control!.handle(route, body),
        });
        this.client = this.createClient(imageGuard);
        await this.client.start(signal);
      }
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  private createClient(imageGuard?: unknown): RayClient {
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        ([name, value]) => !Object.values(this.runtime.services).some(binding =>
          binding.auth.reference === name || binding.auth.value && value?.includes(binding.auth.value)),
      ),
    );
    return new RayClient({
      ...(imageGuard === undefined ? {} : { imageGuard }),
      pythonExecutable:
        this.config.pythonExecutable.includes("/") || this.config.pythonExecutable.includes("\\")
          ? this.runtime.resolvePath(this.config.pythonExecutable)
          : this.config.pythonExecutable,
      driverPath: fileURLToPath(new URL("../../../infrastructure/ray/python/driver.py", import.meta.url)),
      endpoint: this.config.endpoint,
      startupTimeoutMs: this.config.startupTimeoutMs,
      ...(this.config.concurrency === undefined ? {} : { concurrency: this.config.concurrency }),
      ...(this.config.nodes === undefined ? {} : { nodes: this.config.nodes }),
      env,
    });
  }
  async prepareTasks(jobs: TaskJob[], plan: BenchmarkRunPlan, context: PreparationContext, signal: AbortSignal): Promise<ScheduledPreparation> {
    if (context.settings?.mode === "pipeline") throw new Error("Ray scheduler does not support pipeline preparation");
    if (context.settings?.lookahead !== undefined) throw new TypeError("Ray batch preparation does not accept lookahead");
    let placements: TaskPlacement[] = [];
    const tasks = await runPreparationRound(plan, context, signal, async (round, preparationSignal) => {
      placements = await this.prepareNodes(jobs, round, preparationSignal,
        context.settings?.concurrency ?? this.config.concurrency ?? this.client?.slots ?? 1, context.sensitiveValues,
        plan, context);
      for (const item of round.tasks ?? [])
        if (item.failure) (plan.preparationFailures ??= []).push({ taskId: item.taskId, failure: item.failure });
      const failed = new Set((plan.preparationFailures ?? []).map(item => item.taskId));
      return plan.tasks.filter(task => !failed.has(task.input.id));
    });
    return { tasks, placements };
  }
  private async prepareNodes(jobs: TaskJob[], round: PreparationRound, signal: AbortSignal, concurrency = 1,
    secrets: readonly string[], plan: BenchmarkRunPlan, preparationContext: PreparationContext): Promise<TaskPlacement[]> {
    if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new TypeError("Preparation concurrency must be a positive integer");
    if (!this.client || !this.control || !this.preparationContext) throw new Error("Ray scheduler setup is required");
    const client = this.client, control = this.control, context = this.preparationContext;
    const timings = new Map(round.tasks?.map(task => [task.taskId, task]));
    assertRayCapacity(client.slots, this.config.concurrency, jobs.length);
    for (const job of jobs) this.prepared.delete(job.taskId);
    const nodes = [...client.nodes].sort();
    if (!nodes.length) throw new Error("No Ray execution nodes available for preparation");
    const assignments = new Map(nodes.map(node => [node, [] as TaskJob[]]));
    // Freeze placement before starting any work; distribute replicas by declared
    // attempt capacity rather than treating task CPU caps as reserved cores.
    for (const job of jobs) {
      const node = [...nodes].sort((a, b) =>
        assignments.get(a)!.length / client.nodeSlots[a]! - assignments.get(b)!.length / client.nodeSlots[b]! || a.localeCompare(b))[0]!;
      assignments.get(node)!.push(job);
    }
    for (const [nodeId, assigned] of assignments) context.onProgress?.({ phase: "prepare",
      message: `Ray node ${nodeId}: assigned ${assigned.length} tasks before image preparation` });
    const capacity = [...assignments].reduce((sum, [nodeId, assigned]) =>
      sum + Math.min(concurrency, assigned.length, client.nodeSlots[nodeId]!), 0);
    if (capacity > 1) { round.mode = "batch"; round.concurrency = capacity; }
    round.nodeConcurrency = Object.fromEntries([...assignments].filter(([, assigned]) => assigned.length)
      .map(([nodeId, assigned]) => [nodeId, preparationConcurrency(concurrency, assigned.length, client.nodeSlots[nodeId])]));
    const controller = new AbortController();
    const combined = AbortSignal.any([signal, controller.signal]);
    const pendingKeys = new Set<AttemptKey>();
    const cancel = () => {
      for (const key of pendingKeys) {
        control.cancel(key);
        try { client.cancel(key.attemptId); } catch { /* Node heartbeat also cancels. */ }
      }
    };
    combined.addEventListener("abort", cancel, { once: true });
    try {
      const outcomes = await Promise.allSettled([...assignments].map(async ([nodeId, assigned]) => {
        const nodeConcurrency = preparationConcurrency(concurrency, assigned.length, client.nodeSlots[nodeId]);
        await runPreparationQueue(assigned, nodeConcurrency, combined, async job => {
          try {
            combined.throwIfAborted();
            const started = Date.now();
            const startedAt = new Date(started).toISOString();
            const preparationJob = { ...job, attemptId: randomUUID() };
            const key = { runId: job.runId, taskId: job.taskId, attemptId: preparationJob.attemptId };
            const timing = timings.get(job.taskId);
            if (!timing) throw new Error("Missing Ray preparation task timing");
            Object.assign(timing, { status: "preparing", startedAt, queueDurationMs: started - Date.parse(round.startedAt) });
            const preparation: RemotePreparation = { roundId: round.id, deadlineAt: round.deadlineAt, nodeId, mode: "prepare", digest: null,
              concurrency: nodeConcurrency, defaultTimeoutSeconds: plan.preparation.defaultTimeoutSeconds,
              environmentTimeoutSeconds: preparationContext.settings?.environmentTimeoutSeconds ?? null };
            const remote = validateRemoteJob({ ...projectRemoteJob({
      ...(this.runtime.network ? { network: networkSnapshot(this.runtime.network, this.runtime.benchmarkName ?? "unknown") } : {}),
              job: preparationJob, run: context.session, config: context.safeConfig as unknown as EffectiveConfig,
              packageDigest: this.packageDigest, uploadEndpoint: this.collectorUrl(), previousAttempts: [],
              ...(this.configTransport ? { configTransport: this.configTransport } : {}),
            }), schemaVersion: 2, preparation }, this.configTransport);
            control.register(key, this.packageDigest, context.session.pluginVersions, true);
            pendingKeys.add(key);
            try {
              const response = await client.submit(remote);
              const environmentTimeouts = response.type === "failed" ? response.environmentTimeouts : response.type === "prepared" ? response.result.environmentTimeouts : undefined;
              if (environmentTimeouts) timing.environmentTimeouts = environmentTimeouts;
              combined.throwIfAborted();
              if (response.type === "failed" && response.retired !== true)
                throw new EvaluatorError("CLEANUP_FAILED", "Remote preparation retirement is unconfirmed");
              if (response.type === "failed" && isErrorCode(response.code))
                throw new EvaluatorError(response.code, `Ray environment preparation failed for ${job.taskId} (${response.code})`,
                  { component: "environment", operation: "ray-prepare", ...(response.network ?? {}) });
              if (response.type !== "prepared" || response.result.nodeId !== nodeId)
                throw new Error(`Ray environment preparation failed for ${job.taskId}`);
              control.finishProgress(key, "completed");
              for (const warning of response.result.warnings ?? []) context.log?.(`[warn] [environment] ${job.taskId}: ${warning}`);
              this.prepared.set(job.taskId, { ...preparation, mode: "execute", digest: response.result.preparationDigest });
              Object.assign(timing, { status: "ready", finishedAt: new Date().toISOString(), durationMs: Date.now() - started });
            } catch (error) {
              control.finishProgress(key, combined.aborted ? "cancelled" : "failed");
              if (combined.aborted) throw error;
              const now = new Date().toISOString();
              const failure = classifyError(error, { phase: "prepare", component: "environment", secrets });
              Object.assign(timing, { status: "error", finishedAt: now, durationMs: Date.now() - started, failure });
              if (["abort_run", "stop_dispatch"].includes(failureDecision(failure).action)) throw error;
              if (preparationContext.onError !== "continue") throw error;
            } finally { pendingKeys.delete(key); }
          } catch (error) { controller.abort(error); throw error; }
        });
      }));
      const rejected = outcomes.find(outcome => outcome.status === "rejected");
      if (rejected?.status === "rejected") throw rejected.reason;
      combined.throwIfAborted();

      round.placements = jobs.filter(job => this.prepared.has(job.taskId)).map(job => {
        const receipt = this.prepared.get(job.taskId)!;
        return { taskId: job.taskId, nodeId: receipt.nodeId, digest: receipt.digest! };
      });
      return [...assignments].flatMap(([nodeId, assigned]) => assigned.map(job => ({ taskId: job.taskId, nodeId })));
    } catch (error) {
      controller.abort(error);
      throw error;
    } finally { combined.removeEventListener("abort", cancel); }
  }
  validateCapacity(taskCount: number): void {
    if (!this.client) throw new Error("Ray scheduler setup is required");
    assertRayCapacity(this.client.slots, this.config.concurrency, taskCount);
  }
  async close(): Promise<void> {
    try {
      if (!this.connection) await this.client?.close();
    } finally {
      try { await this.server?.close(); }
      finally { this.unbind?.(); this.unbind = undefined; this.control?.close(); this.server = undefined; }
    }
  }
  private collectorUrl(): string {
    if (this.connection) return this.connection.endpoint;
    if (!this.config.collector.publicUrl) return this.server!.url;
    const url = new URL(this.config.collector.publicUrl);
    if (this.config.collector.port === 0) url.port = new URL(this.server!.url).port;
    return url.origin;
  }
}

export function assertRayCapacity(slots: number, concurrency: number | undefined, taskCount: number): void {
  const required = Math.min(concurrency ?? slots, taskCount);
  if (slots < required) throw new Error(`Ray selected nodes provide ${slots} task slots; ${required} required for ${taskCount} pending tasks`);
}
