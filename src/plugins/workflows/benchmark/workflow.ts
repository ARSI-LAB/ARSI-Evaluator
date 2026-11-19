import { parsePluginActivations } from "../../../core/plugins/activation.js";
import { validatePortablePluginActivations } from "../../../infrastructure/ray/protocol.js";
import { progressOperation } from "../../../core/progress/progress-operation.js";
import { classifyError, failureMessage } from "../../../core/errors/classify.js";
import { isStreamTaskRetryEligible, MAX_STREAM_TASK_RETRIES } from "../../../core/recovery/automatic-task-retry.js";
import { diagnose } from "./doctor.js";
import { diagnoseDownloads } from "./downloads.js";
import { credentialReference } from "../../../core/validation/credential.js";
import { credentialSecrets } from "../../../core/errors/diagnostics.js";
import { benchmarkDeployment } from "./deployment.js";
import { parseDeployment } from "../../../config/deployment.js";
import { requiresDispatchStop } from "../../../core/policies/error-policy.js";
import { loadRunIdentity } from "../../../infrastructure/provenance/run-identity.js";
import { bindSolverService } from "../../../core/contracts/plugin.js";
import { assertServiceReferences, referencedServiceNames } from "../../../core/policies/service-bindings.js";
import { openNativeResource, nativeResourceTransport, prepareNativeResource } from "./component-resource.js";
import type { Context } from "@deepseek-ai/cordis";
import { access } from "node:fs/promises";
import { join } from "node:path";
import type { EffectiveConfig } from "../../../core/contracts/config.js";
import type { RunComponents } from "../../../core/contracts/components.js";
import type { PluginFactoryContext } from "../../../core/contracts/plugin.js";
import type { SourceLock, TaskRef } from "../../../core/contracts/task.js";
import type { AttemptKey, AttemptRecord } from "../../../core/contracts/result.js";
import type { WorkflowMaintenanceOutcome, ResourceProvider, WorkflowAdmission, WorkflowContext, WorkflowDocument, WorkflowObject, ExecutionUnitIdentity, WorkflowUnitRequest, WorkflowUnitExecutor, WorkflowArtifact, WorkflowArtifacts } from "../../../core/contracts/workflow.js";
import { workflowConfiguration } from "../../../config/workflow-schema.js";
import { parseEffectiveConfig } from "../../../config/effective.js";
import { parseUserConfig } from "../../../config/user-schema.js";
import { resolveInput } from "../../../config/resolve.js";
import { requireNetwork, withRecoveryNetwork } from "../../resources/network-runtime.js";
import { enumerateSelectedTasks } from "../../../core/selection/task-selection.js";
import { fingerprintImageConfig } from "../../../core/policies/image-config.js";
import { attemptStatus, attemptTimeoutKind, hasUnconfirmedCleanup, evaluationScore, isEvaluationComplete } from "../../../core/results/evaluation-outcome.js";
import { resolveSolverProvenance, assertResumeSolverProvenance } from "../../../core/results/solver-provenance.js";
import { jsonPort, workflowDigest, workflowObject, workflowValue } from "../../../core/workflow/values.js";
import { scoreSetPort } from "../../../core/workflow/scores.js";
import { expectNonEmptyString, expectPositiveInteger, rejectUnknown } from "../../../core/validation/input.js";
import { noConfig } from "../../steps/workflow-builtins.js";
import { createBenchmarkAttempt, type BenchmarkAttempt } from "./attempt.js";
import { benchmarkActions, benchmarkAttemptBlock, benchmarkOperations, benchmarkOperationSteps } from "./definition.js";
import { prepareBenchmarkSelection, prepareRetryTask } from "./preparation.js";
import type { TaskPreparation } from "../../../core/preparation/task-preparation.js";
import { saveReport } from "./report.js";
import { benchmarkOfflineReport, validateBenchmarkReport } from "./offline-report.js";
import { resolveRunStatus } from "../../../core/results/task-result-resolver.js";
import { warmupSelectedTasks } from "./warmup.js";
import { benchmarkAttemptResource, exportBenchmarkEvidence, benchmarkScoreOutputs } from "./evidence.js";
import { RayConnection } from "../../../infrastructure/ray/connection.js";
import { importBenchmarkEvidence } from "./remote-evidence.js";
import { registerRemoteBenchmarkAttempt, benchmarkNodeConfig } from "./remote-attempt.js";
import { projectPortableSelection, localizePortableSelection } from "../../../infrastructure/ray/protocol.js";
import { workflowScheduling } from "../scheduling.js";
import { parseWorkflowDocument } from "../../../config/workflow-schema.js";
import { RayScheduler } from "../../schedulers/ray/scheduler.js";

/** Private task references and verifier state never appear in workflow outputs. */
type BenchmarkSession = WorkflowAdmission & import("../../../core/contracts/workflow.js").WorkflowRetryPolicy & {
  failureSignal: AbortSignal;
  completed(record: AttemptRecord): void;
  recoveryIdentity: WorkflowObject;
  reuseInputs(unit: ExecutionUnitIdentity): Promise<WorkflowObject>;
  remoteSelection(unit?: ExecutionUnitIdentity): Promise<WorkflowObject[]>;
  prepareAttempt(unit: ExecutionUnitIdentity, attemptId: string, signal: AbortSignal): Promise<boolean>;
  placement(unit: ExecutionUnitIdentity): string | undefined;
  admit(unit: ExecutionUnitIdentity, attemptId: string): Promise<void>;
  import(unit: ExecutionUnitIdentity, attemptId: string, artifacts: readonly WorkflowArtifact[], reader: WorkflowArtifacts): Promise<void>;
  select(signal: AbortSignal): Promise<WorkflowObject[]>;
  prepare(context: WorkflowContext): Promise<WorkflowObject[]>;
  report(metrics: WorkflowObject): Promise<string>;
  validateResume(signal: AbortSignal): Promise<void>;
  attempt(taskId: string, context: WorkflowContext): Promise<BenchmarkAttempt>;
  recover(key: AttemptKey, signal: AbortSignal): Promise<void>;
  metrics(): Promise<WorkflowObject>;
  close(): Promise<void>;
};
function session(value: unknown): BenchmarkSession {
  if (value && typeof value === "object" && "select" in value && typeof value.select === "function" &&
      "attempt" in value && typeof value.attempt === "function" && "recover" in value && typeof value.recover === "function" &&
      "metrics" in value && typeof value.metrics === "function" && "close" in value && typeof value.close === "function") return value as BenchmarkSession;
  throw new TypeError("Missing benchmark session resource");
}
type AttemptHandle = { driver: BenchmarkAttempt; actions: ReturnType<typeof benchmarkActions>; evidence(): Promise<WorkflowObject> };
function attemptHandle(value: unknown): AttemptHandle {
  if (value && typeof value === "object" && "driver" in value && "actions" in value) return value as AttemptHandle;
  throw new TypeError("Missing benchmark attempt resource");
}

export function registerBenchmarkWorkflow(ctx: Context): void {
  function benchmarkCredentials(config: Readonly<WorkflowObject>): string[] {
    const experiments = Array.isArray(config.variants) ? config.variants.map(value => workflowObject(value).experiment) : [config.experiment];
    return [...new Set(experiments.flatMap(value => {
      const raw = workflowObject(value), experiment = parseEffectiveConfig(raw);
      const services = workflowObject(raw.services);
      const names = referencedServiceNames(experiment).flatMap(service => {
        const name = workflowObject(services[service]).apiKeyEnv; return typeof name === "string" ? [name] : [];
      });
      for (const role of ["benchmark", "environment", "solver", "verifier", "store", "scheduler", "reporter", "metrics"] as const) {
        const selections = role === "metrics" ? experiment.metrics : [experiment[role]];
        for (const selection of selections) if (selection) {
          const provider = ctx.evaluator.workflows.resource(`native.${role}.${selection.name}`);
          names.push(...provider.credentials?.(provider.validateConfig(selection.config)) ?? []);
        }
      }
      return names;
    }))];
  }

  function assertCredentialReferences(experiment: EffectiveConfig): void {
    for (const role of ["benchmark", "environment", "solver", "verifier", "store", "scheduler", "reporter", "metrics"] as const) {
      const selections = role === "metrics" ? experiment.metrics : [experiment[role]];
      for (const selection of selections) if (selection) for (const field of nativeResourceTransport(ctx.evaluator.workflows, role, selection.name)?.secretFields ?? []) {
        if (selection.config[field] !== undefined && !credentialReference(selection.config[field])) throw new TypeError(`${role}.${field} must use { credential: ENV_NAME }`);
      }
    }
  }

  function settings(value: unknown): WorkflowObject {
    const config = workflowObject(value);
    rejectUnknown(config, ["experiment", "variants", "repetitions", "plugins"], "benchmark.runtime");
    expectPositiveInteger(config.repetitions ?? 1, "benchmark repetitions");
    if (config.variants !== undefined) {
      if (!Array.isArray(config.variants) || !config.variants.length) throw new TypeError("Benchmark variants must be a nonempty array");
      const ids = new Set<string>();
      for (const value of config.variants) {
        const variant = workflowObject(value);
        rejectUnknown(variant, ["id", "experiment"], "benchmark variant");
        const id = expectNonEmptyString(variant.id, "benchmark variant ID");
        if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(id) || ids.has(id)) throw new TypeError("Benchmark variant IDs must be unique simple identifiers");
        ids.add(id);
        settings({ experiment: variant.experiment });
      }
    }
    const source = workflowObject(config.experiment);
    rejectUnknown(source, ["hardware", "services", "benchmark", "verifier", "environment", "solver", "metrics", "reporter", "store", "scheduler", "run", "output"], "benchmark experiment");
    for (const [name, raw] of Object.entries(workflowObject(source.services))) {
      const service = workflowObject(raw);
      if (service.apiKey !== undefined) throw new TypeError(`services.${name}: use apiKeyEnv instead of a credential value`);
      if (service.apiKeyEnv !== undefined) expectNonEmptyString(service.apiKeyEnv, `services.${name}.apiKeyEnv`);
    }
    const parsed = parseEffectiveConfig(source);
    const selections = parsed.scheduler.name === "ray" ? validatePortablePluginActivations(config.plugins) : parsePluginActivations(config.plugins);
    ctx.evaluator.prepareStoreDecorators(selections);
    assertServiceReferences(parsed);
    assertCredentialReferences(parsed);
    if (!["local", "ray"].includes(parsed.scheduler.name)) throw new TypeError("Benchmark workflow requires local or ray scheduling");
    for (const role of ["benchmark", "environment", "solver", "store", "scheduler", "reporter"] as const) prepareNativeResource(ctx, role, parsed[role]);
    if (parsed.verifier) prepareNativeResource(ctx, "verifier", parsed.verifier);
    for (const metric of parsed.metrics) prepareNativeResource(ctx, "metrics", metric);
    return config;
  }

  async function factoryRuntime(config: Readonly<WorkflowObject>, context: WorkflowContext, requireCredentials = true) {
    const sourceConfig = workflowObject(config.experiment);
    const configDirectory = context.runtime.resolvePath(".");
    const experiment: EffectiveConfig = parseEffectiveConfig(sourceConfig);
    if (experiment.scheduler.config.deployment === "ray-jobs") {
      const host = { outputRoot: context.runtime.directory };
      const lookup = (role: string, name: string) => nativeResourceTransport(ctx.evaluator.workflows, role, name);
      for (const role of ["benchmark", "environment", "store", "reporter"] as const)
        experiment[role] = localizePortableSelection(experiment[role], role, host, lookup);
      experiment.solver = localizePortableSelection(experiment.solver, "solver", host, lookup);
      if (experiment.verifier) experiment.verifier = localizePortableSelection(experiment.verifier, "verifier", host, lookup);
      experiment.metrics = experiment.metrics.map(selection => localizePortableSelection(selection, "metrics", host, lookup));
    }
    const rawServices = workflowObject(sourceConfig.services);
    const requiredServices = new Set(referencedServiceNames(experiment));
    const services = Object.fromEntries(await Promise.all(Object.entries(experiment.services).filter(([name]) => requiredServices.has(name)).map(async ([name, model]) => {
      const raw = workflowObject(rawServices[name]);
      const reference = typeof raw.apiKeyEnv === "string" ? raw.apiKeyEnv : null;
      const value = reference === null || !requireCredentials ? "" : await context.runtime.credential(reference);
      if (requireCredentials && reference !== null && !value) throw new TypeError(`Missing credential environment variable ${reference}`);
      return [name, { model, auth: { value: value ?? "", reference } }] as const;
    })));
    const secrets = Object.values(services).map(service => service.auth.value).filter(Boolean);
    const network = requireNetwork(context.resource("network"));
    secrets.push(...network.secrets);
    const runtime: PluginFactoryContext = {
      configDirectory, resolvePath: context.runtime.resolvePath, services, solverService: experiment.solver.service,
      environmentName: experiment.environment.name, benchmarkName: experiment.benchmark.name, hardware: experiment.hardware ?? "npu", network,
      imageConfigFingerprint: fingerprintImageConfig(workflowValue(experiment), (role, name) => nativeResourceTransport(ctx.evaluator.workflows, role, name)),
      phaseTimeouts: { ...(experiment.run.solveTimeoutSeconds === undefined ? {} : { solveTimeoutSeconds: experiment.run.solveTimeoutSeconds }),
        ...(experiment.run.verifyTimeoutSeconds === undefined ? {} : { verifyTimeoutSeconds: experiment.run.verifyTimeoutSeconds }) },
      onWarning: message => context.log(message),
    };
    return { experiment, runtime, secrets, network, sourceConfig };
  }

  async function assemble(config: Readonly<WorkflowObject>, context: WorkflowContext, requireCredentials = true, connection?: RayConnection) {
    const { experiment, runtime, secrets, network, sourceConfig } = await factoryRuntime(config, context, requireCredentials);
    const releases: (() => Promise<void>)[] = [];
    let disposal: Promise<void> | undefined;
    const dispose = () => disposal ??= (async () => {
      const errors: unknown[] = [];
      for (const release of releases.reverse()) { try { await release(); } catch (error) { errors.push(error); } }
      if (errors.length) throw new AggregateError(errors, "Benchmark components failed to close");
    })();
    async function create<R extends import("../../../core/contracts/plugin.js").PluginRole>(role: R,
      selection: import("../../../core/contracts/config.js").Selection, factoryContext: import("../../../core/contracts/plugin.js").FactoryContext<R>) {
      const resource = await openNativeResource(ctx, role, selection, factoryContext, async name => {
        const value = await context.runtime.credential(name);
        if (value) secrets.push(...credentialSecrets(value));
        return value;
      });
      releases.push(resource.dispose); return resource.value;
    }
    try {
      const verifier = experiment.verifier ? await create("verifier", experiment.verifier, {
        ...runtime, ...(experiment.verifier.service ? { verifierService: experiment.verifier.service } : {}),
      }) : undefined;
      const benchmark = await create("benchmark", experiment.benchmark, { ...runtime, ...(verifier ? { verifier } : {}) });
      benchmark.validateRun?.(experiment);
      const components: RunComponents = {
        benchmark, environment: await create("environment", experiment.environment, runtime),
        solver: await create("solver", experiment.solver, runtime),
        store: await create("store", experiment.store, runtime),
        scheduler: await create("scheduler", experiment.scheduler, runtime),
        reporter: await create("reporter", experiment.reporter, runtime), metrics: [], pluginVersions: Object.fromEntries(Object.entries(context.plan?.sources ?? {}).filter(([name]) => !name.startsWith("template:"))),
      };
      if (connection && components.scheduler instanceof RayScheduler) {
        const token = await context.runtime.credential(connection.config.collector.tokenEnv);
        if (!token || secrets.includes(token)) throw new TypeError("Ray requires a separate transfer token");
        components.scheduler.bindConnection(connection, context.runtime.credential);
      }
      for (const selection of experiment.metrics) components.metrics.push(await create("metrics", selection, runtime));
      return { owned: components, experiment, runtime, secrets, network, sourceConfig, dispose };
    } catch (error) { await dispose(); throw error; }
  }

  async function openSingle(config: Readonly<WorkflowObject>, context: WorkflowContext, connection?: RayConnection): Promise<BenchmarkSession> {
    const { owned, experiment, runtime, secrets, sourceConfig, dispose } = await assemble(config, context, true, connection);
    const benchmark = owned.benchmark;
    try {
      for (const decorate of ctx.evaluator.prepareStoreDecorators(parsePluginActivations(config.plugins))) {
        owned.store = await (await decorate({ ...runtime, signal: context.signal }))(owned.store);
      }
      const root = join(context.runtime.directory, "benchmark-evidence");
      const directory = join(root, context.runId);
      let exists = true;
      try { await access(join(directory, "manifest.json")); }
      catch (error) { if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") throw error; exists = false; }
      const fingerprint = workflowDigest(config);
      const previous = exists ? await owned.store.open(directory) : undefined;
      if (previous && (previous.configFingerprint !== fingerprint || previous.runId !== context.runId)) throw new TypeError("Benchmark evidence belongs to a different plan");
      const bound = bindSolverService(runtime);
      const configSummary = workflowValue({ model: bound.model.name, api: bound.model.api, provider: bound.model.provider,
        hardware: experiment.hardware ?? "npu", benchmark: experiment.benchmark.name, environment: experiment.environment.name,
        solver: experiment.solver.name, scheduler: experiment.scheduler.name, metrics: experiment.metrics.map(metric => metric.name),
        reporter: experiment.reporter.name, run: experiment.run });
      const provenance = await resolveSolverProvenance(owned.solver, context.signal, secrets, previous?.solverProvenance);
      if (previous) assertResumeSolverProvenance(previous.solverProvenance, provenance);
      else await owned.store.create(root, { schemaVersion: 1, runId: context.runId, source: null, taskIds: [],
        configFingerprint: fingerprint, pluginVersions: owned.pluginVersions, configSummary, identity: await loadRunIdentity(), evaluationKind: benchmark.evaluationKind ?? "quality",
        ...(provenance ? { solverProvenance: provenance } : {}),
        startedAt: new Date().toISOString(), finishedAt: null, durationMs: null, status: "running" }, workflowValue(sourceConfig));
      let source: SourceLock | undefined;
      const refs = new Map<string, TaskRef>();
      let schedulerReady = false;
      let preparation: Awaited<ReturnType<typeof prepareBenchmarkSelection>> | undefined;
      let preparing: ReturnType<typeof prepareBenchmarkSelection> | undefined;
      const preparationFailure = new AbortController();
      const started = new Set<string>(), retried = new Map<string, TaskPreparation>();
      const prepareAttempt = async (unit: ExecutionUnitIdentity, attemptId: string, signal: AbortSignal) => {
        const retry = started.has(unit.caseId);
        started.add(unit.caseId);
        if (!retry || !benchmark.planRun) return false;
        const ref = refs.get(unit.caseId);
        if (!source || !ref) throw new TypeError("Retry requires a selected Benchmark case");
        retried.set(ref.id, await prepareRetryTask({ runId: context.runId, taskId: ref.id, attemptId, ref, configFingerprint: fingerprint },
          { components: owned, source, signal, run: experiment.run, sensitiveValues: secrets,
            onProgress: event => context.log(event.message, event) }));
        return true;
      };
      const completedIds = new Set<string>(), preparedIds = new Set<string>();
      const observe: import("../../../core/progress/progress.js").ProgressListener = event => {
        if (event.taskId && event.live?.status === "completed" && event.live.preparation) preparedIds.add(event.taskId);
        context.log(event.message, event);
      };
      const completed = (record: AttemptRecord) => {
        completedIds.add(record.key.taskId);
        const message = `Finished: ${attemptStatus(record)}${attemptTimeoutKind(record) ? ` (${attemptTimeoutKind(record)})` : ""}; score=${evaluationScore(record) ?? "none"}; progress ${completedIds.size}/${refs.size}`;
        context.log(message, { phase: "task", taskId: record.key.taskId, attemptId: record.key.attemptId,
          taskNumber: [...refs.keys()].indexOf(record.key.taskId) + 1, taskTotal: refs.size,
          summary: { total: refs.size, prepared: preparedIds.size, completed: completedIds.size }, message });
        if (requiresDispatchStop(record) || hasUnconfirmedCleanup(record))
          preparationFailure.abort(new Error(`Task requires dispatch to stop: ${record.errors.map(error => error.message).join("; ")}`));
      };
      let closing: Promise<void> | undefined;
      const close = () => closing ??= (async () => {
        try {
          try { await preparing; await preparation?.close(); }
          finally {
            const snapshot = await owned.store.snapshot();
            if (snapshot.run.status === "running") await owned.store.updateRun({
              status: context.signal.aborted ? "cancelled" : snapshot.run.source ? resolveRunStatus(snapshot) : "error",
              finishedAt: new Date().toISOString(), durationMs: Math.max(0, Date.now() - Date.parse(snapshot.run.startedAt)),
            });
          }
        } finally { await dispose(); }
      })();
      return {
        failureSignal: preparationFailure.signal,
        completed,
        prepareAttempt,
        recoveryIdentity: { config: workflowValue(config), directory: context.runtime.directory, network: requireNetwork(context.resource("network")).document.template },
        async reconcile(unit, block, active) {
          const commit = block.steps.at(-1);
          if (commit?.kind !== "step" || commit.use !== "benchmark.commit" ||
              workflowDigest(block.outputs) !== workflowDigest({ scores: { ref: `${commit.id}.outputs.scores` }, evidence: { ref: `${commit.id}.outputs.evidence` } })) return undefined;
          const record = owned.store.currentTaskResult ? await owned.store.currentTaskResult(unit.caseId)
            : (await owned.store.snapshot()).records.find(record => record.key.taskId === unit.caseId);
          if (!record || !isEvaluationComplete(record)) return undefined;
          if (record.key.runId !== context.runId || record.key.attemptId !== unit.attemptId)
            throw new TypeError("Committed Benchmark result belongs to a different attempt");
          if (!owned.store.readAttemptEvidence) throw new TypeError("Benchmark store cannot restore committed attempt evidence");
          const evidence = await owned.store.readAttemptEvidence(record.key);
          if (workflowDigest(evidence.record) !== workflowDigest(record)) throw new TypeError("Benchmark evidence changed during recovery");
          return benchmarkScoreOutputs(record, await exportBenchmarkEvidence(evidence, active.artifacts));
        },
        async reuseInputs(unit) {
          const ref = refs.get(unit.caseId);
          if (!source || !ref) throw new TypeError("Benchmark reuse requires its locked case selection");
          return workflowObject({ source, ref, config: fingerprint, provenance: provenance ?? null });
        },
        async remoteSelection(unit) {
          if (!source) throw new TypeError("Select Benchmark cases before exporting execution metadata");
          const portable = { ...sourceConfig };
          for (const role of ["benchmark", "environment", "solver", "verifier"] as const) if (experiment[role])
            portable[role] = workflowValue(projectPortableSelection(experiment[role], role,
              (role, name) => nativeResourceTransport(ctx.evaluator.workflows, role, name)));
          portable.scheduler = { name: "local", config: { concurrency: 1 } };
          portable.store = { name: "local", config: {} };
          portable.output = { directory: "results" };
          const tasks = [];
          for (const ref of refs.values()) {
            if (unit && ref.id !== unit.caseId) continue;
            const ready = retried.get(ref.id) ?? (preparation ? await preparation.get(ref.id, context.signal) : undefined);
            tasks.push({ ref, failure: ready?.state === "failed" ? ready.failure : null,
              preparation: owned.scheduler instanceof RayScheduler ? owned.scheduler.preparation(ref.id) ?? null : null });
          }
          return [workflowObject({ variantId: "default", repetition: 0, runId: context.runId, source, fingerprint,
            config: { experiment: portable }, provenance: (await owned.store.snapshot()).run.solverProvenance ?? null, tasks })];
        },
        async shouldRetry(attempt, signal) {
          signal.throwIfAborted();
          const saved = (await owned.store.listAttempts()).find(item => item.key.attemptId === attempt.attemptId && item.key.taskId === attempt.caseId)?.record;
          return saved !== null && saved !== undefined && isStreamTaskRetryEligible(saved);
        },
        placement(unit) { return owned.scheduler instanceof RayScheduler ? owned.scheduler.preparation(unit.caseId)?.nodeId : undefined; },
        async admit(unit, attemptId) {
          await owned.store.updateRun({ status: "running", finishedAt: null, durationMs: null });
          await owned.store.allocate({ runId: context.runId, taskId: unit.caseId, attemptId });
        },
        async import(unit, attemptId, artifacts, reader) {
          await importBenchmarkEvidence({ runId: context.runId, taskId: unit.caseId, attemptId }, artifacts, reader, owned.store,
            join(context.runtime.directory, ".imports"), completed);
        },
        async validateResume(signal) {
          const snapshot = await owned.store.snapshot();
          if (previous?.status === "completed" && (snapshot.pendingTaskIds.length || snapshot.records.some(record => !isEvaluationComplete(record))))
            throw new TypeError("Completed Benchmark evidence is missing or no longer valid");
          if (!benchmark.validateSourceOnCompletedResume || !previous?.source) return;
          const current = await benchmark.resolveSource(previous.source, signal);
          if (workflowDigest(current) !== workflowDigest(previous.source)) throw new TypeError("Benchmark source changed since the original run");
        },
        async select(signal) {
          const observe: import("../../../core/progress/progress.js").ProgressListener = event => context.log(event.message, event);
          try {
            source = await progressOperation(observe, { phase: "source", message: `Preparing dataset ${experiment.benchmark.name}` }, signal,
              activity => benchmark.resolveSource(previous?.source ?? null, signal, activity));
          } catch (error) {
            const failure = classifyError(error, { phase: "prepare", component: "source", secrets });
            await owned.store.updateRun({ failure });
            observe({ phase: "source", error: true, failure, message: failureMessage(failure) });
            throw error;
          }
          if (previous?.source && workflowDigest(source) !== workflowDigest(previous.source)) throw new TypeError("Benchmark source changed since the original run");
          const selectedSource = source;
          const selected = await progressOperation(observe, { phase: "enumerate", message: "Reading selected tasks" }, signal,
            activity => enumerateSelectedTasks(benchmark, selectedSource, experiment.run, signal, activity));
          refs.clear();
          for (const ref of selected.selected) refs.set(ref.id, ref);
          const ids = [...refs.keys()];
          if (previous?.source && workflowDigest(ids) !== workflowDigest(previous.taskIds)) throw new TypeError("Benchmark selection changed since the original run");
          const locked = (await owned.store.snapshot()).run;
          if (locked.source) {
            if (workflowDigest(source) !== workflowDigest(locked.source) || workflowDigest(ids) !== workflowDigest(locked.taskIds))
              throw new TypeError("Benchmark selection differs from its locked evidence");
          } else await owned.store.updateRun({ source, taskIds: ids });
          await owned.store.updateRun({ failure: null });
          for (const record of (await owned.store.snapshot()).records) if (isEvaluationComplete(record)) completedIds.add(record.key.taskId);
          return ids.map(id => ({ id }));
        },
        async prepare(active) {
          if (!source) throw new TypeError("Select cases before preparing Benchmark dependencies");
          if (owned.scheduler.executionLocation === "remote" && !schedulerReady) {
            if (!owned.scheduler.setupPreparation) throw new TypeError("Remote Benchmark requires scheduler preparation setup");
            const manifest = (await owned.store.snapshot()).run;
            await owned.scheduler.setupPreparation({ session: { runId: context.runId, source, configFingerprint: fingerprint,
              pluginVersions: owned.pluginVersions, ...(manifest.solverProvenance ? { solverProvenance: manifest.solverProvenance } : {}) },
              safeConfig: workflowValue(sourceConfig), log: active.log, onProgress: event => active.log(event.message, event) }, active.signal);
            schedulerReady = true;
          }
          await preparation?.close();
          const reusable = new Set((await owned.store.snapshot()).records.filter(isEvaluationComplete).map(record => record.key.taskId));
          preparing = prepareBenchmarkSelection(owned, [...refs.values()], source, experiment.run, { ...active, log: (message, event) => event ? observe(event) : active.log(message) }, fingerprint, secrets,
            error => preparationFailure.abort(error), reusable);
          preparation = await preparing;
          return preparation.caseIds.map(id => ({ id }));
        },
        async *order(units, signal) {
          if (!preparation) { yield* units; return; }
          const cases = [...new Set(units.map(unit => unit.caseId))];
          for await (const id of preparation.order(cases, signal))
            for (const unit of units) if (unit.caseId === id) yield unit;
        },
        async report() {
          await saveReport(owned.store, owned.metrics, owned.reporter);
          return `# Benchmark report\n\n[Open the complete report](../../benchmark-evidence/${context.runId}/report.md)\n`;
        },
        async attempt(taskId, active) {
          const ref = refs.get(taskId);
          if (!source || !ref) throw new TypeError(`Benchmark sample ${taskId} has not been selected`);
          if (!active.unit) throw new TypeError("Benchmark attempts require an execution unit");
          await prepareAttempt(active.unit, active.attemptId, active.signal);
          return await createBenchmarkAttempt({ job: { runId: context.runId, taskId, attemptId: active.attemptId, ref, configFingerprint: fingerprint }, preparation: retried.get(taskId) ?? (preparation ? await preparation.get(taskId, active.signal) : { state: "on-demand" }) },
            owned, source, active.signal, { timeoutSeconds: experiment.run.timeoutSeconds,
              ...(experiment.run.scoreAfterSolveTimeout === undefined ? {} : { scoreAfterSolveTimeout: experiment.run.scoreAfterSolveTimeout }),
              ...(experiment.run.solveTimeoutSeconds === undefined ? {} : { solveTimeoutSeconds: experiment.run.solveTimeoutSeconds }),
              ...(experiment.run.verifyTimeoutSeconds === undefined ? {} : { verifyTimeoutSeconds: experiment.run.verifyTimeoutSeconds }),
              ...(experiment.run.preparation?.environmentTimeoutSeconds === undefined ? {} : { environmentTimeoutSeconds: experiment.run.preparation.environmentTimeoutSeconds }),
              includeTaskAnswer: experiment.run.includeTaskAnswer === true, sensitiveValues: secrets,
              onProgress: event => observe({ ...event, taskNumber: [...refs.keys()].indexOf(taskId) + 1, taskTotal: refs.size }) });
        },
        async recover(key, signal) {
          const keys = (await owned.store.listAttempts()).filter(item => item.key.attemptId === key.attemptId && item.key.taskId === key.taskId).map(item => item.key);
          if (keys.length) {
            if (!owned.environment.recoverAttempts) throw new Error("Environment does not support recovery of interrupted Benchmark attempts");
            await owned.environment.recoverAttempts(keys, signal);
            if (benchmark.verificationRuntime) {
              if (!benchmark.verificationRuntime.recoverAttempts) throw new Error("Verifier does not support recovery of interrupted attempts");
              await benchmark.verificationRuntime.recoverAttempts(keys, signal);
            }
          }
        },
        async metrics() {
          const before = await owned.store.snapshot();
          await owned.store.updateRun({ status: resolveRunStatus(before), finishedAt: new Date().toISOString(),
            durationMs: Math.max(0, Date.now() - Date.parse(before.run.startedAt)) });
          const snapshot = await owned.store.snapshot();
          const metrics: WorkflowObject = {};
          for (const metric of owned.metrics) {
            metrics[metric.name] = workflowValue(await metric.compute(snapshot));
          }
          return metrics;
        }, close,
      };
    } catch (error) { await dispose(); throw error; }
  }

  async function open(config: Readonly<WorkflowObject>, context: WorkflowContext, connection?: RayConnection): Promise<BenchmarkSession> {
    const repetitions = expectPositiveInteger(config.repetitions ?? 1, "benchmark repetitions");
    if (config.variants === undefined && repetitions === 1) return openSingle(config, context, connection);
    const variants = Array.isArray(config.variants) ? config.variants.map(value => workflowObject(value)) : [{ id: "default", experiment: config.experiment ?? null }];
    const groups: { variantId: string; repetition: number; runId: string; path: string; pipeline: boolean;
      prepared?: Promise<void>; session: BenchmarkSession }[] = [];
    let preparing: WorkflowContext | undefined;
    const prepare = async (group: typeof groups[number]) => {
      if (preparing) await (group.prepared ??= group.session.prepare({ ...preparing, runId: group.runId }).then(() => {}));
    };
    const close = async () => {
      const results = await Promise.allSettled(groups.map(group => group.session.close()));
      const errors = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
      if (errors.length) throw new AggregateError(errors, "Benchmark groups failed to close");
    };
    try {
      for (const variant of variants) for (let repetition = 0; repetition < repetitions; repetition++) {
        const variantId = expectNonEmptyString(variant.id, "variant ID");
        const path = `benchmark-groups/${variantId}/repeat-${repetition}`;
        const runId = `${context.runId}-${workflowDigest({ variantId, repetition }).slice(0, 16)}`;
        const session = await openSingle({ ...config, experiment: variant.experiment ?? null }, { ...context, runId,
          runtime: { ...context.runtime, directory: join(context.runtime.directory, path) } }, connection);
        groups.push({ variantId, repetition, runId, path, session,
          pipeline: parseEffectiveConfig(workflowObject(variant.experiment)).run.preparation?.mode === "pipeline" });
      }
      const groupFor = (unit: ExecutionUnitIdentity) => {
        const group = groups.find(group => group.variantId === unit.variantId && group.repetition === unit.repetition);
        if (!group) throw new TypeError("Benchmark execution identity does not select a configured group");
        return group;
      };
      let selected: WorkflowObject[] = [];
      return {
        failureSignal: AbortSignal.any(groups.map(group => group.session.failureSignal)),
        completed(record) {
          const group = groups.find(group => group.runId === record.key.runId);
          if (!group) throw new TypeError("Benchmark result does not belong to a configured group");
          group.session.completed(record);
        },
        recoveryIdentity: { config: workflowValue(config), directory: context.runtime.directory, network: requireNetwork(context.resource("network")).document.template },
        async remoteSelection(unit) {
          const result = [];
          for (const group of groups) {
            if (unit && (unit.variantId !== group.variantId || unit.repetition !== group.repetition)) continue;
            for (const entry of await group.session.remoteSelection(unit))
            result.push({ ...entry, variantId: group.variantId, repetition: group.repetition });
          }
          return result;
        },
        async reconcile(unit, block, active) { return groupFor(unit).session.reconcile?.(unit, block, active); },
        prepareAttempt(unit, attemptId, signal) { return groupFor(unit).session.prepareAttempt(unit, attemptId, signal); },
        reuseInputs(unit) { return groupFor(unit).session.reuseInputs(unit); },
        shouldRetry(attempt, signal) { return groupFor(attempt).session.shouldRetry(attempt, signal); },
        placement(unit) { return groupFor(unit).session.placement(unit); },
        admit(unit, attemptId) { return groupFor(unit).session.admit(unit, attemptId); },
        import(unit, attemptId, artifacts, reader) { return groupFor(unit).session.import(unit, attemptId, artifacts, reader); },
        async select(signal) {
          for (const [index, group] of groups.entries()) {
            const cases = await group.session.select(signal);
            if (index === 0) selected = cases;
            else if (workflowDigest(cases) !== workflowDigest(selected)) throw new TypeError("Benchmark variants selected different cases");
          }
          return selected;
        },
        async prepare(active) {
          preparing = active;
          for (const group of groups) if (!group.pipeline) {
            await prepare(group);
            if (group.session.failureSignal.aborted) break;
          }
          return selected;
        },
        async *order(units, signal) {
          for (const group of groups) {
            await prepare(group);
            yield* group.session.order(units.filter(unit => unit.variantId === group.variantId && unit.repetition === group.repetition), signal);
          }
        },
        async attempt(taskId, active) {
          const group = groups.find(group => group.variantId === active.unit?.variantId && group.repetition === active.unit.repetition);
          if (!group) throw new TypeError("Benchmark execution identity does not select a configured group");
          await prepare(group);
          return group.session.attempt(taskId, active);
        },
        async metrics() {
          const metrics = [];
          for (const group of groups) metrics.push({ variantId: group.variantId, repetition: group.repetition, metrics: await group.session.metrics() });
          return { groups: metrics };
        },
        async report(metrics) {
          const links: string[] = [];
          for (const group of groups) {
            await group.session.report(metrics);
            links.push(`- [${group.variantId}, repetition ${group.repetition}](../../${group.path}/benchmark-evidence/${group.runId}/report.md)`);
          }
          return `# Benchmark reports\n\n${links.join("\n")}\n`;
        },
        async validateResume(signal) { for (const group of groups) await group.session.validateResume(signal); },
        async recover(key, signal) { for (const group of groups) await group.session.recover(key, signal); },
        close,
      };
    } catch (error) { await close(); throw error; }
  }

  registerRemoteBenchmarkAttempt(ctx, async (config, context) => {
    const node = await benchmarkNodeConfig();
    const experiment = parseEffectiveConfig(workflowObject(config.experiment));
    const localized = workflowObject(config.experiment);
    // Native solvers receive authentication through their factory context; child processes must not inherit it.
    for (const raw of Object.values(workflowObject(localized.services))) {
      const service = workflowObject(raw);
      if (typeof service.apiKeyEnv === "string") delete process.env[service.apiKeyEnv];
    }
    for (const role of ["benchmark", "environment", "solver", "verifier"] as const) if (experiment[role])
      localized[role] = workflowValue(localizePortableSelection(experiment[role], role, node,
        (role, name) => nativeResourceTransport(ctx.evaluator.workflows, role, name)));
    return assemble({ experiment: localized }, context);
  });

  ctx.evaluator.registerResource({ type: "benchmark.ray-executor", apiVersion: 1, version: "1", capabilities: ["workflow.executor/v1"],
    resources: { runtime: { capability: "benchmark.runtime/v1" }, executor: { capability: "ray.executor/v1" } }, validateConfig(value) {
      const config = workflowObject(value);
      rejectUnknown(config, ["selectionBinding"], "benchmark.ray-executor");
      expectNonEmptyString(config.selectionBinding, "selectionBinding");
      return config;
    },
    async create(config, context) {
      const runtime = session(context.resource("runtime"));
      const executor = context.resource("executor") as WorkflowUnitExecutor;
      return { identity: { kind: "coordinator" }, value: {
        async prepare(request, host) {
          const refreshed = await runtime.prepareAttempt(request.unit, request.unit.attemptId, host.signal);
          const bindings = { ...request.bindings };
          if (refreshed) {
            const selection = await host.artifacts.write("selection.json", JSON.stringify({ groups: await runtime.remoteSelection(request.unit) }),
              { protocol: "arsi.benchmark-selection/v1", mediaType: "application/json", visibility: "private" });
            bindings[String(config.selectionBinding)] = workflowValue(selection);
          }
          const nodeId = runtime.placement(request.unit);
          return { bindings, ...(nodeId === undefined ? {} : { nodeId }) };
        },
        recoveryIdentity(request: WorkflowUnitRequest) { return executor.recoveryIdentity(request); },
        async execute(request: WorkflowUnitRequest, host: Parameters<WorkflowUnitExecutor["execute"]>[1]) {
          await runtime.admit(request.unit, request.unit.attemptId);
          const result = await executor.execute(request, host);
          await runtime.import(request.unit, request.unit.attemptId, result.artifacts, host.store.artifacts(request.path));
          return result;
        },
      } satisfies WorkflowUnitExecutor };
    },
    async recover(identity, context) {
      if (identity.kind === "coordinator") return;
      const provider = ctx.evaluator.workflows.resource("executor.ray");
      if (!provider.recover) throw new TypeError("Ray executor cannot recover interrupted dispatch");
      await provider.recover(identity, context);
    },
  });
  ctx.evaluator.registerStep({ type: "benchmark.prepare-remote", apiVersion: 1, version: "1", effects: "isolated-write",
    inputs: { cases: jsonPort("arsi.cases/v1") }, outputs: { cases: jsonPort("arsi.cases/v1"),
      selection: { ...jsonPort("arsi.benchmark-selection/v1"), visibility: "private" } },
    resources: { runtime: { capability: "benchmark.runtime/v1" } }, validateConfig: noConfig,
    async execute(_inputs, _config, context) {
      const runtime = session(context.resource("runtime"));
      const cases = await runtime.prepare(context);
      const selection = await context.artifacts.write("selection.json", JSON.stringify({ groups: await runtime.remoteSelection() }),
        { protocol: "arsi.benchmark-selection/v1", mediaType: "application/json", visibility: "private" });
      return { cases, selection: workflowValue(selection) };
    },
  });

  ctx.evaluator.registerResource({ type: "native.context", apiVersion: 1, version: "1", sharing: "shared",
    capabilities: ["native.factory-context/v1"], resources: { network: { capability: "network.access/v1" } }, validateConfig: settings, credentials: benchmarkCredentials,
    async create(config, context) {
      const { runtime } = await factoryRuntime(config, context);
      return { value: runtime, identity: {} };
    }, async recover() {},
  });

  async function maintainBenchmark(config: Readonly<WorkflowObject>, request: Readonly<WorkflowObject>, context: WorkflowContext,
    operation: "doctor" | "cleanup-images"): Promise<import("../../../core/contracts/workflow.js").WorkflowMaintenanceOutcome> {
    const variants = Array.isArray(config.variants) ? config.variants.map(value => workflowObject(value)) : [{ id: "default", experiment: config.experiment ?? null }];
    const groups: WorkflowObject[] = [];
    let status: "passed" | "failed" | "incomplete" = "passed";
    for (const variant of variants) {
      context.signal.throwIfAborted();
      const settings = { experiment: variant.experiment ?? null };
      // Doctor checks component combinations before launching external diagnostics.
      // Factories validate and allocate their own resources but never execute evaluation work.
      const credentials = operation === "doctor" ? await Promise.all(benchmarkCredentials(settings).map(async name => ({
        name: `credential ${name}`, status: await context.runtime.credential(name) ? "passed" as const : "failed" as const,
        detail: "Credential availability; no model request was sent",
      }))) : [];
      const assembled = operation === "doctor" && credentials.every(check => check.status === "passed")
        ? await assemble(settings, context, false) : undefined;
      try {
        const { experiment, runtime, sourceConfig, network } = assembled ?? await factoryRuntime(settings, context, false);
        if (operation === "doctor") {
          const loaded = { experiment, persisted: workflowValue(sourceConfig), network: network.document,
            auths: Object.fromEntries(Object.entries(runtime.services).map(([name, binding]) => [name, binding.auth])) };
          const file = context.runtime.origins?.configurationFile;
          const checks = await diagnose(loaded, context.runtime.resolvePath("."), context.signal);
          checks.push(...credentials);
          const downloads = await diagnoseDownloads({ config: loaded, configDirectory: context.runtime.resolvePath("."),
            ...(file ? { configPath: file } : {}), ...(context.runtime.origins?.patchFile ? { patchPath: context.runtime.origins.patchFile } : {}) }, context.signal, context.log, network);
          if (checks.some(check => check.status === "failed") || downloads.status === "failed") status = "failed";
          else if (downloads.status === "incomplete" && status !== "failed") status = "incomplete";
          groups.push(workflowObject({ id: variant.id, checks, network: downloads }));
        } else {
          const releases: (() => Promise<void>)[] = [];
          try {
            const scheduler = await openNativeResource(ctx, "scheduler", experiment.scheduler, runtime, context.runtime.credential);
            releases.push(scheduler.dispose);
            const cleanup = { all: request.all === true, execute: request.execute === true, ...(runtime.imageConfigFingerprint ? { configFingerprint: runtime.imageConfigFingerprint } : {}) };
            let nodes: import("../../../core/contracts/image-cleanup.js").ImageCleanupNode[];
            if (scheduler.value.executionLocation === "remote") {
              if (!scheduler.value.cleanupImages) throw new Error("Scheduler does not support image cleanup");
              nodes = await scheduler.value.cleanupImages(cleanup, experiment.environment,
                Object.fromEntries(Object.entries(context.plan?.sources ?? {}).filter(([name]) => !name.startsWith("template:"))), context.signal);
            } else {
              const environment = await openNativeResource(ctx, "environment", experiment.environment, runtime, context.runtime.credential);
              releases.push(environment.dispose);
              if (!environment.value.cleanupImages) throw new Error("Environment does not support image cleanup");
              nodes = [await environment.value.cleanupImages(cleanup, context.signal)];
            }
            if (nodes.some(node => node.error || node.items.some(item => item.status === "failed"))) status = "failed";
            groups.push(workflowObject({ id: variant.id, preview: !request.execute, nodes }));
          } finally {
            const errors: unknown[] = [];
            for (const release of releases.reverse()) try { await release(); } catch (error) { errors.push(error); }
            if (errors.length) throw new AggregateError(errors, "Maintenance components failed to close");
          }
        }
      } finally { await assembled?.dispose(); }
    }
    return { status, output: { groups } };
  }

  const runtimeProvider: ResourceProvider = {
    type: "benchmark.runtime", apiVersion: 1, version: "1", capabilities: ["benchmark.runtime/v1", "workflow.admission/v1", "workflow.retry/v1"], sharing: "shared", resources: { network: { capability: "network.access/v1" }, connection: { capability: "ray.connection/v1", optional: true } }, validateConfig: settings, credentials: benchmarkCredentials,
    maintenance: {
      preview: {
        resources: ["network"], validateRequest: noConfig,
        credentials(config) {
          const variants = Array.isArray(config.variants) ? config.variants.map(value => workflowObject(value).experiment) : [config.experiment];
          return [...new Set(variants.flatMap(value => {
            const experiment = parseEffectiveConfig(workflowObject(value));
            return (["benchmark", "verifier"] as const).flatMap(role => {
              const selection = experiment[role];
              if (!selection) return [];
              const provider = ctx.evaluator.workflows.resource(`native.${role}.${selection.name}`);
              return provider.credentials?.(provider.validateConfig(selection.config)) ?? [];
            });
          }))];
        },
        async execute(config, _request, context) {
          const variants = Array.isArray(config.variants) ? config.variants.map(value => workflowObject(value)) : [{ id: "default", experiment: config.experiment ?? null }];
          const groups: WorkflowObject[] = [];
          for (const variant of variants) {
            const { experiment, runtime } = await factoryRuntime({ experiment: variant.experiment ?? null }, context, false);
            const releases: (() => Promise<void>)[] = [];
            try {
              const verifier = experiment.verifier ? await openNativeResource(ctx, "verifier", experiment.verifier,
                { ...runtime, ...(experiment.verifier.service ? { verifierService: experiment.verifier.service } : {}) }, context.runtime.credential) : undefined;
              if (verifier) releases.push(verifier.dispose);
              const benchmark = await openNativeResource(ctx, "benchmark", experiment.benchmark,
                { ...runtime, ...(verifier ? { verifier: verifier.value } : {}) }, context.runtime.credential);
              releases.push(benchmark.dispose);
              benchmark.value.validateRun?.(experiment);
              const source = await benchmark.value.resolveSource(null, context.signal);
              const { selected } = await enumerateSelectedTasks(benchmark.value, source, experiment.run, context.signal);
              groups.push({ id: variant.id ?? "default", taskIds: selected.map(task => task.id) });
            } finally {
              const errors: unknown[] = [];
              for (const release of releases.reverse()) try { await release(); } catch (error) { errors.push(error); }
              if (errors.length) throw new AggregateError(errors, "Preview components failed to close");
            }
          }
          return { status: "passed", output: { groups } };
        },
      },
      doctor: { resources: ["network"], credentials: benchmarkCredentials, validateRequest: noConfig, execute: (config, request, context) => maintainBenchmark(config, request, context, "doctor") },
      "cleanup-images": {
        resources: ["network"],
        validateRequest(value) {
          const request = workflowObject(value);
          rejectUnknown(request, ["all", "execute"], "image cleanup");
          for (const field of ["all", "execute"]) if (request[field] !== undefined && typeof request[field] !== "boolean") throw new TypeError(`${field} must be boolean`);
          return { all: request.all ?? false, execute: request.execute ?? false };
        },
        execute: (config, request, context) => maintainBenchmark(config, request, context, "cleanup-images"),
      },
    },
    async warmup(config, context) {
      if (Array.isArray(config.variants)) {
        const groups: WorkflowMaintenanceOutcome[] = [];
        for (const value of config.variants) {
          const variant = workflowObject(value);
          const outcome = await runtimeProvider.warmup?.({ experiment: variant.experiment ?? null }, context);
          if (outcome) groups.push({ ...outcome, summary: `${variant.id}: ${outcome.summary ?? outcome.status}`,
            details: outcome.details?.map(line => `${variant.id}/${line}`) ?? [] });
        }
        return { status: groups.some(group => group.status !== "passed") ? "failed" : "passed",
          output: workflowObject({ groups }), summary: groups.map(group => group.summary).join("\n"), details: groups.flatMap(group => group.details ?? []) };
      }
      const connection = context.resource("connection");
      if (connection !== undefined && !(connection instanceof RayConnection)) throw new TypeError("Benchmark requires its declared Ray connection");
      const { owned, experiment, runtime, sourceConfig, secrets, dispose } = await assemble(config, context, false, connection);
      let release: (() => Promise<void>) | undefined;
      try {
        release = await owned.environment.acquireImageLease?.(context.signal);
        const result = await warmupSelectedTasks(owned, { experiment, persisted: workflowValue(sourceConfig),
          auths: Object.fromEntries(Object.entries(runtime.services).map(([name, binding]) => [name, binding.auth])) }, context.signal,
          event => context.log(event.message, event), secrets);
        return { status: result.status === "ready" ? "passed" : "failed", output: workflowObject(result),
          summary: `Image warmup: ${result.readyTaskIds.length}/${result.taskIds.length} tasks ready; ${result.failures.length} failed`,
          details: result.failures.map(item => `${item.taskId}: ${failureMessage(item.failure)}`) };
      } finally { try { await release?.(); } finally { await dispose(); } }
    },
    async create(config, context) {
      const identity = { config: workflowValue(config), directory: context.runtime.directory, network: requireNetwork(context.resource("network")).document.template };
      await context.checkpoint(identity);
      const connection = context.resource("connection");
      if (connection !== undefined && !(connection instanceof RayConnection)) throw new TypeError("Benchmark requires its declared Ray connection");
      const value = await open(config, context, connection);
      return { identity, value, dispose: () => value.close() };
    },
    async recover(identity, context) {
      if (identity.directory !== context.runtime.directory) throw new TypeError("Benchmark recovery workspace changed");
      await withRecoveryNetwork(workflowValue(identity.network), context, async active => {
        const value = await open(settings(identity.config), active);
        await value.close();
      });
    },
    async validateResume(identity, context) {
      await withRecoveryNetwork(workflowValue(identity.network), context, async active => {
        const value = await open(settings(identity.config), active);
        try { await value.validateResume(active.signal); } finally { await value.close(); }
      });
    },
  };
  ctx.evaluator.registerResource(runtimeProvider);
  ctx.evaluator.registerResource({ type: "benchmark.attempt", apiVersion: 1, version: "1", capabilities: ["benchmark.attempt/v1"],
    resources: { runtime: { capability: "benchmark.runtime/v1" } }, validateConfig(value) {
      const config = workflowObject(value); rejectUnknown(config, ["taskId"], "benchmark.attempt"); expectNonEmptyString(config.taskId, "taskId"); return config;
    },
    async create(config, context) {
      const runtime = session(context.resource("runtime"));
      const identity = { ...runtime.recoveryIdentity, runId: context.runId, taskId: String(config.taskId), attemptId: context.attemptId };
      await context.checkpoint(identity);
      const driver = await runtime.attempt(String(config.taskId), context);
      return { identity, ...benchmarkAttemptResource(driver, context, record => runtime.completed(record)) };
    },
    async recover(identity, context) {
      if (identity.directory !== context.runtime.directory || identity.runId !== context.runId || identity.attemptId !== context.attemptId)
        throw new TypeError("Benchmark attempt recovery ownership differs");
      await withRecoveryNetwork(workflowValue(identity.network), context, async active => {
        const value = await open(settings(identity.config), active);
        try { await value.recover({ runId: active.runId, attemptId: active.attemptId, taskId: expectNonEmptyString(identity.taskId, "recovery taskId") }, active.signal); }
        finally { await value.close(); }
      });
    },
  });
  for (const operation of benchmarkOperations) ctx.evaluator.registerResource({
    type: `benchmark.${operation}`, apiVersion: 1, version: "1", capabilities: [`benchmark.${operation}/v1`],
    resources: { attempt: { capability: "benchmark.attempt/v1" } }, validateConfig: noConfig,
    async create(_config, context) { return { identity: {}, value: attemptHandle(context.resource("attempt")).actions[operation] }; }, async recover() {},
  });
  for (const step of benchmarkOperationSteps) ctx.evaluator.registerStep(step);
  ctx.evaluator.registerStep({ type: "benchmark.select", apiVersion: 1, version: "1", effects: "read", inputs: {}, outputs: { cases: jsonPort("arsi.cases/v1") },
    resources: { runtime: { capability: "benchmark.runtime/v1" } }, validateConfig: noConfig,
    async execute(_inputs, _config, context) { return { cases: await session(context.resource("runtime")).select(context.signal) }; },
  });
  ctx.evaluator.registerStep({ type: "benchmark.prepare-selection", apiVersion: 1, version: "1", effects: "isolated-write",
    inputs: { cases: jsonPort("arsi.cases/v1") }, outputs: { cases: jsonPort("arsi.cases/v1") },
    resources: { runtime: { capability: "benchmark.runtime/v1" } }, validateConfig: noConfig,
    async execute(_inputs, _config, context) { return { cases: await session(context.resource("runtime")).prepare(context) }; },
  });
  ctx.evaluator.registerStep({ type: "benchmark.report", apiVersion: 1, version: "1", effects: "isolated-write",
    inputs: { metrics: jsonPort("arsi.metrics/v1") }, outputs: { report: jsonPort("arsi.artifact/v1") },
    resources: { runtime: { capability: "benchmark.runtime/v1" } }, validateConfig: validateBenchmarkReport, report: benchmarkOfflineReport(ctx),
    async execute(inputs, _config, context) {
      const content = await progressOperation(event => context.log(event.message, event), { phase: "report", message: "Writing Benchmark report" }, context.signal,
        () => session(context.resource("runtime")).report(workflowObject(inputs.metrics)));
      return { report: workflowValue(await context.artifacts.write("report.md", content, { mediaType: "text/markdown", protocol: "arsi.artifact-markdown/v1" })) };
    },
  });
  ctx.evaluator.registerStep({ type: "benchmark.commit", apiVersion: 1, version: "1", effects: "isolated-write", inputs: {},
    outputs: { scores: scoreSetPort(), evidence: { ...jsonPort("arsi.benchmark-evidence/v1"), visibility: "private" } },
    resources: { attempt: { capability: "benchmark.attempt/v1" } }, validateConfig: noConfig,
    async execute(_inputs, _config, context) {
      const attempt = attemptHandle(context.resource("attempt"));
      const record = await attempt.driver.finalize();
      const evidence = await attempt.evidence();
      if (!isEvaluationComplete(record)) throw new Error(record.errors[0]?.message ?? "Benchmark attempt has no valid result");
      return benchmarkScoreOutputs(record, evidence);
    },
  });
  ctx.evaluator.registerStep({ type: "benchmark.metrics", apiVersion: 1, version: "1", effects: "read", inputs: {}, outputs: { metrics: jsonPort("arsi.metrics/v1") },
    resources: { runtime: { capability: "benchmark.runtime/v1" } }, validateConfig: noConfig,
    async execute(_inputs, _config, context) { return { metrics: await session(context.resource("runtime")).metrics() }; },
  });
  function resolveParameters(parameters: WorkflowObject): WorkflowObject {
    const raw = workflowObject(parameters);
    const services = workflowObject(raw.services);
    const credentials: Record<string, string> = {};
    for (const [name, value] of Object.entries(services)) {
      const service = workflowObject(value);
      if (service.api_key !== undefined) throw new TypeError(`services.${name}: use apiKeyEnv`);
      if (service.apiKeyEnv !== undefined) { credentials[name] = expectNonEmptyString(service.apiKeyEnv, `services.${name}.apiKeyEnv`); delete service.apiKeyEnv; }
      services[name] = service;
    }
    raw.services = services;
    const input = parseUserConfig({ ...raw, output: { directory: "results" } });
    const resolved = workflowObject(resolveInput("benchmark.yaml", input, ctx.evaluator.profiles()).source);
    if (resolved.deployment !== undefined) {
      const scheduling = workflowObject(resolved.scheduler);
      resolved.scheduler = { ...scheduling, config: { ...workflowObject(scheduling.config), deployment: "ray-jobs" } };
      const experiment = parseEffectiveConfig(resolved);
      assertCredentialReferences(experiment);
      const lookup = (role: string, name: string) => nativeResourceTransport(ctx.evaluator.workflows, role, name);
      for (const role of ["benchmark", "environment", "solver", "store", "reporter"] as const)
        resolved[role] = workflowObject(projectPortableSelection(experiment[role], role, lookup));
      if (experiment.verifier) resolved.verifier = workflowObject(projectPortableSelection(experiment.verifier, "verifier", lookup));
      resolved.metrics = experiment.metrics.map(selection => workflowObject(projectPortableSelection(selection, "metrics", lookup)));
    }
    const resolvedServices = workflowObject(resolved.services);
    for (const [name, credential] of Object.entries(credentials)) resolvedServices[name] = { ...workflowObject(resolvedServices[name]), apiKeyEnv: credential };
    resolved.services = resolvedServices;
    return resolved;
  }

  ctx.evaluator.registerWorkflow({ type: "benchmark.evaluate", apiVersion: 1, version: "1",
    example: { benchmark: "gsm8k", services: { default: { model: "your-model", base_url: "https://api.example.com/v1", apiKeyEnv: "MODEL_API_KEY" } }, run: { maxTasks: 1 } },
    overrideParameters(parameters, overrides) {
      rejectUnknown(overrides, ["model", "endpoint", "apiKeyEnv", "taskIds"], "Benchmark parameter overrides");
      const result = workflowObject(parameters), services = workflowObject(result.services ?? {});
      // Resolve the selected service using profile metadata; no factories or credentials are opened.
      const { variants: _variants, repetitions: _repetitions, ...input } = result;
      const modelSettings = Object.fromEntries(Object.entries(services).map(([name, value]) => {
        const { apiKeyEnv: _credential, ...model } = workflowObject(value);
        return [name, model];
      }));
      const resolved = resolveInput("benchmark.yaml", parseUserConfig({ ...input, services: modelSettings }), ctx.evaluator.profiles()).source;
      const solver = workflowObject(resolved.solver), selected = typeof solver.service === "string" ? solver.service : "default";
      const model = workflowObject(services[selected] ?? {});
      for (const [key, field] of [["model", "model"], ["endpoint", "base_url"], ["apiKeyEnv", "apiKeyEnv"]] as const)
        if (overrides[key] !== undefined) model[field] = expectNonEmptyString(overrides[key], key);
      if (Object.keys(model).length) services[selected] = model;
      result.services = services;
      if (overrides.taskIds !== undefined) {
        if (!Array.isArray(overrides.taskIds) || !overrides.taskIds.length) throw new TypeError("taskIds must be a nonempty array");
        const taskIds = overrides.taskIds.map(value => expectNonEmptyString(value, "task ID"));
        if (new Set(taskIds).size !== taskIds.length) throw new TypeError("taskIds must not contain duplicates");
        const run = workflowObject(result.run ?? {});
        delete run.sampling; delete run.offset;
        result.run = { ...run, maxTasks: null, taskIds };
      }
      return result;
    },
    expand(parameters) {
    const raw = workflowObject(parameters);
    const variantsInput = raw.variants;
    const repetitions = expectPositiveInteger(raw.repetitions ?? 1, "benchmark repetitions");
    delete raw.variants; delete raw.repetitions;
    const { deployment, ...resolved } = resolveParameters(raw);
    const experiment = parseEffectiveConfig(resolved);
    let variants: WorkflowObject[] | undefined;
    if (variantsInput !== undefined) {
      if (!Array.isArray(variantsInput) || !variantsInput.length) throw new TypeError("Benchmark variants must be a nonempty array");
      variants = variantsInput.map(value => {
        const variant = workflowObject(value);
        rejectUnknown(variant, ["id", "solver", "services"], "benchmark variant");
        const services = { ...workflowObject(raw.services) };
        for (const [name, value] of Object.entries(workflowObject(variant.services ?? {})))
          services[name] = { ...workflowObject(services[name] ?? {}), ...workflowObject(value) };
        const benchmark = typeof raw.benchmark === "string" ? { name: raw.benchmark } : workflowObject(raw.benchmark);
        const { deployment: _deployment, ...experiment } = resolveParameters({ ...raw, services,
          ...(variant.solver === undefined ? {} : { benchmark: { ...benchmark, solver: variant.solver } }) });
        return { id: expectNonEmptyString(variant.id, "variant ID"), experiment };
      });
    }
    const runtimeConfig = settings({ experiment: resolved, repetitions, ...(variants ? { variants } : {}) });
    const reportConfig = { groups: (variants ?? [{ id: "default", experiment: resolved }]).flatMap(variant => {
      const selected = parseEffectiveConfig(workflowObject(variant.experiment));
      return Array.from({ length: repetitions }, (_, repetition) => workflowValue({ id: variant.id, repetition,
        grouped: variants !== undefined || repetitions !== 1, metrics: selected.metrics, reporter: selected.reporter }));
    }) };
    const body = benchmarkAttemptBlock();
    // Finalization decides whether a solve timeout is valid evidence or a technical failure.
    for (const node of body.steps) if (node.id === "parts") node.onError = "continue";
    body.resources.attempt = { use: "benchmark.attempt", scope: "attempt", config: { taskId: { ref: "sample.id" } }, resources: { runtime: "benchmark" } };
    for (const operation of benchmarkOperations) body.resources[operation]!.resources.attempt = "attempt";
    body.steps.push({ kind: "step", id: "commit", use: "benchmark.commit", inputs: {}, config: {}, resources: { attempt: "attempt" } });
    body.outputs = { scores: { ref: "commit.outputs.scores" }, evidence: { ref: "commit.outputs.evidence" } }; body.required = ["scores", "evidence"];
    const document: WorkflowDocument = { schemaVersion: 2, inputs: {}, inputProtocols: {}, output: { directory: "results" },
      run: { timeoutSeconds: 86400, cleanupTimeoutSeconds: 60, onError: experiment.run.onError === "continue" ? "continue" : "stop" },
      workflow: { resources: { benchmark: { use: "benchmark.runtime", scope: "run", config: Object.fromEntries(Object.entries(runtimeConfig).map(([key, value]) => [key, { value }])), resources: {} } },
        steps: [{ kind: "step", id: "select", use: "benchmark.select", config: {}, inputs: {}, resources: { runtime: "benchmark" } },
          { kind: "step", id: "prepare", use: "benchmark.prepare-selection", config: {}, inputs: { cases: { ref: "select.outputs.cases" } }, resources: { runtime: "benchmark" } },
          { kind: "forEach", id: "evaluate", items: { ref: "prepare.outputs.cases" }, as: "sample", mode: "units",
            concurrency: Number(experiment.scheduler.config.concurrency ?? 1), admission: "benchmark", retry: { policy: "benchmark", maxAttempts: MAX_STREAM_TASK_RETRIES + 1 }, matrix: { variants: variants?.map(variant => ({ id: variant.id ?? "default" })) ?? [{ id: "default" }], repetitions }, body },
          { kind: "step", id: "metrics", use: "benchmark.metrics", config: {}, inputs: {}, resources: { runtime: "benchmark" } },
          { kind: "step", id: "report", use: "benchmark.report", config: reportConfig, inputs: { metrics: { ref: "metrics.outputs.metrics" } }, resources: { runtime: "benchmark" }, onError: "continue" }],
        outputs: { metrics: { ref: "metrics.outputs.metrics" } }, required: ["metrics"] } };
    if (experiment.scheduler.name === "ray") {
      const scheduling = workflowScheduling(workflowValue(experiment.scheduler));
      const scheduled = parseWorkflowDocument({ schemaVersion: 2, resources: scheduling.resources, workflow: { steps: [] } });
      Object.assign(document.workflow.resources, scheduled.workflow.resources);
      document.workflow.resources.benchmark!.resources.connection = "ray";
      document.workflow.resources.benchmarkExecutor = { use: "benchmark.ray-executor", scope: "run", config: { selectionBinding: { value: "prepare.outputs.selection" } },
        resources: { runtime: "benchmark", executor: "execution" } };
      const prepare = document.workflow.steps.find(node => node.id === "prepare");
      if (prepare?.kind !== "step") throw new Error("Missing Benchmark preparation step");
      prepare.use = "benchmark.prepare-remote";
      const evaluate = document.workflow.steps.find(node => node.id === "evaluate");
      if (evaluate?.kind !== "forEach") throw new Error("Missing Benchmark sample loop");
      evaluate.executor = "benchmarkExecutor";
      body.resources.attempt = { use: "benchmark.remote-attempt", scope: "attempt", config: { credentialNames: { value: benchmarkCredentials(runtimeConfig) } }, resources: {} };
      body.steps.unshift({ kind: "step", id: "start", use: "benchmark.start", config: {},
        inputs: { selection: { ref: "prepare.outputs.selection" } }, resources: { attempt: "attempt" } });
    }
    return { ...workflowConfiguration(document), ...(deployment === undefined ? {} : { deployment: benchmarkDeployment(parseDeployment(deployment),
      variants ? variants.map(variant => parseEffectiveConfig(workflowObject(variant.experiment))) : [experiment]) }) };
  } });
}
