import { randomUUID } from "node:crypto";
import type { ExecutionConfig } from "../../../core/contracts/config.js";
import type { RunComponents } from "../../../core/contracts/components.js";
import type { Failure, PreparationRound } from "../../../core/contracts/result.js";
import type { TaskPlacement } from "../../../core/contracts/preparation.js";
import { createTaskPreparer } from "../../../core/preparation/materialize-task.js";
import { enumerateSelectedTasks } from "../../../core/selection/task-selection.js";
import { fingerprintConfig } from "../../../core/results/run-manifest.js";
import { progressOperation } from "../../../core/progress/progress-operation.js";
import { normalizeFailure } from "../../../core/errors/classify.js";
import type { ProgressListener } from "../../../core/progress/progress.js";
import { resolveSolverProvenance } from "../../../core/results/solver-provenance.js";

export type WarmupSummary = {
  status: "ready" | "error";
  taskIds: string[];
  readyTaskIds: string[];
  failures: { taskId: string; failure: Failure }[];
  preparationRounds: PreparationRound[];
  placements: TaskPlacement[];
  durationMs: number;
};

/** Consume only preparation. No run store, attempt allocation, solver session or scoring. */
export async function warmupSelectedTasks(components: RunComponents, config: ExecutionConfig, signal: AbortSignal,
  onProgress?: ProgressListener, sensitiveValues: readonly string[] = []): Promise<WarmupSummary> {
  signal.throwIfAborted();
  const remote = components.scheduler.executionLocation === "remote";
  if (remote && !components.scheduler.setupPreparation)
    throw new TypeError("Remote warmup requires scheduler.setupPreparation()");
  if (!components.benchmark.planRun || !components.scheduler.prepareTasks || (!remote && !components.environment.materialize))
    throw new TypeError("warmup requires benchmark.planRun(), scheduler.prepareTasks() and environment.materialize()");
  const started = performance.now();
  const source = await progressOperation(onProgress, { phase: "source", message: "Resolving dataset for image warmup" }, signal,
    activity => components.benchmark.resolveSource(null, signal, activity));
  const { selected } = await progressOperation(onProgress, { phase: "enumerate", message: "Selecting tasks for image warmup" }, signal,
    activity => enumerateSelectedTasks(components.benchmark, source, config.experiment.run, signal, activity));
  const taskIds = selected.map(ref => ref.id);
  const plan = await progressOperation(onProgress, { phase: "prepare", message: `Planning image warmup for ${selected.length} tasks` }, signal,
    activity => components.benchmark.planRun!(selected, source, signal, activity));
  const initialFailures = plan.preparationFailures ?? [];
  const failedIds = new Set(initialFailures.map(item => item.taskId));
  const plannedIds = [...plan.tasks.map(task => task.input.id), ...initialFailures.map(item => item.taskId)];
  const plannedSelection = selected.filter(ref => !failedIds.has(ref.id));
  const valid = new Set(taskIds);
  if (plannedIds.length !== selected.length || new Set(plannedIds).size !== selected.length || plannedIds.some(id => !valid.has(id)) ||
      plan.tasks.some((task, index) => task.input.id !== plannedSelection[index]?.id))
    throw new TypeError("Benchmark warmup plan differs from selected tasks");
  let preparationRounds: PreparationRound[] = [];
  let placements: TaskPlacement[] = [];
  const ready = new Set<string>();
  const failures = new Map(initialFailures.map(item => [item.taskId, item.failure]));
  const summary = (): WarmupSummary => ({ status: failures.size ? "error" : "ready", taskIds,
    readyTaskIds: taskIds.filter(id => ready.has(id)),
    failures: [...failures].map(([taskId, failure]) => ({ taskId, failure: normalizeFailure(failure, sensitiveValues) })),
    preparationRounds, placements, durationMs: performance.now() - started });
  if (failures.size && config.experiment.run.onError !== "continue") return summary();
  const runId = `warmup-${randomUUID()}`;
  const configFingerprint = fingerprintConfig(config.persisted);
  const jobs = plannedSelection.map(ref => ({ runId, taskId: ref.id, ref,
    attemptId: randomUUID(), configFingerprint }));
  if (!jobs.length) return summary();
  if (remote) {
    const solverProvenance = await resolveSolverProvenance(components.solver, signal, sensitiveValues);
    await components.scheduler.setupPreparation!({ session: { runId, source, configFingerprint,
      pluginVersions: components.pluginVersions, ...(solverProvenance ? { solverProvenance } : {}) },
      safeConfig: structuredClone(config.persisted), ...(onProgress ? { onProgress,
        log: message => onProgress({ phase: "prepare", message }) } : {}) }, signal);
  }
  const scheduled = await components.scheduler.prepareTasks(jobs, plan, {
    previous: [], sensitiveValues: [...sensitiveValues],
    ...(config.experiment.run.preparation ? { settings: config.experiment.run.preparation } : {}),
    ...(config.experiment.run.onError ? { onError: config.experiment.run.onError } : {}),
    ...(onProgress ? { onProgress } : {}),
    store: { async updateRun(patch) { if (patch.preparationRounds) preparationRounds = structuredClone(patch.preparationRounds); } },
    prepareTask: createTaskPreparer(components, { sensitiveValues, ...(onProgress ? { onProgress } : {}) }),
  }, signal);
  placements = scheduled.placements ?? [];
  if (scheduled.pipeline) {
    const pipeline = scheduled.pipeline;
    try {
      for await (const item of pipeline.tasks) {
        if (item.failure) failures.set(item.task.input.id, item.failure);
        else ready.add(item.task.input.id);
      }
      await pipeline.completion;
    } catch (error) {
      pipeline.cancel(error);
      await pipeline.completion.catch(() => {});
      throw error;
    }
  } else {
    for (const task of scheduled.tasks) ready.add(task.input.id);
    for (const item of plan.preparationFailures ?? []) failures.set(item.taskId, item.failure);
  }
  signal.throwIfAborted();
  if (ready.size + failures.size !== taskIds.length || [...ready].some(id => !valid.has(id) || failures.has(id)) ||
      [...failures.keys()].some(id => !valid.has(id)))
    throw new Error("Warmup preparation did not account for every selected task");
  return summary();
}
