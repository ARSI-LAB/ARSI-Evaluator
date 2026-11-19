import type { TaskJob, TaskScheduler } from "../../../core/contracts/scheduler.js";
import type { BenchmarkRunPlan } from "../../../core/contracts/benchmark.js";
import type { PreparationContext, ScheduledPreparation } from "../../../core/contracts/preparation.js";
import { prepareBatch } from "./preparation.js";
import { preparePipeline } from "./preparation-pipeline.js";

export class LocalScheduler implements TaskScheduler {
  constructor(private readonly concurrency: number) {
    if (!Number.isSafeInteger(concurrency) || concurrency < 1)
      throw new TypeError("concurrency must be a positive integer");
  }

  async prepareTasks(_jobs: TaskJob[], plan: BenchmarkRunPlan, context: PreparationContext, signal: AbortSignal): Promise<ScheduledPreparation> {
    const settings = { mode: "pipeline" as const, concurrency: this.concurrency, ...context.settings };
    if (settings.mode === "pipeline") return { pipeline: preparePipeline(plan, context, signal, settings) };
    if (settings.lookahead !== undefined)
      throw new TypeError("Batch preparation does not accept lookahead");
    return { tasks: await prepareBatch(plan, { ...context, settings }, signal) };
  }

}
