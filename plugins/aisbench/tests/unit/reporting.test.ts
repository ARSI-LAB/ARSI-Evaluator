import { expect, test } from "vitest";
import { classifyError, EvaluatorError } from "ember-evaluator";
import type { AttemptRecord, JsonValue, MetricResults, ResultSnapshot } from "ember-evaluator";
import { AisbenchPerformanceMetrics } from "../../metrics.js";
import { AisbenchMarkdownReporter } from "../../reporter.js";
import { aisbenchRecord, aisbenchSnapshot, aisbenchSummary } from "../fixtures/results.js";

const compute = (snapshot: ResultSnapshot) => new AisbenchPerformanceMetrics().compute(snapshot);
const recordOf = (snapshot: ResultSnapshot): AttemptRecord => {
  const record = snapshot.records[0];
  if (!record) throw new Error("Missing fixture record");
  return record;
};
async function render(snapshot: ResultSnapshot, extra: MetricResults = {}): Promise<string> {
  return new AisbenchMarkdownReporter().render(snapshot, { "aisbench-performance": await compute(snapshot), ...extra });
}

test("saved performance observations rebuild every CSV field without producing scores", async () => {
  const snapshot = aisbenchSnapshot();
  const result = await compute(snapshot);
  expect(result).toMatchObject({ applicable: true, points: [{ taskId: snapshot.run.taskIds[0], status: "completed",
    measurement: { rows: [{ total_req: "160", qps: "3.4", "P99 TTFT": "8.1" }] } }] });
  expect(JSON.stringify(result)).not.toMatch(/"score"|"passed"/u);
});

test.each(["failed", "cancelled"] as const)("%s attempts never reuse stale measurements", async state => {
  const snapshot = aisbenchSnapshot();
  recordOf(snapshot).executionStatus = state;
  expect(await compute(snapshot)).toMatchObject({ points: [{ status: state === "failed" ? "invalid" : "cancelled", measurement: null }] });
  const markdown = await render(snapshot);
  expect(markdown).toContain("未完成");
  expect(markdown).not.toContain("| qps | 3.4 |");
  expect(markdown).not.toMatch(/正确率|计 0 分|评分/u);
});

test.each(["solve", "verdict", "observations"] as const)("missing %s is an incomplete measurement", async missing => {
  const snapshot = aisbenchSnapshot(), record = recordOf(snapshot);
  if (missing === "observations" && record.solve) delete record.solve.observations;
  else if (missing === "solve") record.solve = null;
  else if (missing === "verdict") record.verdict = null;
  expect(await compute(snapshot)).toMatchObject({ points: [{ status: "incomplete", measurement: null }] });
  const markdown = await render(snapshot);
  expect(markdown).toContain("未完成");
  expect(markdown).toContain("无有效测量证据");
  expect(markdown).toContain("0/1");
});

test("pending tasks and unknown source remain explicitly unmeasured", async () => {
  const snapshot = aisbenchSnapshot();
  snapshot.records = [];
  snapshot.pendingTaskIds = [...snapshot.run.taskIds];
  expect(await compute(snapshot)).toMatchObject({ points: [{ status: "pending", measurement: null }] });
  expect(await render(snapshot)).toContain("pending");
  snapshot.run.source = null;
  snapshot.run.taskIds = [];
  snapshot.pendingTaskIds = [];
  expect(await compute(snapshot)).toMatchObject({ applicable: true, taskSetKnown: false, points: [] });
  expect(await render(snapshot)).toContain("任务集合未确定");
});

test("quality and other source snapshots are not AISBench measurements", async () => {
  const snapshot = aisbenchSnapshot();
  snapshot.run.evaluationKind = "quality";
  expect(await compute(snapshot)).toEqual({ applicable: false, points: [] });
  snapshot.run.evaluationKind = "performance";
  if (snapshot.run.source) snapshot.run.source.source = "different-benchmark";
  expect(await compute(snapshot)).toEqual({ applicable: false, points: [] });
});

test.each([
  ["foreign run", (s: ResultSnapshot) => { recordOf(s).key.runId = "different"; }],
  ["foreign task", (s: ResultSnapshot) => { recordOf(s).key.taskId = "different"; }],
  ["duplicate record", (s: ResultSnapshot) => { s.records.push(aisbenchRecord()); }],
  ["duplicate task", (s: ResultSnapshot) => { s.run.taskIds.push(...s.run.taskIds); }],
  ["wrong kind", (s: ResultSnapshot) => { recordOf(s).evaluationKind = "quality"; }],
  ["foreign pending task", (s: ResultSnapshot) => { s.pendingTaskIds = ["different"]; }],
  ["duplicate pending task", (s: ResultSnapshot) => { s.pendingTaskIds = [...s.run.taskIds, ...s.run.taskIds]; }],
] as const)("rejects %s rather than changing the selected task set", async (_name, corrupt) => {
  const snapshot = aisbenchSnapshot();
  corrupt(snapshot);
  await expect(compute(snapshot)).rejects.toThrow(/run|task|kind|pending|duplicate/iu);
});

test("uses the host-selected record even when an older attempt exists in history", async () => {
  const snapshot = aisbenchSnapshot();
  const previous = aisbenchRecord();
  previous.key.attemptId = "old-attempt";
  previous.executionStatus = "failed";
  snapshot.attemptHistory = [{ key: previous.key, ordinal: 1, allocatedAt: previous.startedAt, record: previous }];
  expect(await compute(snapshot)).toMatchObject({ points: [{ status: "completed" }] });
});

test.each<[string, JsonValue]>([
  ["changed bundle", { ...aisbenchSummary(), bundleDigest: "b".repeat(64) }],
  ["changed workload", { ...aisbenchSummary(), workload: { ...aisbenchSummary().workload, concurrency: 8 } }],
  ["malformed rows", { ...aisbenchSummary(), rows: [] }],
])("rejects %s in persisted evidence", async (_name, observations) => {
  const snapshot = aisbenchSnapshot();
  const solve = recordOf(snapshot).solve;
  if (solve) solve.observations = observations;
  await expect(compute(snapshot)).rejects.toThrow();
});

test.each([{ passed: true, details: {} }, { passed: null, score: 0, details: {} }])(
  "performance evidence rejects a correctness verdict %j", async verdict => {
    const snapshot = aisbenchSnapshot();
    recordOf(snapshot).verdict = verdict;
    await expect(compute(snapshot)).rejects.toThrow(/performance|score|passed/iu);
  });

test("report shows workload, prefix conditions, versions, source, CSV rows and collection without invented links", async () => {
  const snapshot = aisbenchSnapshot();
  const observations = aisbenchSummary();
  observations.rows = [{ total_req: "80", qps: "2", "P99 TTFT": "9" }, ...observations.rows];
  const solve = recordOf(snapshot).solve;
  if (solve) solve.observations = observations;
  const markdown = await render(snapshot);
  for (const text of ["性能测量已完成", "fixture-model", "aisbench-ssh", "v24.22.1", "fixture-plugin-version",
    "ac06bd619726663ac8c7b0c84c9b3cdbb041b062", "2048", "512", "160", "16", "stream", "prefixCount", "prefixRatio", "warmup", "seed", "42",
    "| qps | 2 |", "| qps | 3.4 |", "P99 TTFT", "a".repeat(64), "aisbench_result.csv", "aisbench-summary.json", "complete", "not-produced"])
    expect(markdown).toContain(text);
  expect(markdown).not.toMatch(/\]\(|tasks\/|attempts\//u);
});

test("report preserves failed collection, cleanup, cancellation, initialization diagnostics and unknown usage", async () => {
  const snapshot = aisbenchSnapshot(), record = recordOf(snapshot);
  snapshot.run.status = "cancelled";
  snapshot.run.failure = classifyError(new EvaluatorError("RUN_CANCELLED", "operator cancelled"), { phase: "solve" });
  snapshot.run.initializationFailures = [classifyError(new EvaluatorError("BENCHMARK_UNSUPPORTED", "preflight failed"), { phase: "prepare" })];
  record.cleanupStatus = "unconfirmed";
  record.collection.artifacts = "partial";
  record.errors = [classifyError(new EvaluatorError("CLEANUP_FAILED", "remote cancellation unconfirmed"), { phase: "cleanup" })];
  record.warnings = [{ phase: "collect", code: "ARTIFACT_COLLECTION_INCOMPLETE", message: "artifact unavailable" }];
  const markdown = await render(snapshot);
  for (const text of ["未完成", "cancelled", "operator cancelled", "preflight failed", "unconfirmed", "partial", "CLEANUP\\_FAILED", "remote cancellation unconfirmed", "artifact unavailable"])
    expect(markdown).toContain(text);
  expect(markdown).toContain("—");
  expect(markdown).not.toMatch(/正确率|计 0 分|评分/u);
});

test("report includes elapsed and supplied duration/usage metrics including unknown values", async () => {
  const snapshot = aisbenchSnapshot();
  const markdown = await render(snapshot, {
    duration: { runWallTimeMs: 2000, tasks: { count: 1, meanMs: 2000, minMs: 2000, maxMs: 2000 }, phases: { solve: { count: 1, meanMs: 1500 } } },
    usage: { selected: 1, recorded: 1, inputTokens: { total: 321, covered: 1 }, outputTokens: { total: null, covered: 0 }, totalTokens: { total: null, covered: 0 } },
  });
  for (const text of ["耗时", "用量", "2000", "1500", "321", "covered", "—"]) expect(markdown).toContain(text);
});

test("Markdown escapes untrusted table cells, headings, diagnostic text and HTML", async () => {
  const snapshot = aisbenchSnapshot(), record = recordOf(snapshot), summary = aisbenchSummary();
  summary.aisbenchVersion = "<script>x</script> [bad](https://bad)";
  summary.rows = [{ total_req: "160", qps: "3.4", "TTFT|P99": "10|20\n<script>bad</script>" }];
  if (record.solve) record.solve.observations = summary;
  snapshot.run.runId = record.key.runId = "run|bad\n# heading";
  snapshot.run.configSummary = { model: "[bad](https://bad)", apiKey: "do-not-print" };
  const markdown = await render(snapshot);
  expect(markdown).toContain("TTFT\\|P99");
  expect(markdown).toContain("10\\|20");
  expect(markdown).toContain("&lt;script&gt;");
  expect(markdown).toContain("\\[bad\\]\\(https://bad\\)");
  expect(markdown).not.toMatch(/<script>|\n# heading|do-not-print/u);
});

test("report rejects forged metric points and malformed supplied CSV rather than displaying false success", async () => {
  const snapshot = aisbenchSnapshot();
  const forged: JsonValue = { applicable: true, points: [{ taskId: "foreign", status: "completed", measurement: aisbenchSummary() }] };
  await expect(new AisbenchMarkdownReporter().render(snapshot, { "aisbench-performance": forged })).rejects.toThrow();
  const malformed: JsonValue = { applicable: true, points: [{ taskId: recordOf(snapshot).key.taskId, status: "completed", measurement: { ...aisbenchSummary(), rows: [] } }] };
  await expect(new AisbenchMarkdownReporter().render(snapshot, { "aisbench-performance": malformed })).rejects.toThrow();
});
