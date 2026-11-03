import type { ActivityListener } from "./activity.js";
import type { EnvironmentSession } from "./environment.js";
import type { AttemptKey, AttemptPaths, SolveResult, VerifyResult } from "./result.js";
import type { JsonValue, PreparedTask } from "./task.js";

/** A private verifier process, distinct from the task environment it inspects. */
export interface VerificationRuntimeSession<Result = VerifyResult> {
  metadata: JsonValue;
  verify(result: SolveResult, environment: EnvironmentSession | null, signal: AbortSignal): Promise<Result>;
  dispose(signal: AbortSignal): Promise<void>;
}

export interface VerificationRuntime<Task = PreparedTask, Result = VerifyResult> {
  /** Prepare images/dependencies only. No attempt processes or containers. */
  materialize(task: Task, signal: AbortSignal, activity?: ActivityListener): Promise<JsonValue>;
  /** Consume the materialized receipt; do not build or pull images here. */
  prepare(task: Task, receipt: JsonValue, context: {
    key: AttemptKey; paths: AttemptPaths; signal: AbortSignal; activity?: ActivityListener;
  }): Promise<VerificationRuntimeSession<Result>>;
  recoverAttempts?(keys: AttemptKey[], signal: AbortSignal): Promise<void>;
}
