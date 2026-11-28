import { randomUUID } from "node:crypto";
import type { RunComponents } from "../../../core/contracts/components.js";
import type { EffectiveConfig } from "../../../core/contracts/config.js";
import type { SourceLock, TaskRef } from "../../../core/contracts/task.js";
import type { TaskPreparation } from "../../../core/preparation/task-preparation.js";
import type { PreparationPipeline, ScheduledPreparation } from "../../../core/contracts/preparation.js";
import type { TaskJob } from "../../../core/contracts/scheduler.js";
import type { ProgressListener } from "../../../core/progress/progress.js";
import { progressOperation } from "../../../core/progress/progress-operation.js";
import type { WorkflowContext } from "../../../core/contracts/workflow.js";
import { createTaskPreparer } from "../../../core/preparation/materialize-task.js";
import { classifyError } from "../../../core/errors/classify.js";
import { abortable } from "../../../core/workflow/resources.js";
import { runTask } from "./attempt.js";

/** Holds private preparation receipts while the workflow passes only public case IDs. */
export async function prepareBenchmarkSelection(components: RunComponents, refs: TaskRef[], source: SourceLock,
  run: EffectiveConfig["run"], context: WorkflowContext, fingerprint: string, secrets: readonly string[], onFailure: (error: unknown) => void,
  reusable: ReadonlySet<string> = new Set()) {
  const pending = new Map(refs.map(ref => [ref.id, Promise.withResolvers<TaskPreparation>()]));
  const before = await components.store.snapshot();
  const earlierRounds = new Set(before.run.preparationRounds?.map(round => round.id));
  const earlierAttempts = new Set((await components.store.listAttempts()).map(attempt => attempt.key.attemptId));
  let caseIds = refs.map(ref => ref.id);
  const settled = new Set<string>();
  let pipeline: PreparationPipeline | undefined;
  let stream: AsyncIterator<import("../../../core/contracts/preparation.js").ReadyTask> | undefined;
  let streamDone = false;
  let pulling: Promise<string | undefined> | undefined;
  const publish = (id: string, preparation: TaskPreparation) => {
    const target = pending.get(id);
    if (!target || settled.has(id)) throw new TypeError(`Unexpected preparation receipt for ${id}`);
    settled.add(id); target.resolve(preparation);
  };
  const failRemaining = (error: unknown) => {
    const failure = classifyError(error, { phase: "prepare", component: "environment", secrets });
    for (const id of pending.keys()) if (!settled.has(id)) publish(id, { state: "failed", failure });
  };
  const work = refs.filter(ref => !reusable.has(ref.id));
  for (const ref of refs) if (reusable.has(ref.id)) publish(ref.id, { state: "on-demand" });
  if (!components.benchmark.planRun) {
    for (const ref of work) publish(ref.id, { state: "on-demand" });
  } else if (work.length) {
    const plan = await components.benchmark.planRun(work, source, context.signal);
    const failures = plan.preparationFailures ?? [];
    const failedIds = new Set(failures.map(item => item.taskId));
    const plannedRefs = work.filter(ref => !failedIds.has(ref.id));
    const ids = [...plan.tasks.map(task => task.input.id), ...failures.map(item => item.taskId)];
    if (ids.length !== work.length || new Set(ids).size !== work.length || ids.some(id => !work.some(ref => ref.id === id)) ||
        plan.tasks.some((task, index) => task.input.id !== plannedRefs[index]?.id))
      throw new TypeError("Benchmark preparation differs from selected cases");
    for (const item of failures) publish(item.taskId, { state: "failed", failure: item.failure });
    if (failures.length && run.onError !== "continue") {
      // Planning fails before the matrix can dispatch. Save only actual failures,
      // then stop every group through the admission failure signal.
      for (const item of failures) {
        const ref = refs.find(ref => ref.id === item.taskId);
        if (!ref) throw new TypeError("Planning failure refers to an unselected case");
        await runTask({ job: { runId: context.runId, taskId: ref.id, ref, attemptId: randomUUID(), configFingerprint: fingerprint },
          preparation: { state: "failed", failure: item.failure } }, components, source, context.signal, { sensitiveValues: secrets });
      }
      const error = new Error("Benchmark planning failed");
      failRemaining(error);
      onFailure(error);
    }
    else if (plan.tasks.length) {
      if (!components.scheduler.prepareTasks) throw new TypeError("Selected scheduler does not support Benchmark preparation");
      const onProgress = (event: import("../../../core/progress/progress.js").ProgressEvent) => context.log(event.message, { ...event,
        ...(event.taskId ? { taskNumber: refs.findIndex(ref => ref.id === event.taskId) + 1, taskTotal: refs.length } : {}) });
      const jobs = refs.filter(ref => !settled.has(ref.id)).map(ref => ({ runId: context.runId, taskId: ref.id,
        attemptId: randomUUID(), ref, configFingerprint: fingerprint }));
      const previous = (await components.store.snapshot()).run.preparationRounds ?? [];
      let prepared: ScheduledPreparation | undefined;
      try {
        prepared = await components.scheduler.prepareTasks(jobs, plan, { previous,
          ...(run.preparation ? { settings: run.preparation } : {}), ...(run.onError ? { onError: run.onError } : {}),
          sensitiveValues: secrets, onProgress, store: components.store,
          prepareTask: createTaskPreparer(components, { sensitiveValues: secrets, onProgress }),
        }, context.signal);
      } catch (error) {
        const failure = classifyError(error, { phase: "prepare", component: "environment", secrets });
        if (failure.code === "ENV_PREPARATION_TIMEOUT") {
          const round = (await components.store.snapshot()).run.preparationRounds?.at(-1);
          const started = round?.tasks?.filter(task => task.startedAt !== null && task.status !== "ready") ?? [];
          caseIds = [...reusable, ...started.map(task => task.taskId)];
          for (const task of started) if (!settled.has(task.taskId)) publish(task.taskId, { state: "failed", failure: task.failure ?? failure });
          if (!started.length) onFailure(error);
        }
        failRemaining(error);
        if (run.onError !== "continue") onFailure(error);
      }
      if (prepared) {
        if (prepared.pipeline) {
          pipeline = prepared.pipeline;
          stream = pipeline.tasks[Symbol.asyncIterator]();
          void pipeline.completion.catch(onFailure);
        } else {
          for (const item of plan.preparationFailures ?? []) if (!settled.has(item.taskId)) publish(item.taskId, { state: "failed", failure: item.failure });
          for (const task of prepared.tasks) publish(task.input.id, { state: "ready", task });
          if (settled.size !== pending.size) throw new Error("Preparation ended without a receipt for every case");
        }
      }
    }
  }
  // Only execution slots pull receipts. Draining this iterator in the background
  // would bypass the preparation queue's lookahead limit.
  const pull = (): Promise<string | undefined> => {
    if (pulling) return pulling;
    if (!stream || streamDone || !pipeline) return Promise.resolve(undefined);
    const active = pipeline, iterator = stream;
    pulling = (async () => {
      try {
        const item = await iterator.next();
        if (item.done) {
          streamDone = true;
          await active.completion;
          if (settled.size !== pending.size) throw new Error("Preparation ended without a receipt for every case");
          return;
        }
        const ready = item.value;
        publish(ready.task.input.id, ready.failure ? { state: "failed", failure: ready.failure }
          : { state: "ready", task: ready.task, readiness: { roundId: active.roundId,
            readyAt: ready.timing.finishedAt ?? new Date().toISOString(), queueDurationMs: 0 } });
        return ready.task.input.id;
      } catch (error) {
        streamDone = true;
        active.cancel(error); await active.completion.catch(() => {}); failRemaining(error);
      }
    })().finally(() => { pulling = undefined; });
    return pulling;
  };
  return {
    caseIds,
    async *order(ids: readonly string[], signal: AbortSignal) {
      const waiting = new Set(ids);
      if ([...waiting].some(id => !pending.has(id))) throw new TypeError("Admission requested an unselected Benchmark case");
      while (waiting.size) {
        signal.throwIfAborted();
        for (const id of waiting) if (settled.has(id)) { waiting.delete(id); yield id; }
        if (!waiting.size) break;
        await abortable(pull(), signal);
      }
      if (stream && !streamDone && settled.size === pending.size) await abortable(pull(), signal);
    },
    async get(id: string, signal: AbortSignal): Promise<TaskPreparation> {
      const item = pending.get(id);
      if (!item) throw new TypeError(`Case ${id} was not prepared`);
      // A custom workflow may remove admission and retain input order.
      while (!settled.has(id)) await abortable(pull(), signal);
      const receipt = await abortable(item.promise, signal);
      return receipt.state === "ready" && receipt.readiness ? { ...receipt, readiness: { ...receipt.readiness,
        queueDurationMs: Math.max(0, Date.now() - Date.parse(receipt.readiness.readyAt)) } } : receipt;
    },
    async close() {
      pipeline?.cancel(new Error("Benchmark preparation owner closed"));
      try {
        await pulling;
        await stream?.return?.();
        await pipeline?.completion;
      } finally {
        // An aborted block may never admit the task whose background preparation failed.
        // Preserve its native diagnostic without starting a solver or opening an environment.
        if (!context.signal.aborted) {
          const snapshot = await components.store.snapshot();
          const recorded = new Set((await components.store.listAttempts()).filter(attempt => !earlierAttempts.has(attempt.key.attemptId)).map(attempt => attempt.key.taskId));
          for (const round of snapshot.run.preparationRounds ?? []) if (!earlierRounds.has(round.id)) {
            for (const task of round.tasks ?? []) if (task.status === "error" && task.failure && !recorded.has(task.taskId)) {
              const ref = refs.find(ref => ref.id === task.taskId);
              if (!ref) continue;
              await runTask({ job: { runId: context.runId, taskId: ref.id, ref, attemptId: randomUUID(), configFingerprint: fingerprint },
                preparation: { state: "failed", failure: task.failure } }, components, source, AbortSignal.timeout(60_000), { sensitiveValues: secrets });
              recorded.add(task.taskId);
            }
          }
        }
      }
    },
  };
}

export async function prepareRetryTask(
  job: TaskJob,
  { components, source, signal, run, sensitiveValues, onProgress }: {
    components: RunComponents;
    source: SourceLock;
    signal: AbortSignal;
    run: EffectiveConfig["run"];
    sensitiveValues: readonly string[];
    onProgress: ProgressListener;
  },
): Promise<TaskPreparation> {
  if (!components.benchmark.planRun) return { state: "on-demand" };
  const planRun = components.benchmark.planRun.bind(components.benchmark);
  const plan = await progressOperation(onProgress, {
    phase: "prepare", message: "Replanning task environments", taskId: job.taskId, attemptId: job.attemptId,
  }, signal, activity => planRun([job.ref], source, signal, activity));
  const rejected = plan.preparationFailures?.find(item => item.taskId === job.taskId);
  if (rejected) return { state: "failed", failure: rejected.failure };
  try {
    const history = (await components.store.snapshot()).run.preparationRounds ?? [];
    if (!components.scheduler.prepareTasks) throw new Error("Scheduler must implement prepareTasks() for planned retries");
    const prepared = await components.scheduler.prepareTasks([job], plan, {
      previous: history,
      settings: { mode: "batch", concurrency: 1,
        ...(run.preparation?.environmentTimeoutSeconds === undefined ? {} : { environmentTimeoutSeconds: run.preparation.environmentTimeoutSeconds }),
        ...(run.preparation?.roundTimeoutSeconds === undefined ? {} : { roundTimeoutSeconds: run.preparation.roundTimeoutSeconds }) },
      sensitiveValues, onProgress, store: components.store,
      prepareTask: createTaskPreparer(components, { sensitiveValues, onProgress }),
    }, signal);
    if (prepared.pipeline) {
      prepared.pipeline.cancel(new Error("Retry preparation requires a batch barrier"));
      await prepared.pipeline.completion;
      throw new Error("Scheduler returned streaming preparation for a batch retry");
    }
    const failure = plan.preparationFailures?.find(item => item.taskId === job.taskId)?.failure;
    if (failure) return { state: "failed", failure };
    const task = prepared.tasks[0];
    if (prepared.tasks.length !== 1 || task?.input.id !== job.taskId)
      throw new TypeError("Retry preparation differs from locked task plan");
    return { state: components.scheduler.executionLocation === "remote" ? "described" : "ready", task };
  } catch (error) {
    return { state: "failed", failure: classifyError(error, { phase: "prepare", component: "environment", secrets: sensitiveValues }) };
  }
}
