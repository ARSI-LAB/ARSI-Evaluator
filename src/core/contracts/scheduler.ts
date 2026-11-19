import type { Failure, RunManifest } from "./result.js";
import type { JsonValue, TaskRef } from "./task.js";
import type { ProgressListener } from "../progress/progress.js";
import type { BenchmarkRunPlan } from "./benchmark.js";
import type { PreparationContext, ScheduledPreparation } from "./preparation.js";

/** Locked metadata for preparing dependencies, independent of result persistence. */
export type SchedulerPreparationContext = {
  session: Pick<RunManifest, "runId" | "source" | "configFingerprint" | "pluginVersions" | "solverProvenance">;
  safeConfig: JsonValue;
  log?(message: string): void;
  onProgress?: ProgressListener;
};

export type TaskJob = {
  runId: string;
  taskId: string;
  ref: TaskRef;
  attemptId: string;
  configFingerprint: string;
  preparationFailure?: Failure;
};

export interface TaskScheduler {
  cleanupImages?(request: import("./image-cleanup.js").ImageCleanupRequest, environment: import("./config.js").Selection, pluginVersions: Record<string, string>, signal: AbortSignal): Promise<import("./image-cleanup.js").ImageCleanupNode[]>;
  readonly executionLocation?: "remote";
  validateCapacity?(taskCount: number): void;
  /** Arrange planned preparation, including its barrier or readiness queue, before execution admission. */
  prepareTasks?(jobs: TaskJob[], plan: BenchmarkRunPlan, context: PreparationContext, signal: AbortSignal): Promise<ScheduledPreparation>;
  /** Prepare remote transport without admitting an evaluation run or result uploads. */
  setupPreparation?(context: SchedulerPreparationContext, signal: AbortSignal): Promise<void>;
}
