import type { ResultSnapshot } from "../../../../src/index.js";
import { storeRecord, fixtureFailure } from "../store-fixture.js";

const first = storeRecord({ runId: "mixed", taskId: "pass", attemptId: "a1" });
first.durationMs = 100; first.phaseDurationMs = { solve: 80, verify: 10 };
first.solve!.usage = { inputTokens: 5, outputTokens: 2, totalTokens: 7 };
const second = storeRecord({ runId: "mixed", taskId: "wrong", attemptId: "a2" });
second.durationMs = 40; second.phaseDurationMs = { solve: 30, verify: 5 };
second.verdict = { score: 0, passed: false, details: {} };
second.solve!.usage = { inputTokens: null, outputTokens: 3, totalTokens: null };
const third = storeRecord({ runId: "mixed", taskId: "error", attemptId: "a3" });
third.durationMs = 20; third.phaseDurationMs = { environment: 20 };
third.executionStatus = "failed"; third.scoreStatus = third.evaluationKind === "performance" ? "not-applicable" : "invalid"; third.solve = null; third.verdict = null;
third.errors = [fixtureFailure("environment", "ENV_PREPARATION_FAILED", "fixture failure")];

export const mixedSnapshot: ResultSnapshot = {
  run: {
    schemaVersion: 1, evaluationKind: "quality", runId: "mixed", source: { source: "fixture", revision: "locked", files: [], metadata: {} },
    taskIds: ["pass", "wrong", "error", "pending"], configFingerprint: "config-fingerprint", pluginVersions: { fixture: "1" },
    startedAt: "2026-09-18T00:00:00Z", finishedAt: "2026-09-18T00:00:00.100Z", durationMs: 100, status: "cancelled",
  },
  records: [first, second, third], pendingTaskIds: ["pending"], digest: "snapshot-digest",
};
