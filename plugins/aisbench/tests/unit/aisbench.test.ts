import { expect, test } from "vitest";
import { AisbenchBenchmark, parseAisbenchConfig } from "../../benchmark.js";
import { parseAisbenchSummary } from "../../evidence.js";

const signal = new AbortController().signal;

test("AISBench locks one measurement point and verifies observations against its workload and bundle", async () => {
  const benchmark = new AisbenchBenchmark(parseAisbenchConfig({ workload: { concurrency: 4, dataCount: 12 } }));
  const source = await benchmark.resolveSource(null, signal);
  const refs = [];
  for await (const ref of benchmark.enumerate(source, signal)) refs.push(ref);
  expect(refs).toHaveLength(1);
  const ref = refs[0];
  if (!ref) throw new Error("Missing AISBench point");
  const task = await benchmark.prepare(ref, source, signal);
  const payload = task.input.payload;
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Missing AISBench payload");
  const summary = parseAisbenchSummary({ ...payload, aisbenchVersion: "1.0.0", rows: [{ total_req: "12", qps: "3.4", "P99 TTFT": "8.1" }] });
  const solve = { finalText: "done", usage: { inputTokens: null, outputTokens: null, totalTokens: null }, observations: summary };
  expect(await benchmark.verify(task, solve, null, signal)).toMatchObject({ passed: null });
  await expect(benchmark.verify(task, { ...solve, observations: { ...summary, bundleDigest: "0".repeat(64) } }, null, signal)).rejects.toThrow(/locked|bundle/iu);
  await expect(benchmark.resolveSource({ ...source, revision: "old" }, signal)).rejects.toThrow(/locked|source|bundle/iu);
  await expect(benchmark.prepare({ ...ref, id: "different" }, source, signal)).rejects.toThrow(/point|selection/iu);
});

test.each([{ wrong: true }, { workload: { concurrency: 0 } }, { workload: { dataCount: 1.5 } }, { workload: { prefixCache: { enabled: true, prefixRatio: 1.2 } } }])(
  "AISBench rejects invalid load configuration %j", config => expect(() => parseAisbenchConfig(config)).toThrow());

test("AISBench rejects empty or malformed CSV evidence", () => {
  const workload = parseAisbenchConfig({}).workload;
  const summary = { schemaVersion: 1, kind: "aisbench", workload, bundleDigest: "a".repeat(64), aisbenchVersion: "1.0", rows: [] };
  expect(() => parseAisbenchSummary(summary)).toThrow(/rows|CSV/iu);
  expect(() => parseAisbenchSummary({ ...summary, rows: [{ value: 12 }] })).toThrow();
  expect(() => parseAisbenchSummary({ ...summary, rows: [{}] })).toThrow();
  expect(() => parseAisbenchSummary({ ...summary, rows: [{ total_req: "160", qps: "" }] })).toThrow(/qps/iu);
  expect(() => parseAisbenchSummary({ ...summary, rows: [{ total_req: "1", qps: "3" }] })).toThrow(/total_req/iu);
  expect(() => parseAisbenchSummary({ ...summary, rows: [{ total_req: "160", qps: "NaN" }] })).toThrow(/qps/iu);
});

test("AISBench rejects incomplete workload conditions and mismatched CSV columns", () => {
  const workload = parseAisbenchConfig({}).workload;
  const summary = { schemaVersion: 1, kind: "aisbench", workload, bundleDigest: "a".repeat(64), aisbenchVersion: "1.0", rows: [{ total_req: "160", qps: "2" }] };
  expect(() => parseAisbenchSummary({ ...summary, workload: { dataCount: 160 } })).toThrow(/complete measurement conditions/iu);
  expect(() => parseAisbenchSummary({ ...summary, rows: [{ total_req: "80", qps: "2", latency: "3" }, { total_req: "160", qps: "2" }] })).toThrow(/different columns/iu);
});
