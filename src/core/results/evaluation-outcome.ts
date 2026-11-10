import type { AttemptRecord, EvaluationKind, VerifyResult, Phase } from "../contracts/result.js";

/** Correctness is optional; performance measurements can never carry a score. */
export function assertEvaluationVerdict(kind: EvaluationKind | undefined, verdict: VerifyResult): void {
  if (kind === "performance" && (verdict.passed !== null || verdict.score !== undefined))
    throw new TypeError("Performance evaluation requires passed:null and no score");
}

export function timeoutCancellation(
  kind: EvaluationKind | undefined, infrastructure: boolean, cancelled: boolean,
  deadline: boolean, phase: Phase,
): "infrastructure" | "user" | "agent" | undefined {
  if (infrastructure || deadline && kind === "performance") return "infrastructure";
  if (cancelled) return "user";
  return deadline && phase === "solve" ? "agent" : undefined;
}

export function applyAttemptFailure(record: AttemptRecord): void {
  // Earlier solve errors can be recorded before attempting verification.
  const failure = record.errors.at(-1);
  if (!failure) return;
  if (failure.code === "RUN_CANCELLED") record.executionStatus = "cancelled";
  else if (failure.phase === "solve" && failure.code === "SOLVER_AGENT_TIMEOUT" &&
    record.evaluationKind === "quality") record.executionStatus = "agent_timeout";
  else record.executionStatus = "failed";
}

export function isAgentTimeout(record: AttemptRecord): boolean {
  return record.evaluationKind === "quality" && record.executionStatus === "agent_timeout";
}

export function isEvaluationComplete(record: AttemptRecord): boolean {
  if (record.evaluationKind === "performance")
    return record.executionStatus === "completed" && record.solve !== null && record.verdict?.passed === null;
  return record.scoreStatus === "valid";
}

export function isInvalidEvaluation(record: AttemptRecord): boolean {
  return record.scoreStatus === "invalid" || record.executionStatus === "failed";
}

/** Display summaries are derived, never a second persisted status. */
export function attemptStatus(record: AttemptRecord): "completed" | "timeout" | "cancelled" | "unsupported" | "invalid" {
  if (record.executionStatus === "agent_timeout") return "timeout";
  if (record.executionStatus === "completed" || record.executionStatus === "cancelled") return record.executionStatus;
  return record.errors[0]?.code === "BENCHMARK_UNSUPPORTED" ? "unsupported" : "invalid";
}
export function attemptTimeoutKind(record: AttemptRecord): "agent" | "infrastructure" | null {
  if (isAgentTimeout(record)) return "agent";
  if (record.executionStatus === "failed" && record.errors.some(error =>
    error.code.endsWith("_TIMEOUT") && (error.code !== "SOLVER_AGENT_TIMEOUT" || record.evaluationKind === "performance"))) {
    return "infrastructure";
  }
  return null;
}

export function evaluationScore(record: AttemptRecord): number | undefined {
  if (record.evaluationKind === "performance" || isInvalidEvaluation(record)) return undefined;
  if (isAgentTimeout(record)) return 0;
  return record.verdict?.score;
}

export function hasUnconfirmedCleanup(record: AttemptRecord): boolean {
  return record.cleanupStatus === "unconfirmed" || record.errors.some(error =>
    error.phase === "cleanup" || ["CLEANUP_TIMEOUT", "CLEANUP_FAILED"].includes(error.code));
}

/** A legal verdict survives later housekeeping failures; physical capacity remains blocked. */
export function finalizeAttemptOutcome(record: AttemptRecord): void {
  record.cleanupStatus = hasUnconfirmedCleanup(record) ? "unconfirmed" : "cleaned";
  if (record.evaluationKind === "performance") {
    record.scoreStatus = "not-applicable";
    if (record.solve !== null && record.verdict?.passed === null &&
      record.errors.every(error => error.phase === "cleanup" || error.phase === "collect")) {
      record.executionStatus = "completed";
    } else record.executionStatus = record.executionStatus === "cancelled" ? "cancelled" : "failed";
    return;
  }
  if (isAgentTimeout(record)) {
    // Step errors have already been saved in execution order. Put the timeout first in the attempt summary.
    const timeoutIndex = record.errors.findLastIndex(error => error.phase === "solve" && error.code === "SOLVER_AGENT_TIMEOUT");
    if (timeoutIndex > 0) record.errors.unshift(...record.errors.splice(timeoutIndex, 1));
    record.scoreStatus = "valid";
  } else if (record.solve !== null && record.verdict !== null &&
    record.errors.every(error => error.phase === "cleanup" || error.phase === "collect" ||
      error.phase === "solve" && error.code === "SOLVER_AGENT_TIMEOUT")) {
    record.executionStatus = "completed";
    record.scoreStatus = "valid";
  } else {
    record.executionStatus = record.executionStatus === "cancelled" ? "cancelled" : "failed";
    record.scoreStatus = "invalid";
  }
}
