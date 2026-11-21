import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { parseKernelTolerance, resolveTolerance, type KernelTolerance, type KernelToleranceConfig } from "../../src/plugins/benchmarks/operator/kernel/tolerance.js";
import { KERNEL_CHECK_IDS, kernelContractDigest, parseKernelContract } from "../../src/plugins/benchmarks/operator/kernel/strict.js";
import { kernelVerdict } from "../../src/plugins/benchmarks/operator/kernel/result.js";
import { parseKernelConfig } from "../../src/plugins/benchmarks/operator/kernel/index.js";

const sha = "a".repeat(64);
const config = (mode: KernelToleranceConfig["mode"], rtol = 0, atol = 0): KernelToleranceConfig =>
  ({ mode, rtol, atol, safetyFactor: 10 });

test("worker tolerance provenance is validated strictly", () => {
  expect(parseKernelTolerance({ mode: "frozen", rtol: 0.001, atol: 0.002, source: "frozen", observedMaxAbs: 0.5 }))
    .toEqual({ mode: "frozen", rtol: 0.001, atol: 0.002, source: "frozen", observedMaxAbs: 0.5 });
  for (const value of [
    { mode: "loose", rtol: 0, atol: 0, source: "x" },
    { mode: "explicit", rtol: -1, atol: 0, source: "x" },
    { mode: "explicit", rtol: 0, atol: 0, source: "" },
    { mode: "explicit", rtol: 0, atol: 0, source: "x", extra: 1 },
  ]) expect(() => parseKernelTolerance(value)).toThrow();
});

test("expected tolerance resolves from the contract dtype and rejects observed without evidence", () => {
  expect(resolveTolerance("float16", config("dtype"))).toEqual({ mode: "dtype", rtol: 1e-3, atol: 1e-3, source: "contract.output.dtype=float16" });
  expect(resolveTolerance("bfloat16", config("dtype"))).toMatchObject({ rtol: 1e-3, atol: 1e-3 });
  expect(resolveTolerance("float32", config("dtype"))).toMatchObject({ rtol: 5e-4, atol: 5e-4 });
  expect(resolveTolerance("int64", config("dtype"))).toMatchObject({ rtol: 0, atol: 0 });
  expect(resolveTolerance("float8_e4m3fn", config("dtype"))).toMatchObject({ rtol: 5e-4 });
  expect(resolveTolerance("float16", config("explicit", 0.01, 0.02))).toEqual({ mode: "explicit", rtol: 0.01, atol: 0.02, source: "explicit" });
  expect(resolveTolerance("float16", config("frozen", 0.01, 0.02))).toMatchObject({ mode: "frozen", rtol: 0.01, atol: 0.02 });
  expect(() => resolveTolerance("float16", config("observed"))).toThrow(/preflight/);
});

test("kernel config parses tolerance modes and refuses unresolved observed mode", () => {
  expect(parseKernelConfig({ manifest: "m" })).toMatchObject({ tolerance: { mode: "explicit", rtol: 0.001, atol: 0.001, safetyFactor: 10 } });
  expect(parseKernelConfig({ manifest: "m", rtol: 0, tolerance: { mode: "dtype" } })).toMatchObject({ tolerance: { mode: "dtype", rtol: 0 } });
  expect(parseKernelConfig({ manifest: "m", tolerance: { rtol: 0.2, atol: 0.3, safetyFactor: 4 } }))
    .toMatchObject({ tolerance: { rtol: 0.2, atol: 0.3, safetyFactor: 4 } });
  for (const tolerance of [{ mode: "observed" }, { mode: "loose" }, { safetyFactor: 0 }, { rtol: -1 }, { extra: true }])
    expect(() => parseKernelConfig({ manifest: "m", tolerance })).toThrow();
});

const contract = parseKernelContract({
  caseId: "case", inputs: [{ shape: [2], dtype: "float16", contiguous: true }],
  output: { shape: [2], dtype: "float16", contiguous: true, independent: true }, inputUnmodified: true });
const tolerance: KernelTolerance = { mode: "dtype", rtol: 1e-3, atol: 1e-3, source: "contract.output.dtype=float16" };
const assessment = () => ({
  contractSha256: kernelContractDigest(contract),
  checks: [0, 1].flatMap(call => KERNEL_CHECK_IDS.map(id => ({ id, seed: 42, call, status: "passed", message: "" }))),
  effectiveProtocol: { seeds: [42], rtol: 1e-3, atol: 1e-3, warmup: 5, repeat: 20,
    timingScope: "all-device-kernels", aggregation: "iteration-mean", timingSeed: 42, tolerance: { ...tolerance } },
  environment: { python: "p", torch: "p", torchNpu: "p", triton: "p", cann: "p", driver: "p", device: "p", visibleDevices: "0" },
  errorOwnership: null,
});
const strict = { contract, protocol: { seeds: [42], rtol: 0, atol: 0, warmup: 5, repeat: 20, tolerance: config("dtype", 0, 0) } };

test("strict verdict rejects worker tolerance that disagrees with the configured resolution", () => {
  const value = { operation: "evaluate", candidateSha256: sha, referenceKind: "pytorch", timingScope: "all-device-kernels",
    status: "passed", error: "", referenceMs: 2, candidateMs: 1, speedup: 2, tolerance, assessment: assessment() };
  const loose = assessment();
  loose.effectiveProtocol.rtol = 5e-4;
  expect(() => kernelVerdict({ ...value, assessment: loose }, sha, "pytorch", [], false, strict))
    .toThrow(/Effective tolerance mismatch: rtol/);
  const wrongMode = assessment();
  wrongMode.effectiveProtocol.tolerance = { mode: "explicit", rtol: 1e-3, atol: 1e-3, source: "explicit" };
  expect(() => kernelVerdict({ ...value, assessment: wrongMode }, sha, "pytorch", [], false, strict))
    .toThrow(/tolerance mode/);
  const changedProvenance = { ...tolerance, source: "dtype" };
  expect(() => kernelVerdict({ ...value, tolerance: changedProvenance }, sha, "pytorch", [], false, strict))
    .toThrow(/Tolerance provenance/);
});

test("kernel verdict validates worker error distribution evidence", () => {
  const base = { operation: "precision", candidateSha256: sha, referenceKind: "pytorch", timingScope: "all-device-kernels",
    status: "passed", error: "", referenceMs: null, candidateMs: null, speedup: null };
  const stats = { count: 8, maxAbs: 0.5, maxRel: 0.25, p50Abs: 0.1, p90Abs: 0.4, p99Abs: 0.49,
    "mismatch_gt_1e-4": 0.5, "mismatch_gt_5e-4": 0.25, "mismatch_gt_1e-3": 0.125 };
  expect((kernelVerdict({ ...base, errorStats: stats }, sha, "pytorch", [], false, undefined, "precision").details as Record<string, unknown>).errorStats)
    .toEqual(stats);
  for (const errorStats of [{ count: 1.5 }, { count: 1, bogus: 1 }, { maxAbs: 0.1 }, { count: 1, maxAbs: -0.1 },
    { count: 1, p50Abs: Number.NaN }])
    expect(() => kernelVerdict({ ...base, errorStats }, sha, "pytorch", [], false, undefined, "precision")).toThrow(/errorStats/);
});

test("python tolerance and error statistics helpers run without an accelerator", () => {
  execFileSync("python3", [fileURLToPath(new URL("./test_kernel_tolerance.py", import.meta.url))], { timeout: 10000 });
});
