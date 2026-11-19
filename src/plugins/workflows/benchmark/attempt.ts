import { assertLockedAttachments } from "../../../core/validation/multimodal.js";
import { collectAttemptAccounting } from "../../../core/results/attempt-accounting.js";
import { DEFAULT_TASK_TIMEOUT_SECONDS } from "../../../core/policies/timeouts.js";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import type { RunComponents } from "../../../core/contracts/components.js";
import type { PreparedTask, PublicTask, SourceLock, PhaseTimeoutOverrides } from "../../../core/contracts/task.js";
import type { SolveResult, VerifyResult } from "../../../core/contracts/result.js";
import { withPreparationTimeout, DEFAULT_PREPARATION_TIMEOUT_SECONDS } from "../../../core/preparation/preparation-timeout.js";
import { materializeVerificationRuntime } from "../../../core/preparation/verification-runtime.js";
import type { DispatchEntry } from "../../../core/preparation/task-preparation.js";
import {
  TRAJECTORY_EVIDENCE_PATH,
  type AttemptRecord,
  type Collection,
  type Failure,
  type FileManifest,
  type Phase,
  type AttemptStepResult,
} from "../../../core/contracts/result.js";
import { archiveStep, clearStepOutputs, combineStepTrajectories, sumStepSolves } from "../../../core/artifacts/step-evidence.js";
import { buildFileManifest } from "../../../core/artifacts/artifacts.js";
import { readTrajectoryPrefix } from "../../../core/artifacts/trajectory-recovery.js";
import { redactDiagnostic } from "../../../core/errors/diagnostics.js";
import { VerificationError } from "../../../core/errors/verification-error.js";
import { PhaseTimeoutError } from "../../../core/policies/phase-timeout.js";
import type { ProgressListener } from "../../../core/progress/progress.js";
import { LiveOperation } from "../../../core/progress/live-progress.js";
import { finalizeAttemptOutcome, timeoutCancellation, applyAttemptFailure } from "../../../core/results/evaluation-outcome.js";
import { classifyError, normalizeFailure } from "../../../core/errors/classify.js";
import { EvaluatorError } from "../../../core/errors/evaluator-error.js";
import { readCollectOutput } from "../../../core/artifacts/collect-output.js";
import { AttemptResources, type RecordAttemptFailure, type RunAttemptStage } from "./attempt-resources.js";
import { createAttemptStep, expectedStepArtifact, publicTaskInput, recoverStepEvidence, solveAttemptStep, transferAttemptStep, verifyAttemptStep, type AttemptStep } from "./attempt-step.js";
import { runBenchmarkAttemptWorkflow } from "./definition.js";

export type RunTaskOptions = PhaseTimeoutOverrides & {
  timeoutSeconds?: number;
  scoreAfterSolveTimeout?: boolean;
  cleanupTimeoutMs?: number;
  preparationConcurrency?: number;
  environmentTimeoutSeconds?: number;
  sensitiveValues?: readonly string[];
  onProgress?: ProgressListener;
  /** When true, persist the solver prompt and any textual reference answer. */
  includeTaskAnswer?: boolean;
};

class UnsupportedRuntimeInstallationError extends Error {
  readonly code = "ENV_RUNTIME_INSTALL_FAILED";
  constructor() {
    super("The selected environment does not support solver runtime installation");
  }
}

async function trajectoryState(
  root: string,
  files: FileManifest,
  key: AttemptRecord["key"],
  started: boolean,
): Promise<Collection["trajectory"]> {
  if (!files.files.some(file => file.path === TRAJECTORY_EVIDENCE_PATH)) return started ? "missing" : "not-produced";
  if (!files.files.some(file => file.path === "agent/session.jsonl")) return "partial";
  const prefix = await readTrajectoryPrefix(root, key);
  return prefix.state === "complete" ? "complete" : "partial";
}

export async function createBenchmarkAttempt(
  { job, preparation }: DispatchEntry,
  components: RunComponents,
  source: SourceLock,
  signal: AbortSignal,
  options: RunTaskOptions = {},
) {
  const dependenciesReady = preparation.state === "ready";
  const readiness = preparation.state === "ready" ? preparation.readiness : undefined;
  const timeoutSeconds = options.timeoutSeconds ?? DEFAULT_TASK_TIMEOUT_SECONDS;
  const cleanupTimeoutMs = options.cleanupTimeoutMs ?? 60_000;
  if (
    !Number.isFinite(timeoutSeconds) ||
    timeoutSeconds <= 0 ||
    !Number.isFinite(cleanupTimeoutMs) ||
    cleanupTimeoutMs <= 0
  )
    throw new TypeError("Invalid task time budget");
  for (const value of [options.solveTimeoutSeconds, options.verifyTimeoutSeconds]) {
    if (value !== undefined && (!Number.isFinite(value) || value <= 0)) throw new TypeError("Invalid phase time budget");
  }
  const key = { runId: job.runId, taskId: job.taskId, attemptId: job.attemptId };
  const progress = (phase: Phase, message: string) =>
    options.onProgress?.({ phase, message, taskId: job.taskId, attemptId: job.attemptId });
  const startedAt = new Date().toISOString();
  const started = performance.now();
  progress("store", "Allocating attempt output");
  const paths = await components.store.allocate(key).catch(cause => {
    throw new EvaluatorError("STORE_WRITE_FAILED", "Cannot allocate attempt output", {}, { cause });
  });
  const deadline = new AbortController();
  const timer = setTimeout(
    () => deadline.abort(new DOMException("Task deadline exceeded", "TimeoutError")),
    timeoutSeconds * 1000,
  );
  timer.unref();
  const taskSignal = AbortSignal.any([signal, deadline.signal]);
  let operationSignal = taskSignal;
  const record: AttemptRecord = {
    evaluationKind: components.benchmark.evaluationKind ?? "quality",
    ...(readiness === undefined ? {} : { readiness: structuredClone(readiness) }),
    key,
    executionStatus: "failed", scoreStatus: "invalid", cleanupStatus: "cleaned",
    solve: null,
    verdict: null,
    errors: [],
    collection: { trajectory: "not-produced", artifacts: "not-produced" },
    environments: { solve: null, verify: null },
    startedAt,
    finishedAt: startedAt,
    durationMs: 0,
    phaseDurationMs: {},
  };
  const preparationElapsedMs = { solve: 0, verify: 0 };
  let phase: Phase = "prepare";
  let prepared: PreparedTask | undefined;
  let multiTask: PreparedTask | undefined;
  let step: AttemptStep | undefined;
  let activeStep: AttemptStepResult | undefined;
  let stepErrorStart = 0;
  let stepArchived = false;
  let solveStarted = false;
  const failure: RecordAttemptFailure = (at, error, fallback, context = "", cancellation) => {
    let item: Failure;
    if (at === "prepare" && preparation.state === "failed") {
      item = normalizeFailure(preparation.failure, options.sensitiveValues);
    } else {
      const fallbackCode = error instanceof VerificationError ? "VERIFY_RESULT_INVALID" : fallback;
      item = classifyError(error, {
        phase: at,
        ...(fallbackCode ? { fallbackCode } : {}),
        ...(at === "prepare" ? { component: "task-source" } : {}),
        ...(options.sensitiveValues ? { secrets: options.sensitiveValues } : {}),
        ...(cancellation ? { cancellation } : {}),
      });
    }
    if (context) item.message = (redactDiagnostic(context, options.sensitiveValues) + item.message).slice(0, 2048);
    if (item.code === "NETWORK_FAILURE") (item.details ??= {}).logPath = "result.json";
    record.errors.push(item);
  };
  const resources = new AttemptResources(components, record, paths, dependenciesReady, cleanupTimeoutMs, failure, options.sensitiveValues);
  const stage: RunAttemptStage = async (at, work, activeSignal = operationSignal) => {
    phase = at;
    const start = performance.now();
    const labels: Partial<Record<Phase, string>> = {
      prepare: "Preparing task",
      install: "Installing solver runtime",
      environment: "Preparing execution environment",
      solve: "Solving task",
      verify: "Verifying result",
      transfer: "Transferring workspace",
      collect: "Collecting execution artifacts",
      cleanup: "Releasing runtime resources",
    };
    progress(at, labels[at] ?? "Starting");
    let limit: number | undefined;
    if (at === "solve") limit = options.solveTimeoutSeconds ?? (step?.task ?? prepared)?.phaseTimeoutSeconds?.solve;
    else if (at === "verify") limit = options.verifyTimeoutSeconds ?? (step?.task ?? prepared)?.phaseTimeoutSeconds?.verify;
    if (limit !== undefined && (!Number.isFinite(limit) || limit <= 0))
      throw new TypeError(`Invalid ${at} phase time limit`);
    const phaseDeadline = limit === undefined ? null : AbortSignal.timeout(limit * 1000);
    const stageSignal = phaseDeadline === null ? activeSignal : AbortSignal.any([activeSignal, phaseDeadline]);
    const operation = new LiveOperation(options.onProgress, { phase: at, message: labels[at] ?? at,
      taskId: job.taskId, attemptId: job.attemptId }, options.sensitiveValues, undefined,
      `${job.runId}/${job.taskId}/${job.attemptId}/${at}`, at === "environment");
    try {
      const result = await resources.runOperation(() => work(stageSignal, operation.activity), stageSignal);
      operation.finish();
      return result;
    } catch (error) {
      operation.finish(activeSignal.aborted ? "cancelled" : "failed");
      if (phaseDeadline?.aborted && !activeSignal.aborted) throw new PhaseTimeoutError(at);
      throw error;
    } finally {
      record.phaseDurationMs[at] = (record.phaseDurationMs[at] ?? 0) + performance.now() - start;
    }
  };
  const prepareEnvironment = <T>(purpose: "solve" | "verify", task: PreparedTask, work: (signal: AbortSignal) => Promise<T>) => {
    if (dependenciesReady) return work(operationSignal);
    phase = "environment";
    const started = performance.now();
    return withPreparationTimeout(purpose,
      options.environmentTimeoutSeconds ?? task.preparationTimeoutSeconds?.[purpose] ?? DEFAULT_PREPARATION_TIMEOUT_SECONDS,
      options.preparationConcurrency ?? 1, operationSignal, work,
      timing => progress("environment", `${purpose} preparation timeout ${timing.timeoutSeconds}s (base ${timing.baseSeconds}s × ${timing.multiplier}; concurrency ${timing.concurrency})`), preparationElapsedMs[purpose])
      .finally(() => { preparationElapsedMs[purpose] += performance.now() - started; });
  };
  const stepContext = { benchmark: components.benchmark, resources, record, paths, stage, failure, prepareEnvironment,
    get taskSignal() { return operationSignal; }, scoreAfterSolveTimeout: options.scoreAfterSolveTimeout !== false, dependenciesReady, secrets: options.sensitiveValues, onProgress: options.onProgress };
  async function prepare() {
    if (preparation.state === "failed") {
      const error = new Error(preparation.failure.message);
      Object.assign(error, { code: preparation.failure.code });
      throw error;
    }
    prepared = await stage("prepare", (active, activity) => preparation.state === "on-demand"
      ? components.benchmark.prepare(job.ref, source, active, activity)
      : Promise.resolve(preparation.task));
    if (prepared.input.id !== job.taskId) throw new TypeError("Prepared task identity differs from locked selection");
    assertLockedAttachments(prepared, source);
    if (!dependenciesReady && components.benchmark.verificationRuntime)
      prepared = await prepareEnvironment("verify", prepared, preparationSignal =>
        stage("environment", (active, activity) => materializeVerificationRuntime(prepared!, components.benchmark, active, activity), preparationSignal));
    if (dependenciesReady && components.benchmark.verificationRuntime && prepared.verificationRuntime === undefined)
      throw new Error("Prepared task lacks its verification runtime receipt");
    if (prepared.steps) {
      if (!components.benchmark.evaluateSteps) throw new Error("Multi-step Benchmark must implement evaluateSteps()");
      const names = prepared.steps.map(step => step.name);
      if (!names.length || new Set(names).size !== names.length || names.some(name => !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/u.test(name)) ||
        prepared.steps.some(step => step.task.steps || step.task.input.id !== job.taskId)) throw new TypeError("Invalid prepared steps");
      multiTask = prepared;
      record.steps = [];
    }
    if (prepared.transfer && prepared.verifyEnv === null)
      throw new TypeError("File transfer requires a verification environment");
    if (prepared.verificationMode === "separate" && prepared.verifyEnv === null)
      throw new TypeError("Separate verification requires a verification environment");
    if (prepared.verificationMode === "shared" && (prepared.verifyEnv !== null || prepared.transfer !== null))
      throw new TypeError("Shared verification must reuse the solve environment without state transfer");
    if (prepared.artifactCollection && prepared.transfer)
      throw new TypeError("Use one declared artifact snapshot or environment transfer");
    step = createAttemptStep(prepared);
    const solverEnvironment = prepared.solveEnv;
    await prepareEnvironment("solve", prepared, async preparationSignal => {
      const installation = !dependenciesReady && components.solver.runtimeInstallation
        ? await stage("install", async (stageSignal, activity) => {
            const described = await components.solver.runtimeInstallation!(stageSignal);
            stageSignal.throwIfAborted();
            if (components.environment.supportsRuntimeInstallation !== true)
              throw new UnsupportedRuntimeInstallationError();
            await components.environment.installRuntime?.(described, stageSignal, solverEnvironment, activity);
            return described;
          }, preparationSignal)
        : undefined;
      await stage("environment", (active, activity) => resources.openSolve(solverEnvironment, installation, active, activity), preparationSignal);
    });
    return (multiTask?.steps ?? [{ name: "single", task: prepared }]).map((part, index) => ({ id: part.name, index }));
  }
  async function begin(index: number) {
    if (!prepared) throw new Error("Attempt has not been prepared");
    const descriptor = (multiTask?.steps ?? [{ name: "single", task: prepared }])[index];
    if (!descriptor) throw new TypeError(`Invalid attempt step ${index}`);
    if (multiTask) {
      const task = { ...descriptor.task, solveEnv: { ...multiTask.solveEnv, network: descriptor.task.solveEnv.network ?? "bridge",
        ...(descriptor.task.solveEnv.executionUsers ? { executionUsers: descriptor.task.solveEnv.executionUsers } : {}) },
        ...(index === 0 && multiTask.verificationRuntime !== undefined ? { verificationRuntime: multiTask.verificationRuntime } : {}) };
      step = createAttemptStep(task);
      stepErrorStart = record.errors.length;
      stepArchived = false;
      activeStep = { name: descriptor.name, solve: null, verdict: null, errors: [], startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(), evidencePath: `steps/${descriptor.name}` };
      record.solve = null;
      record.verdict = null;
      progress("prepare", `Starting step ${index + 1}/${multiTask.steps!.length}: ${descriptor.name}`);
      if (index > 0) {
        await stage("transfer", async (active, activity) => {
          await clearStepOutputs(paths.root);
          active.throwIfAborted();
          await resources.returnToSolve(task.solveEnv, active, activity);
        });
        if (components.benchmark.verificationRuntime)
          step.task = await prepareEnvironment("verify", task, active => materializeVerificationRuntime(task, components.benchmark, active));
      }
      if ("workdirFiles" in descriptor && descriptor.workdirFiles) {
        const { workdirFiles, setupScript } = descriptor;
        await stage("prepare", async active => {
          const session = resources.solveEnvironment;
          await session.upload(workdirFiles, session.workdir, active);
          if (!setupScript) return;
          active.throwIfAborted();
          const handle = await session.start({ executable: "bash", args: ["setup.sh"], cwd: session.workdir, env: {}, input: null }, active);
          const exit = await readCollectOutput(handle, join(paths.root, "collect/setup"), active, options.sensitiveValues);
          if (exit.code !== 0 || exit.signal !== null) throw new Error(`Step ${descriptor.name} setup.sh failed: ${exit.code ?? exit.signal}`);
        });
      }
    }
  }
  async function finishStep(): Promise<boolean> {
    if (multiTask && activeStep) {
      activeStep.solve = record.solve;
      activeStep.verdict = record.verdict;
      activeStep.errors = record.errors.slice(stepErrorStart);
      activeStep.finishedAt = new Date().toISOString();
      record.steps!.push(activeStep);
      await stage("cleanup", active => resources.finishStep(active));
      await stage("collect", () => archiveStep(paths.root, record, activeStep!));
      stepArchived = true;
      const decision = components.benchmark.evaluateSteps!(multiTask, record.steps!);
      record.verdict = decision.verdict;
      activeStep = undefined;
      return !decision.continue;
    }
    return false;
  }
  function fail(error: unknown) {
    const infrastructureCancellation = signal.aborted && signal.reason && typeof signal.reason === "object" &&
      "code" in signal.reason && signal.reason.code === "RAY_HEARTBEAT_TIMEOUT";
    const ownedDeadline = deadline.signal.aborted && taskSignal.reason === deadline.signal.reason || error instanceof PhaseTimeoutError;
    const cancellation = timeoutCancellation(record.evaluationKind, infrastructureCancellation,
      signal.aborted, ownedDeadline, phase);
    failure(
      phase,
      error,
      undefined,
      "", cancellation,
    );
    applyAttemptFailure(record);
  }
  let closing: Promise<void> | undefined;
  function closeResources(): Promise<void> { return closing ??= releaseResources(); }
  async function releaseResources() {
    clearTimeout(timer);
    const cleanupSignal = AbortSignal.timeout(cleanupTimeoutMs);
    if (step) await recoverStepEvidence(step, stepContext, cleanupSignal);
    await resources.close(stage, cleanupSignal);
  }
  async function finalize(): Promise<AttemptRecord> {
    await closeResources();
    if (multiTask && record.steps) {
      if (activeStep) {
        activeStep.solve = record.solve;
        activeStep.verdict = record.verdict;
        activeStep.errors = record.errors.slice(stepErrorStart);
        activeStep.finishedAt = new Date().toISOString();
        if (!record.steps.some(step => step.name === activeStep!.name)) record.steps.push(activeStep);
        if (!stepArchived) await archiveStep(paths.root, record, activeStep).catch(error => failure("collect", error, "ARTIFACT_COLLECTION_INCOMPLETE"));
      }
      if (record.steps.length) {
        record.solve = sumStepSolves(record.steps);
        await combineStepTrajectories(paths.root, record).catch(error => failure("collect", error, "ARTIFACT_COLLECTION_INCOMPLETE"));
      } else delete record.steps;
    }
    // Hash after processes stop writing; store verifies the same inventory before
    // publishing result.json. Store allocation/publication errors remain global.
    const required = solveStarted ? [TRAJECTORY_EVIDENCE_PATH, "agent/session.jsonl"] : [];
    const artifactName = step ? expectedStepArtifact(step) : null;
    if (resources.hasSolveEnvironment && artifactName !== null) required.push(`artifacts/${artifactName}`);
    const collectionStart = performance.now();
    progress("collect", "Collecting trajectory and artifacts");
    const files = await buildFileManifest(paths.root, required);
    finalizedFiles = files;
    record.collection.trajectory = await trajectoryState(paths.root, files, key, solveStarted);
    const artifactFiles = files.files.filter(file => file.path.startsWith("artifacts/") || file.path.startsWith("logs/artifacts/"));
    const missingArtifacts = files.missing.some(file => file.path.startsWith("artifacts/"));
    record.collection.artifacts = missingArtifacts
      ? artifactFiles.length
        ? "partial"
        : "missing"
      : artifactFiles.length
        ? "complete"
        : "not-produced";
    if (files.files.some(file => file.path === TRAJECTORY_EVIDENCE_PATH)) {
      record.trajectory = TRAJECTORY_EVIDENCE_PATH;
    }
    if (files.missing.length || (solveStarted && record.collection.trajectory !== "complete")) {
      if (record.evaluationKind === "quality" && record.errors.some(error => error.code === "SOLVER_AGENT_TIMEOUT") && files.missing.length === 0 && record.collection.trajectory === "partial")
        (record.warnings ??= []).push({ phase: "collect", code: "ARTIFACT_COLLECTION_INCOMPLETE", message: "Agent solve deadline ended the trajectory before completion; all required files were collected" });
      else if (record.errors.some(error => error.code === "NETWORK_FAILURE") && files.missing.every(file => [TRAJECTORY_EVIDENCE_PATH, "agent/session.jsonl"].includes(file.path)))
        (record.warnings ??= []).push({ phase: "collect", code: "ARTIFACT_COLLECTION_INCOMPLETE", message: "Network failure ended the solver trajectory before completion" });
      else failure("collect", new Error("Task evidence is missing or partial"), "ARTIFACT_COLLECTION_INCOMPLETE");
    }
    record.phaseDurationMs.collect = (record.phaseDurationMs.collect ?? 0) + performance.now() - collectionStart;
    const lastTask = step?.task ?? prepared;
    if (options.includeTaskAnswer === true && lastTask) {
      const answer = components.benchmark.discloseAnswer?.(lastTask);
      record.task = answer === null || answer === undefined ? { prompt: lastTask.input.prompt } : { prompt: lastTask.input.prompt, answer };
    }
    if (lastTask?.input.attachments) record.inputAttachments = structuredClone(lastTask.input.attachments);
    record.finishedAt = new Date().toISOString();
    record.durationMs = performance.now() - started;
    await collectAttemptAccounting(paths.root, record);
    finalizeAttemptOutcome(record);
    progress("store", "Saving attempt result");
    await components.store.commit(record, files).catch(cause => {
      throw new EvaluatorError("STORE_WRITE_FAILED", "Cannot persist attempt result", {}, { cause });
    });
    return record;
  }
  let finalization: Promise<AttemptRecord> | undefined;
  let finalizedFiles: FileManifest | undefined;
  const current = () => { if (!step) throw new Error("Attempt step is unavailable"); return step; };
  return {
    paths, prepare, fail, close: closeResources,
    async begin(index: number) { await begin(index); return publicTaskInput(current().task.input); },
    async operate<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
      operationSignal = AbortSignal.any([taskSignal, signal]);
      try { return await work(); } finally { operationSignal = taskSignal; }
    },
    async solve(input: PublicTask) { const active = current(); try { await solveAttemptStep(active, stepContext, input); return record.solve; } finally { solveStarted ||= active.solveStarted; } },
    async transfer() { await transferAttemptStep(current(), stepContext, multiTask); },
    async verify(solve: SolveResult) { record.solve = solve; await verifyAttemptStep(current(), stepContext); return record.verdict; },
    async finishStep(verdict: VerifyResult | null) { record.verdict = verdict; return await finishStep(); },
    finalize() { return finalization ??= finalize(); },
    async evidence() {
      const result = await (finalization ??= finalize());
      if (!finalizedFiles) throw new Error("Benchmark finalization did not produce a file manifest");
      return { record: result, files: structuredClone(finalizedFiles), root: paths.root };
    },
  };
}

export type BenchmarkAttempt = Awaited<ReturnType<typeof createBenchmarkAttempt>>;

export async function runTask(entry: DispatchEntry, components: RunComponents, source: SourceLock, signal: AbortSignal,
  options: RunTaskOptions = {}): Promise<AttemptRecord> {
  const attempt = await createBenchmarkAttempt(entry, components, source, signal, options);
  try {
    await runBenchmarkAttemptWorkflow(attempt, entry.job, signal, options);
  } finally { await attempt.close(); }
  return await attempt.finalize();
}
