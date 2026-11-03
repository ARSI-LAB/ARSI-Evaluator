import type { Metrics } from "../../core/contracts/metrics.js";
import type { Phase, PreparationRound, ResultSnapshot } from "../../core/contracts/result.js";
import { selectedRecords } from "./records.js";

function distribution(values: number[]) {
  return {
    count: values.length,
    minMs: values.length ? values.reduce((a, b) => Math.min(a, b)) : null,
    maxMs: values.length ? values.reduce((a, b) => Math.max(a, b)) : null,
    meanMs: values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null,
  };
}

function observedConcurrency(intervals: { startedAt: string | null; finishedAt: string | null }[]): number | null {
  const events = intervals.flatMap(interval => {
    if (interval.startedAt === null || interval.finishedAt === null) return [];
    const start = Date.parse(interval.startedAt), end = Date.parse(interval.finishedAt);
    return end > start ? [{ at: start, change: 1 }, { at: end, change: -1 }] : [];
  });
  if (!events.length) return null;
  events.sort((a, b) => a.at - b.at || a.change - b.change);
  let active = 0, peak = 0;
  for (const event of events) { active += event.change; peak = Math.max(peak, active); }
  return peak;
}

function preparationMetrics(round: PreparationRound) {
  return {
    id: round.id, status: round.status, budgetSeconds: round.budgetSeconds,
    ...(round.timeoutPolicy ? { timeoutPolicy: round.timeoutPolicy } : {}),
    ...(round.nodeConcurrency ? { nodeConcurrency: round.nodeConcurrency } : {}),
    wallTimeMs: round.finishedAt === null ? null : Date.parse(round.finishedAt) - Date.parse(round.startedAt),
    ...(round.tasks ? {
      mode: round.mode ?? "batch", concurrency: round.concurrency ?? 1,
      observedPreparationConcurrency: observedConcurrency(round.tasks),
      queued: distribution(round.tasks.flatMap(task => task.queueDurationMs === null ? [] : [task.queueDurationMs])),
      tasks: distribution(round.tasks.flatMap(task => task.durationMs === null ? [] : [task.durationMs])),
      environmentTimeouts: round.tasks.flatMap(task => Object.entries(task.environmentTimeouts ?? {}).map(([phase, timing]) =>
        ({ taskId: task.taskId, phase, ...timing }))),
      environments: Object.fromEntries((["solveEnvironment", "verifyEnvironment"] as const).map(phase => [phase,
        distribution(round.tasks?.flatMap(task => {
          const elapsed = task.phaseDurationMs[phase];
          return elapsed === undefined ? [] : [elapsed];
        }) ?? []),
      ])),
      images: Object.fromEntries((["imageMs", "runtimeMs", "solverMs"] as const).map(phase => [phase,
        distribution(round.tasks?.flatMap(task => Object.values(task.imagePhaseDurationMs ?? {}).map(timing =>
          timing[phase])) ?? []),
      ])),
      cache: round.tasks.flatMap(task => Object.values(task.imagePhaseDurationMs ?? {}).flatMap(timing =>
        Object.entries(timing.cache ?? {}).map(([phase, source]) => ({ taskId: task.taskId, phase, source })))),
    } : {}),
  };
}

export function computeDuration(snapshot: ResultSnapshot) {
  const records = selectedRecords(snapshot);
  const latestRound = new Map<string, string>();
  for (const round of snapshot.run.preparationRounds ?? []) for (const taskId of round.taskIds) latestRound.set(taskId, round.id);
  const preparations = snapshot.run.preparationRounds?.flatMap(round => {
    const taskIds = round.taskIds.filter(taskId => latestRound.get(taskId) === round.id);
    if (!taskIds.length) return [];
    const tasks = round.tasks?.filter(task => taskIds.includes(task.taskId));
    return [{ ...round, taskIds, ...(tasks ? { tasks, status: tasks.every(task => task.status === "ready") ? "ready" as const : round.status } : {}) }];
  });
  const values: Partial<Record<Phase, number[]>> = {};
  for (const record of records)
    for (const [phase, elapsed] of Object.entries(record.phaseDurationMs)) {
      (values[phase as Phase] ??= []).push(elapsed);
    }
  return {
    runWallTimeMs: snapshot.run.durationMs,
    ...(preparations ? {
      preparation: preparations.map(preparationMetrics),
    } : {}),
    tasks: distribution(records.map(record => record.durationMs)),
    ...(records.some(record => record.readiness) ? {
      readyQueue: distribution(records.flatMap(record => record.readiness ? [record.readiness.queueDurationMs] : [])),
      observedExecutionConcurrency: observedConcurrency(records),
    } : {}),
    phases: Object.fromEntries(Object.entries(values).map(([phase, elapsed]) => [phase, distribution(elapsed)])),
  };
}

export class DurationMetrics implements Metrics {
  readonly name = "duration";
  async compute(snapshot: ResultSnapshot) {
    return computeDuration(snapshot);
  }
}
