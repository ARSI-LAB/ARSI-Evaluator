import { fingerprintConfig } from "ember-evaluator";
import type { AttemptRecord, ResultSnapshot } from "ember-evaluator";
import type { AisbenchSummary } from "../../evidence.js";

/** Public-contract fixtures; no store internals or runtime credentials are required. */
export function aisbenchSummary(): AisbenchSummary {
  return {
    schemaVersion: 1, kind: "aisbench", bundleDigest: "a".repeat(64), aisbenchVersion: "1.0.0",
    workload: {
      inputLength: 2048, outputLength: 512, dataCount: 160, concurrency: 16, requestRate: 0, testType: "stream",
      prefixCache: { enabled: true, prefixCount: 2, prefixRatio: 0.5, warmup: true, dp: 4, seed: 42 },
    },
    rows: [{ total_req: "160", qps: "3.4", "P99 TTFT": "8.1" }],
  };
}

export function aisbenchRecord(): AttemptRecord {
  const summary = aisbenchSummary();
  return {
    key: { runId: "run-1", taskId: `aisbench-${fingerprintConfig(summary.workload).slice(-16)}`, attemptId: "attempt-1" },
    evaluationKind: "performance", executionStatus: "completed", scoreStatus: "not-applicable", cleanupStatus: "cleaned",
    solve: { finalText: "AISBench completed", usage: { inputTokens: null, outputTokens: null, totalTokens: null }, observations: summary },
    verdict: { passed: null, details: { measurement: "aisbench", rowCount: 1, aisbenchVersion: "1.0.0" } }, errors: [],
    collection: { trajectory: "not-produced", artifacts: "complete" }, environments: { solve: null, verify: null },
    startedAt: "2026-11-02T00:00:00.000Z", finishedAt: "2026-11-02T00:00:02.000Z", durationMs: 2000,
    phaseDurationMs: { solve: 1500, verify: 100, collect: 200, cleanup: 200 },
  };
}

export function aisbenchSnapshot(): ResultSnapshot {
  const record = aisbenchRecord();
  return {
    run: {
      schemaVersion: 1, executionVersion: 2, evaluationKind: "performance", runId: "run-1",
      source: { source: "github:rayn-zzz/aisbench_auto_tools_prefix", revision: "ac06bd619726663ac8c7b0c84c9b3cdbb041b062",
        files: [], metadata: { bundleDigest: "a".repeat(64) } },
      taskIds: [record.key.taskId], configFingerprint: "fixture-config",
      configSummary: { benchmark: "aisbench", solver: "aisbench-ssh", model: "fixture-model", environment: "local", scheduler: "local" },
      identity: { evaluator: { name: "ember-evaluator", version: "0.1.0" }, runtime: { node: "v24.22.1", platform: "linux", arch: "x64" } },
      pluginVersions: { "aisbench-plugin": "fixture-plugin-version" },
      startedAt: record.startedAt, finishedAt: record.finishedAt, durationMs: 2000, status: "completed",
    },
    records: [record], pendingTaskIds: [], digest: "fixture-snapshot",
  };
}
