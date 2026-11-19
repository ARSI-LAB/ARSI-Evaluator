import type { Metrics } from "../../../core/contracts/metrics.js";
import type { Reporter, TaskReportDocument } from "../../../core/contracts/reporter.js";
import type { RunStore } from "../../../core/contracts/run-store.js";
import { aggregateMetrics } from "../../metrics/aggregate.js";
import { taskReportSnapshot } from "./report-snapshot.js";

export async function saveReport(store: RunStore, metrics: Metrics[], reporter: Reporter, mode: "update" | "resume" = "update"): Promise<void> {
  const snapshot = await store.snapshot();
  const values = await aggregateMetrics(snapshot, metrics);
  const targets = reporter.taskReports?.(structuredClone(snapshot), structuredClone(values)) ?? [];
  const documents: TaskReportDocument[] = [];
  if (typeof store.saveReportBundle !== "function") throw new TypeError("RunStore must implement saveReportBundle()");
  const ids = new Set<string>(), tasks = new Set<string>();
  for (const target of targets) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/u.test(target.id) || ids.has(target.id.toLowerCase()) || tasks.has(target.taskId))
      throw new TypeError("Invalid or duplicate task report target");
    ids.add(target.id.toLowerCase()); tasks.add(target.taskId);
    const scoped = taskReportSnapshot(snapshot, target.taskId);
    const selected = await aggregateMetrics(scoped, metrics);
    documents.push({ ...target, snapshotDigest: scoped.digest, metrics: selected,
      markdown: await reporter.render(structuredClone(scoped), structuredClone(selected),
        { taskId: target.taskId, evidenceRoot: "../../" }) });
  }
  const markdown = await reporter.render(structuredClone(snapshot), structuredClone(values));
  await store.saveReportBundle(snapshot.digest, values, markdown, documents, mode);
}
