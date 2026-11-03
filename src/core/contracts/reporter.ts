import type { MetricResults } from "./metrics.js";
import type { ResultSnapshot } from "./result.js";

export type TaskReportTarget = { id: string; taskId: string; title: string };
export type ReportContext = { taskId: string; evidenceRoot: string };
export type TaskReportDocument = TaskReportTarget & {
  snapshotDigest: string;
  metrics: MetricResults;
  markdown: string;
};

export interface Reporter {
  /** Optional independent reports; each target selects exactly one persisted task. */
  taskReports?(snapshot: ResultSnapshot, metrics: MetricResults): TaskReportTarget[];
  render(snapshot: ResultSnapshot, metrics: MetricResults, context?: ReportContext): Promise<string>;
}
