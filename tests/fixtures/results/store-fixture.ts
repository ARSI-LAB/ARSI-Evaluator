import { classifyError } from "../../../src/core/errors/classify.js";
import { EvaluatorError } from "../../../src/core/errors/evaluator-error.js";
import type { ErrorCode } from "../../../src/core/errors/registry.js";
import type { Phase } from "../../../src/core/contracts/result.js";
import type { AttemptKey, AttemptRecord, RunManifest } from "../../../src/index.js";

export const storeRun: RunManifest = {
  schemaVersion: 1, evaluationKind: "quality", runId: "run-1", source: { source: "fixture", revision: "fixed", files: [], metadata: {} },
  taskIds: ["../../题目 a", "b"], configFingerprint: "config-hash", pluginVersions: { fixture: "1" },
  startedAt: "2026-09-18T00:00:00.000Z", finishedAt: null, durationMs: null, status: "running",
};
export const storeKey: AttemptKey = { runId: "run-1", taskId: "../../题目 a", attemptId: "attempt-1" };
export function trajectoryLines(sequence: number[] = [1, 2], key: AttemptKey = storeKey): string {
  return sequence.map((seq, index) => JSON.stringify({
    schemaVersion: 1, key, seq, at: "2026-09-18T00:00:00.000Z",
    type: index === 0 ? "start" : "end", data: null,
  }) + "\n").join("");
}
export function storeRecord(key: AttemptKey = storeKey): AttemptRecord {
  return {
    key, evaluationKind: "quality", executionStatus: "completed", scoreStatus: "valid", cleanupStatus: "cleaned", solve: { finalText: "Answer: 42", usage: { inputTokens: null, outputTokens: null, totalTokens: null } },
    verdict: { score: 1, passed: true, details: {} }, errors: [],
    collection: { trajectory: "not-produced", artifacts: "not-produced" }, environments: { solve: null, verify: null },
    startedAt: "2026-09-18T00:00:00.000Z", finishedAt: "2026-09-18T00:00:01.000Z", durationMs: 1000, phaseDurationMs: { solve: 900 },
  };
}

export const fixtureFailure = (phase: Phase, code: ErrorCode, message: string) =>
  classifyError(new EvaluatorError(code, message), { phase });
