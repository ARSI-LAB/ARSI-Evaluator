import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { parseKernelScopeTiming } from "../../src/plugins/benchmarks/operator/kernel/timing.js";
import { kernelBenchVerdict, kernelVerdict } from "../../src/plugins/benchmarks/operator/kernel/result.js";
import { parseKernelConfig } from "../../src/plugins/benchmarks/operator/kernel/index.js";

const golden = JSON.parse(readFileSync(new URL("../fixtures/kernel-scope-timing.json", import.meta.url), "utf8")) as {
  timingScope: "all-device-kernels"; timing: Record<string, unknown> };
const sha = "a".repeat(64);

test("golden scope timing payload parses with per-scope statistics and launch count", () => {
  const parsed = parseKernelScopeTiming(golden.timing);
  expect(parsed.launchCount).toBe(122);
  expect(parsed.device).toMatchObject({ count: 5, meanMs: 0.00464, p50Ms: 0.0044, p95Ms: 0.0052 });
  expect(parsed.host?.p50Ms).toBe(0.1138);
  expect(parsed.endToEnd?.p95Ms).toBe(0.1353);
  for (const timing of [
    { ...golden.timing, device: undefined },
    { ...golden.timing, launchCount: 0 },
    { ...golden.timing, device: { ...parsed.device, count: 4 } },
    { ...golden.timing, host: { ...parsed.host, samples: [1, -1, 1, 1, 1] } },
    { ...golden.timing, extra: 1 },
  ]) expect(() => parseKernelScopeTiming(timing)).toThrow();
});

test("kernel verdict carries candidate scope timing and rejects identity mismatches", () => {
  const candidateMs = (golden.timing.device as { meanMs: number }).meanMs;
  const value = { operation: "evaluate", candidateSha256: sha, referenceKind: "pytorch", timingScope: "all-device-kernels",
    status: "passed", error: "", referenceMs: 0.02, candidateMs, speedup: 0.02 / candidateMs,
    timing: golden.timing, launchCount: 122 };
  const verdict = kernelVerdict(value, sha, "pytorch", []);
  expect(verdict.passed).toBe(true);
  expect((verdict.details as Record<string, unknown>).timing).toMatchObject({ launchCount: 122 });
  expect(() => kernelVerdict({ ...value, launchCount: 121 }, sha, "pytorch", [])).toThrow(/launchCount/);
  expect(() => kernelVerdict({ ...value, candidateMs: candidateMs * 1.01, speedup: 0.02 / (candidateMs * 1.01) }, sha, "pytorch", []))
    .toThrow(/scope timing/);
  expect(() => kernelVerdict({ ...value, status: "incorrect", referenceMs: null, candidateMs: null, speedup: null }, sha, "pytorch", []))
    .toThrow(/timing scores/);
});

test("kernel bench verdict accepts scope timing for completed timing-only runs", () => {
  const candidateMs = (golden.timing.device as { meanMs: number }).meanMs;
  const value = { operation: "bench", candidateSha256: sha, referenceKind: "pytorch", timingScope: "triton-kernels",
    status: "completed", error: "", referenceMs: null, candidateMs, speedup: null,
    timing: golden.timing, launchCount: 122 };
  const verdict = kernelBenchVerdict(value, sha, "pytorch");
  expect((verdict.details as Record<string, unknown>).timing).toMatchObject({ launchCount: 122 });
  expect(() => kernelBenchVerdict({ ...value, launchCount: 121 }, sha, "pytorch")).toThrow(/launchCount/);
});

test("kernel config parses timing scopes and launch-count hints", () => {
  expect(parseKernelConfig({ manifest: "m" })).toMatchObject({ timing: { scopes: ["device"], statistics: ["mean"] }, callCount: 1 });
  expect(parseKernelConfig({ manifest: "m", timing: { scopes: ["device", "host", "endToEnd"], statistics: ["mean", "p50", "p95"] }, callCount: 122 }))
    .toMatchObject({ timing: { scopes: ["device", "host", "endToEnd"] }, callCount: 122 });
  for (const timing of [{ scopes: ["host"] }, { scopes: [] }, { scopes: ["device", "device"] },
    { statistics: ["median"] }, { scopes: ["gpu"] }, { extra: true }])
    expect(() => parseKernelConfig({ manifest: "m", timing })).toThrow();
  expect(() => parseKernelConfig({ manifest: "m", callCount: 0 })).toThrow(/callCount/);
});

test("python scope timing helpers collect per-iteration samples without an NPU", () => {
  execFileSync("python3", [fileURLToPath(new URL("./test_kernel_timing_scopes.py", import.meta.url))], { timeout: 10000 });
});
