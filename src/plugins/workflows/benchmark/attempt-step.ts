import { join } from "node:path";
import { readCollectOutput } from "../../../core/artifacts/collect-output.js";
import type { EnvironmentSession } from "../../../core/contracts/environment.js";
import type { VerificationRuntimeSession } from "../../../core/contracts/verification-runtime.js";
import type { Benchmark } from "../../../core/contracts/benchmark.js";
import type { AttemptPaths, AttemptRecord, Phase } from "../../../core/contracts/result.js";
import type { PreparedTask, PublicTask } from "../../../core/contracts/task.js";
import { redactDiagnostic, redactEvidence } from "../../../core/errors/diagnostics.js";
import { classifyError } from "../../../core/errors/classify.js";
import { EvaluatorError } from "../../../core/errors/evaluator-error.js";
import { isErrorCode } from "../../../core/errors/registry.js";
import { VerificationError } from "../../../core/errors/verification-error.js";
import { PhaseTimeoutError } from "../../../core/policies/phase-timeout.js";
import type { ProgressListener } from "../../../core/progress/progress.js";
import { assertEvaluationVerdict } from "../../../core/results/evaluation-outcome.js";
import { assertSolveResult, assertVerifyResult } from "../../../core/results/record-validation.js";
import { assertJsonValue } from "../../../core/validation/input.js";
import type { AttemptResources, RecordAttemptFailure, RunAttemptStage } from "./attempt-resources.js";

function artifactName(spec: NonNullable<PreparedTask["transfer"]>): string {
  switch (spec.kind) {
    case "git-patch": return "model.patch";
    case "artifacts": return "artifacts.tar";
    default: return "workspace.tar";
  }
}

export type AttemptStep = {
  task: PreparedTask; solveStarted: boolean; exported: boolean; transitioned: boolean; collected: boolean;
  verifier: EnvironmentSession | null; privateVerifier: VerificationRuntimeSession | null;
};

export function createAttemptStep(task: PreparedTask): AttemptStep {
  return { task, solveStarted: false, exported: false, transitioned: false, collected: false, verifier: null, privateVerifier: null };
}

export type StepContext = {
  benchmark: Benchmark;
  resources: AttemptResources;
  record: AttemptRecord;
  paths: AttemptPaths;
  stage: RunAttemptStage;
  failure: RecordAttemptFailure;
  prepareEnvironment: <T>(purpose: "solve" | "verify", task: PreparedTask, work: (signal: AbortSignal) => Promise<T>) => Promise<T>;
  taskSignal: AbortSignal;
  scoreAfterSolveTimeout: boolean;
  dependenciesReady: boolean;
  secrets: readonly string[] | undefined;
  onProgress: ProgressListener | undefined;
};

export function expectedStepArtifact({ task }: AttemptStep): string | null {
  const spec = task.transfer ?? task.artifactCollection;
  return spec ? artifactName(spec) : null;
}

async function exportStep(
  step: AttemptStep, context: StepContext, spec: NonNullable<PreparedTask["transfer"]>, phase: "transfer" | "collect", signal: AbortSignal,
) {
  const { resources, paths, record, secrets } = context;
  const artifact = await resources.solveEnvironment.exportState(spec, join(paths.artifacts, artifactName(spec)), signal);
  signal.throwIfAborted();
  step.exported = true;
  for (const warning of artifact.warnings ?? []) {
    if (!isErrorCode(warning.code)) throw new EvaluatorError("SOLVER_PROTOCOL_INVALID", "Transfer warning uses an unregistered error code");
    (record.warnings ??= []).push({ phase, code: warning.code, message: redactDiagnostic(warning.message, secrets) });
  }
  return artifact;
}

async function finishSolve(step: AttemptStep, context: StepContext, signal: AbortSignal): Promise<void> {
  const { task } = step;
  const { resources, stage, paths, secrets } = context;
  if (task.verificationMode !== "shared" && !task.collect?.length) return;
  if (!step.transitioned) {
    await stage("transfer", active => resources.transitionToVerification(
      task.verificationMode === "shared" ? task.verificationNetwork : undefined, active), signal);
    step.transitioned = true;
  }
  if (step.collected) return;
  step.collected = true;
  const session = resources.solveEnvironment;
  for (const [index, hook] of (task.collect ?? []).entries()) {
    await stage("collect", async active => {
      const hookSignal = AbortSignal.any([active, AbortSignal.timeout(Math.ceil(hook.timeoutSeconds * 1000))]);
      const command = { ...hook, input: null };
      const service = hook.service && hook.service !== "main" ? hook.service : undefined;
      if (service && !session.startService) throw new Error(`Environment cannot collect from service ${service}`);
      const handle = service ? await session.startService!(service, command, hookSignal) : await session.start(command, hookSignal);
      const logPath = `collect/${String(index + 1).padStart(3, "0")}`;
      const exit = await readCollectOutput(handle, join(paths.root, logPath), hookSignal, secrets);
      if (exit.code !== 0 || exit.signal !== null) {
        const stream = exit.stderr.trim() ? "stderr" : "stdout";
        const detail = exit[stream].trim().slice(-800);
        throw new Error(`Collect hook ${index + 1} (service=${hook.service ?? "main"}) failed: ${exit.code ?? exit.signal}; logs=${logPath}${detail ? `; ${stream}: ${detail}` : ""}`);
      }
    }, signal);
  }
}

export function publicTaskInput(input: PublicTask): PublicTask {
  return { id: input.id, prompt: input.prompt,
        ...(input.attachments === undefined ? {} : { attachments: structuredClone(input.attachments) }),
        ...(input.payload === undefined ? {} : { payload: structuredClone(input.payload) }),
        ...(input.skillsDirectories === undefined ? {} : { skillsDirectories: [...input.skillsDirectories] }),
        ...(input.mcpServers === undefined ? {} : { mcpServers: input.mcpServers.map(server => ({ name: server.name, transport: server.transport, url: server.url })) }) };
}

export async function solveAttemptStep(
  step: AttemptStep, context: StepContext, publicInput: PublicTask,
): Promise<void> {
  const { resources, record, stage, failure, paths, taskSignal, secrets, onProgress } = context;
  const { key } = record;
  step.solveStarted = true;
  try {
    record.solve = await stage("solve", async (signal, activity) => {
      const solved = await resources.solve(publicInput, { key, paths, signal, activity, warning: warning => {
        if (!resources.acceptingResources) return;
        if (!isErrorCode(warning.code)) throw new EvaluatorError("SOLVER_PROTOCOL_INVALID", "Solver warning uses an unregistered error code");
        const item = { phase: "solve" as const, code: warning.code, message: redactDiagnostic(warning.message, secrets) };
        (record.warnings ??= []).push(item);
        onProgress?.({ phase: "solve", message: `${item.code}: ${item.message}`, taskId: key.taskId, attemptId: key.attemptId, warning: true });
      } });
      try { assertSolveResult(solved); }
      catch (cause) { throw new EvaluatorError("SOLVER_PROTOCOL_INVALID", "Solver returned a malformed result", {}, { cause }); }
      return solved;
    });
  } catch (error) {
    if (taskSignal.aborted || !context.scoreAfterSolveTimeout || record.evaluationKind !== "quality") throw error;
    const cancellation = error instanceof PhaseTimeoutError ? "agent" : undefined;
    if (cancellation === undefined && classifyError(error, { phase: "solve" }).code !== "SOLVER_AGENT_TIMEOUT") throw error;
    failure("solve", error, undefined, "", cancellation);
    // Wait until the solver stops writing before grading its workspace.
    record.solve = { finalText: "", usage: { inputTokens: null, outputTokens: null, totalTokens: null }, observations: { incomplete: true } };
    await stage("transfer", () => resources.waitForPending());
  }

}

export async function transferAttemptStep(step: AttemptStep, context: StepContext, multiTask: PreparedTask | undefined): Promise<void> {
  const { task } = step;
  const { resources, stage, taskSignal, dependenciesReady, prepareEnvironment, benchmark } = context;
  await finishSolve(step, context, taskSignal);
  const shared = task.verificationMode === "shared";
  if (!shared && (resources.canQuiesceSolve || dependenciesReady)) await stage("transfer", signal => resources.quiesceSolve(signal));
  let verifier = shared ? resources.shareSolveWithVerification() : null;
  const snapshot = task.artifactCollection;
  if (snapshot) await stage("collect", signal => exportStep(step, context, snapshot, "collect", signal));
  const transfer = task.transfer;
  const transferred = transfer ? await stage("transfer", signal => exportStep(step, context, transfer, "transfer", signal)) : null;
  if (!multiTask && !shared && resources.canQuiesceSolve) await stage("cleanup", signal => resources.releaseSolveEnvironment(signal));
  const verifyEnv = task.verifyEnv;
  if (verifyEnv) verifier = await prepareEnvironment("verify", task, signal =>
    stage("environment", (active, activity) => resources.openVerification(verifyEnv, active, activity), signal));
  if (transferred) {
    if (!verifier) throw new TypeError("File transfer requires a verification environment");
    const environment = verifier;
    await stage("transfer", signal => environment.restoreState(transferred, signal));
  }
  const privateVerifier = benchmark.verificationRuntime ? await stage("environment",
    (signal, activity) => resources.openPrivateVerifier(task, signal, activity)) : null;

  step.verifier = verifier;
  step.privateVerifier = privateVerifier;
}

export async function verifyAttemptStep(step: AttemptStep, context: StepContext): Promise<void> {
  const { task, verifier, privateVerifier } = step;
  const { resources, record, stage, benchmark, secrets } = context;
  record.verdict = await stage("verify", async signal => {
    const verdict = await (privateVerifier ? privateVerifier.verify(record.solve!, verifier, signal)
      : benchmark.verify(task, record.solve!, verifier, signal)).catch(error => {
      if (error instanceof VerificationError && resources.acceptingResources) {
        assertJsonValue(error.evidence, "verification failure evidence");
        record.verdict = { passed: null, details: redactEvidence(error.evidence, secrets) };
      }
      throw error;
    });
    try { assertVerifyResult(verdict); }
    catch (cause) { throw new EvaluatorError("VERIFY_RESULT_INVALID", "Benchmark returned a malformed verdict", {}, { cause }); }
    assertEvaluationVerdict(record.evaluationKind, verdict);
    return verdict;
  });
}

export async function recoverStepEvidence(step: AttemptStep, context: StepContext, cleanupSignal: AbortSignal): Promise<void> {
  const { task } = step;
  const { resources, stage, failure } = context;
  const evidenceSpec = task.transfer ?? task.artifactCollection;
  if (!resources.hasSolveEnvironment || step.exported || (!evidenceSpec && !task.collect?.length)) return;
  try {
    await stage("collect", async signal => {
      // Stop any cancelled writer before invoking hooks or taking a snapshot.
      await resources.waitForPending();
      signal.throwIfAborted();
      if (step.solveStarted) {
        try { await finishSolve(step, context, signal); }
        catch (error) {
          if (resources.acceptingResources) failure("collect", error, "ARTIFACT_COLLECTION_INCOMPLETE", "Before evidence collection: ");
        }
      }
      if (!evidenceSpec) return;
      // A failed hook must not discard files already written to the workspace.
      signal.throwIfAborted();
      await resources.quiesceSolve(signal);
      signal.throwIfAborted();
      await exportStep(step, context, evidenceSpec, "collect", signal);
    }, cleanupSignal);
  } catch (error) {
    failure("collect", error, "ARTIFACT_COLLECTION_INCOMPLETE");
  }
}
