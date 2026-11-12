import { expect, test } from "vitest";
import { prefixProfilingPaths } from "../../src/plugins/benchmarks/operator/kernel/runtime/npu.js";
import { parseKernelProfiling, kernelVerdict } from "../../src/plugins/benchmarks/operator/kernel/result.js";
import { parseKernelConfig, parseKernelManifest } from "../../src/plugins/benchmarks/operator/kernel/index.js";
import { analyzeRoofline, DEFAULT_ROOFLINE_CONFIG } from "../../src/plugins/benchmarks/operator/kernel/roofline.js";
import { analyzeTraceEvents, getNpuSpecs, DEFAULT_NPU_DEVICE } from "../../src/plugins/benchmarks/operator/kernel/msprof-analysis.js";
import { KernelMetrics } from "../../src/plugins/metrics/kernel.js";
import { mixedSnapshot } from "../fixtures/results/mixed-run/fixture.js";
import { renderKernelTables } from "../../src/plugins/reporters/kernel-tables.js";

const sha = "a".repeat(64);
const outputPolicy = "kernel-original-f542-v1";
const singleFile = [{ path: "c.py", sha256: sha }];

test("prefixProfilingPaths rewrites artifacts and profileDir to verifier-relative", () => {
  const raw = { status: "completed", error: "",
    kernels: [{ name: "kernel_fn", metrics: {}, artifacts: ["profiling/x.csv"], metadata: { outputPolicy, profileDir: "profiling/OPPROF_a" } }],
    metadata: { outputPolicy, profileDir: "profiling/OPPROF_a", kernelCount: 1, sources: { candidateFiles: singleFile } }, artifacts: ["profiling/result.json"] };
  const out = prefixProfilingPaths(raw, "kernel-profile_profiling_root") as Record<string, any>;
  expect(out.artifacts).toEqual(["kernel-profile_profiling_root/profiling/result.json"]);
  expect(out.metadata.profileDir).toBe("kernel-profile_profiling_root/profiling/OPPROF_a");
  expect(out.metadata.kernelCount).toBe(1);
  expect(out.kernels[0].artifacts).toEqual(["kernel-profile_profiling_root/profiling/x.csv"]);
  expect(out.kernels[0].metadata.profileDir).toBe("kernel-profile_profiling_root/profiling/OPPROF_a");
  expect(parseKernelProfiling(out, singleFile)).toStrictEqual(out);
});

test("parseKernelConfig applies defaults and rejects unknown fields", () => {
  const config = parseKernelConfig({ manifest: "tasks.yaml" });
  expect(config).toMatchObject({ manifest: "tasks.yaml", python: "python3", device: 0,
    seeds: [0, 1, 2], rtol: 0.001, atol: 0.001, warmup: 5, repeat: 20 });
  expect(config.profiling).toMatchObject({ enabled: false, attemptTimeoutSeconds: 300, maxAttempts: 2, roundNum: 1, cacheEnabled: true });
  expect(() => parseKernelConfig({ manifest: "tasks.yaml", kernelRoot: "external" })).toThrow(/kernelRoot/);
  expect(() => parseKernelConfig({ manifest: "tasks.yaml", seeds: [1, 1] })).toThrow(/unique/);
  expect(() => parseKernelConfig({ manifest: "tasks.yaml", warmup: 0 })).toThrow(/warmup/);
});

test("parseKernelConfig derives timeout from profiling attempts", () => {
  const config = parseKernelConfig({ manifest: "m", profiling: { enabled: true, maxAttempts: 3, attemptTimeoutSeconds: 100 } });
  expect(config.timeoutSeconds).toBe(600);
  expect(config.profiling.enabled).toBe(true);
});

test("parseKernelManifest validates schema and relative files", () => {
  const manifest = parseKernelManifest({ tasks: [
    { id: "t1", problem: "p.py", candidateRoot: "candidate", candidate: "candidate/c.py", referenceKind: "pytorch", outputIndices: [0, 1] },
  ] });
  expect(manifest[0]).toMatchObject({ id: "t1", referenceKind: "pytorch" });
  expect(() => parseKernelManifest({ tasks: [
    { id: "t1", problem: "p.py", candidateRoot: "candidate", candidate: "candidate/c.py", referenceKind: "pytorch" },
    { id: "t1", problem: "p.py", candidateRoot: "candidate", candidate: "candidate/c.py", referenceKind: "pytorch" },
  ] })).toThrow(/Duplicate/);
  expect(() => parseKernelManifest({ tasks: [
    { id: "t1", problem: "p.py", candidateRoot: "candidate", candidate: "candidate/c.py", referenceKind: "onnx" },
  ] })).toThrow(/referenceKind/);
  expect(() => parseKernelManifest({ tasks: [
    { id: "t1", problem: "../escape.py", candidateRoot: "candidate", candidate: "candidate/c.py", referenceKind: "pytorch" },
  ] })).toThrow(/relative file/);
});

const validProfiling = {
  status: "completed", error: "",
  kernels: [{ name: "kernel0", metrics: { "0": { aiv_vec_ratio: 0.5 } }, metadata: { outputPolicy }, artifacts: [] }],
  metadata: { outputPolicy, sources: { candidateFiles: singleFile } },
  artifacts: ["profiling/original-result.json", "profiling/metrics-dataframe.csv"],
};

test("manifest candidateRoot preserves explicit import roots and rejects unsafe layouts", () => {
  const task = { id: "tree", problem: "problem.py", candidate: "candidate/kernels/kernel.py",
    candidateRoot: "candidate", files: ["candidate/kernels/__init__.py", "candidate/kernels/tiling.py"], referenceKind: "pytorch" };
  expect(parseKernelManifest({ tasks: [task] })[0]).toMatchObject(task);
  expect(() => parseKernelManifest({ tasks: [{ ...task, candidateRoot: undefined }] })).toThrow(/candidateRoot/);
  for (const candidateRoot of ["../candidate", "/candidate", "candidate/", ".", "candidate\\kernels"])
    expect(() => parseKernelManifest({ tasks: [{ ...task, candidateRoot }] })).toThrow(/relative/);
  for (const patch of [{ candidate: "outside.py" }, { problem: "candidate/reference.py" }, { candidateRoot: "candidate/kernels/kernel.py" }])
    expect(() => parseKernelManifest({ tasks: [{ ...task, ...patch }] })).toThrow(/candidateRoot/);
});

test("parseKernelProfiling rejects traversal and absolute artifact paths", () => {
  expect(parseKernelProfiling(validProfiling, singleFile)).toBeTruthy();
  for (const policy of [undefined, "kernel-last-block-v1"]) {
    expect(() => parseKernelProfiling({ ...validProfiling, metadata: { ...validProfiling.metadata, outputPolicy: policy } }, singleFile)).toThrow(/outputPolicy/);
    expect(() => parseKernelProfiling({ ...validProfiling, kernels: [{ ...validProfiling.kernels[0], metadata: { outputPolicy: policy } }] }, singleFile)).toThrow(/outputPolicy/);
  }
  for (const bad of [["../out.json", "x"], ["/abs/path.json", "x"], ["a\\b.json", "x"]]) {
    expect(() => parseKernelProfiling({ ...validProfiling, artifacts: bad }, singleFile)).toThrow(/verifier-relative/);
  }
  expect(() => parseKernelProfiling({ ...validProfiling, status: "unknown" }, singleFile)).toThrow(/identity/);
  expect(() => parseKernelProfiling({ ...validProfiling, kernels: "no" }, singleFile)).toThrow(/evidence/);
});

test("kernelVerdict accepts consistent passed timing and rejects mismatches", () => {
  const payload = { operation: "evaluate", candidateSha256: sha, referenceKind: "pytorch",
    timingScope: "all-device-kernels", status: "passed", error: "",
    referenceMs: 0.1, candidateMs: 0.05, speedup: 2, profiling: validProfiling };
  const verdict = kernelVerdict(payload, sha, "pytorch", singleFile, true);
  expect(verdict.passed).toBe(true);
  expect(verdict.score).toBe(1);
  const details = verdict.details as Record<string, unknown>;
  expect(details.protocol).toBe("kernel-v1");
  expect(details.speedup).toBe(2);
  // Reject speedup values that do not match the measured timings.
  expect(() => kernelVerdict({ ...payload, speedup: 3 }, sha, "pytorch", singleFile)).toThrow(/Inconsistent/);
  // Reject zero, negative and nonfinite measurements.
  expect(() => kernelVerdict({ ...payload, candidateMs: 0 }, sha, "pytorch", singleFile)).toThrow(/Invalid kernel measurement/);
});

test("kernelVerdict rejects failed results carrying scores and maps infra errors", () => {
  // Reject timing scores on failed results, including omitted fields (undefined !== null).
  const base = { operation: "evaluate", candidateSha256: sha, referenceKind: "pytorch",
    timingScope: "all-device-kernels", status: "incorrect", error: "mismatch",
    referenceMs: null, candidateMs: null, speedup: null };
  expect(() => kernelVerdict({ ...base, referenceMs: 0.1, candidateMs: 0.05, speedup: 2 }, sha, "pytorch", singleFile))
    .toThrow(/must not carry timing scores/);
  const failed = kernelVerdict(base, sha, "pytorch", singleFile);
  expect(failed).toMatchObject({ passed: false, score: 0 });
  expect(() => kernelVerdict({ ...base, status: "infrastructure_error" }, sha, "pytorch", singleFile)).toThrow(/infrastructure/);
  // Reject candidate SHA mismatches.
  expect(() => kernelVerdict({ ...base, status: "passed", referenceMs: 0.1, candidateMs: 0.05, speedup: 2 }, "b".repeat(64), "pytorch", singleFile)).toThrow(/identity/);
});

test("kernelVerdict adapts unparseable profiling instead of failing the run", () => {
  const payload = { operation: "evaluate", candidateSha256: sha, referenceKind: "pytorch",
    timingScope: "all-device-kernels", status: "passed", error: "",
    referenceMs: 0.1, candidateMs: 0.1, speedup: 1, profiling: {} };
  const verdict = kernelVerdict(payload, sha, "pytorch", singleFile);
  const profiling = (verdict.details as Record<string, unknown>).profiling as Record<string, unknown>;
  expect(profiling.status).toBe("failed");
  expect(profiling.metadata).toMatchObject({ adapterError: true });
});

test("evaluation profiling cannot publish a completed receipt without its declared candidate tree", () => {
  const candidateFiles = [{ path: "kernel.py", sha256: sha }, { path: "helper.py", sha256: "b".repeat(64) }];
  const value = { operation: "evaluate", candidateSha256: sha, referenceKind: "pytorch", timingScope: "all-device-kernels",
    status: "passed", error: "", referenceMs: 1, candidateMs: 1, speedup: 1, profiling: validProfiling };
  expect(kernelVerdict(value, sha, "pytorch", candidateFiles, true)).toMatchObject({ passed: true,
    details: { profiling: { status: "failed" } } });
  const profiling = { ...validProfiling, metadata: { ...validProfiling.metadata, sources: { candidateFiles } } };
  expect(kernelVerdict({ ...value, profiling }, sha, "pytorch", candidateFiles, true)).toMatchObject({
    details: { profiling: { status: "completed" } } });
});

test("offline kernel reports use current profile metadata and link only declared safe artifacts", async () => {
  const snapshot = structuredClone(mixedSnapshot);
  const kernel = validProfiling.kernels[0]!;
  const profiling = { ...validProfiling,
    kernels: [{ ...kernel, metadata: { outputPolicy, originalResultJson: "undeclared/unsafe.log" },
      artifacts: ["../outside.csv"] }] };
  snapshot.records[0]!.verdict = { passed: true, score: 1, details: { protocol: "kernel-v1", profiling } };
  const metrics = new KernelMetrics();
  const summary = await metrics.compute(snapshot);
  const report = renderKernelTables(summary).join("\n");
  expect(report).toContain("/profiling/original-result.json)");
  expect(report).not.toMatch(/undeclared|unsafe\.log|outside\.csv/u);
  profiling.kernels[0]!.metadata.outputPolicy = "kernel-last-block-v1";
  await expect(metrics.compute(snapshot)).rejects.toThrow(/outputPolicy/);
});

test("roofline picks the busiest pipe with underutilized priority", () => {
  const row = { aiv_scalar_ratio: 0.2, aiv_vec_ratio: 0.9, aiv_mte2_ratio: 0.3, aiv_mte3_ratio: 0.1, aiv_vec_time: 10 };
  const result = analyzeRoofline({ block0: row });
  expect(result.bottleneck).toBe("vec");
  expect(result.vec_rate).toBeCloseTo(0.9);
  expect(result.at_roofline).toBe(false);
  // Prefer underutilized ("no") when maximum utilization is below its threshold.
  const low = analyzeRoofline({ block0: { ...row, aiv_vec_ratio: 0.5 } });
  expect(low.bottleneck).toBe("no");
  expect(low.vec_rate).toBeCloseTo(0.5);
  // Apply the underutilized (0.8) gate before classifying pipeline bounds (0.4).
  const mid = analyzeRoofline({ block0: { ...row, aiv_vec_ratio: 0.9, aiv_scalar_ratio: 0.85 } });
  expect(mid.bottleneck).toBe("vec");
  // Warn on empty tables without throwing.
  expect(analyzeRoofline({}).warnings).toContain("Empty msprof_metrics");
});

test("npu specs lookup falls back to the default device", () => {
  expect(getNpuSpecs(DEFAULT_NPU_DEVICE)?.vector_count).toBe(56);
  expect(getNpuSpecs("UNKNOWN CHIP")).toBeNull();
});

test("renderKernelTables renders rows and hides metrics summary", () => {
  expect(renderKernelTables(undefined)).toEqual([]);
  const metric = { selected: 1, passed: 1, valid: 1, measured: 1, faster: 1, geometricMeanSpeedup: 2,
    rows: [{ taskId: "t1", valid: true, passed: true, referenceKind: "pytorch",
      referenceMs: 0.1, candidateMs: 0.05, speedup: 2, profilingRequested: false, profiling: null,
      evidencePath: "tasks/t1/attempts/a1" }] };
  const text = renderKernelTables(metric, "http://e/").join("\n");
  expect(text).toContain("## \u7b97\u5b50\u6b63\u786e\u6027\u4e0e\u6027\u80fd");
  expect(text).toContain("| t1 | true / true | pytorch | 0.1 | 0.05 | 2 |");
  expect(text).toContain("result.json");
});

test("analyzeTraceEvents ports the original trace analyzer semantics", () => {
  // Select core4, which has the longer span; the longest MTE2 duration indicates memory_bound_candidate.
  // MTE2 and VECTOR do not overlap; double buffering has no cross-iteration overlap and is ineffective.
  const ev = (pid: string, tid: string, ts: number, dur: number) => ({ pid, tid, ts, dur });
  const events = [
    ev("core3", "MTE2", 0, 10), ev("core3", "VECTOR", 0, 8),
    ev("core4.veccore1", "MTE2", 0, 20), ev("core4.veccore1", "MTE2", 30, 21),
    ev("core4.veccore1", "VECTOR", 25, 5), ev("core4.veccore1", "VECTOR", 55, 5),
    ev("core4.veccore1", "MTE3", 60, 4),
  ];
  const r = analyzeTraceEvents(events)!;
  expect(r.longest_core).toBe("core4.veccore1");
  expect(r.core_span_us).toBe(64);
  expect(r.bound.type).toBe("memory_bound_candidate");
  expect(r.bound.evidence).toBe("MTE2 has the largest trace duration (41.000000 us)");
  expect(r.pipeline.compute).toBe("VECTOR");
  expect(r.pipeline.mte2_compute_overlap_percent).toBe(0);
  expect(r.pipeline.pipeline_parallel).toBe(false);
  expect(r.double_buffer.status).toBe("ineffective_or_not_enabled");
  expect(r.double_buffer.comparable_rounds).toBe(1);
  expect(r.optimization_feedback).toEqual([
    "optimize data movement and improve data reuse", "check or enable Double Buffer"]);
  expect(r.bubble.mte2).toEqual({ count: 1, total_us: 10, max_us: 10 });
  // Return null for empty, non-array or kernel-free event inputs.
  expect(analyzeTraceEvents([])).toBeNull();
  expect(analyzeTraceEvents(undefined)).toBeNull();
  expect(analyzeTraceEvents([{ pid: "c", ts: 1, dur: 2 }])).toBeNull();
});

test.each(["bench", "precision", "profile"])("standalone kernel %s command is rejected", async operation => {
  const { parseArgs } = await import("../../src/cli.js");
  expect(() => parseArgs(["kernel", operation, "--problem", "p.py", "--kernel", "k.py", "--out", "o.json"]))
    .toThrow(/unknown command 'kernel'/);
});
