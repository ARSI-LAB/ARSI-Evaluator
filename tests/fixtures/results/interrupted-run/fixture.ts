import type { AttemptSummary, AttemptRecord, RunManifest } from "../../../../src/core/contracts/result.js";
import { fixtureFailure, storeRecord, storeRun } from "../store-fixture.js";

export const cancelledRun: RunManifest = { ...storeRun, taskIds: ["a", "b", "c", "d"], status: "cancelled" };
export function attempt(taskId: string, executionStatus: AttemptRecord["executionStatus"] | null, ordinal = 1): AttemptSummary {
  const key = { runId: cancelledRun.runId, taskId, attemptId: `${taskId}-${ordinal}` };
  if (executionStatus === null) return { key, ordinal, allocatedAt: "2026-09-18T00:00:00Z", record: null };
  const record = storeRecord(key);
  record.executionStatus = executionStatus;
  if (executionStatus !== "completed") {
    record.solve = null; record.verdict = null;
    record.scoreStatus = executionStatus === "agent_timeout" ? "valid" : "invalid";
    record.errors = [fixtureFailure("solve", executionStatus === "agent_timeout" ? "SOLVER_AGENT_TIMEOUT" : "INTERNAL_ERROR", "fixture execution ended")];
  }
  return { key, ordinal, allocatedAt: "2026-09-18T00:00:00Z", record };
}
export const attemptSummaries = [attempt("a", "completed"), attempt("b", "completed"), attempt("c", "cancelled"), attempt("d", null)];
attemptSummaries[1]!.record!.verdict = { passed: false, score: 0, details: {} };
