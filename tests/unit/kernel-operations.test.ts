import { expect, test } from "vitest";
import { parseKernelConfig } from "../../src/plugins/benchmarks/operator/kernel/index.js";
import { kernelBenchVerdict, kernelVerdict } from "../../src/plugins/benchmarks/operator/kernel/result.js";

const sha = "a".repeat(64);
const files = [{ path: "kernel.py", sha256: sha }];

test("kernel YAML selects correctness-only and timing-only operations", () => {
  expect(parseKernelConfig({ manifest: "tasks.json", operation: "precision" }))
    .toMatchObject({ operation: "precision", seeds: [0, 1, 2], profiling: { enabled: false } });
  expect(parseKernelConfig({ manifest: "tasks.json", operation: "bench" }))
    .toMatchObject({ operation: "bench", seeds: [0], warmup: 25, repeat: 100, profiling: { enabled: false } });
  expect(parseKernelConfig({ manifest: "tasks.json" }).operation).toBe("evaluate");
  for (const operation of ["bench", "precision"]) {
    expect(() => parseKernelConfig({ manifest: "tasks.json", operation, profiling: { enabled: true } }))
      .toThrow(/profiling/i);
  }
  expect(() => parseKernelConfig({ manifest: "tasks.json", operation: "bench", seeds: [0, 1] })).toThrow(/single seed/i);
});

test("precision verdicts accept checks without timings and reject accidental timing scores", () => {
  const value = { candidateSha256: sha, referenceKind: "pytorch", operation: "precision", timingScope: "all-device-kernels",
    status: "passed", error: "", referenceMs: null, candidateMs: null, speedup: null };
  expect(kernelVerdict(value, sha, "pytorch", files, false, undefined, "precision"))
    .toMatchObject({ passed: true, score: 1, details: { operation: "precision", candidateMs: null, speedup: null } });
  expect(kernelVerdict({ ...value, status: "incorrect", error: "mismatch" }, sha, "pytorch", files, false, undefined, "precision"))
    .toMatchObject({ passed: false, score: 0 });
  expect(() => kernelVerdict({ ...value, candidateMs: 1 }, sha, "pytorch", files, false, undefined, "precision"))
    .toThrow(/precision.*timing/i);
});

test("bench validates candidate identity, scope and duration without creating correctness scores", () => {
  const value = { operation: "bench", candidateSha256: sha, referenceKind: "pytorch", timingScope: "triton-kernels",
    status: "completed", error: "", referenceMs: null, candidateMs: 0.125, speedup: null };
  expect(kernelBenchVerdict(value, sha, "pytorch")).toEqual({ passed: null, details: { ...value, protocol: "kernel-bench/v1" } });
  for (const candidateMs of [null, 0, -1, Infinity, NaN])
    expect(() => kernelBenchVerdict({ ...value, candidateMs }, sha, "pytorch")).toThrow(/measurement/);
  for (const patch of [{ operation: "precision" }, { timingScope: "all-device-kernels" }, { candidateSha256: "bad" }])
    expect(() => kernelBenchVerdict({ ...value, ...patch }, sha, "pytorch")).toThrow(/identity/);
  expect(() => kernelBenchVerdict({ ...value, status: "candidate_error" }, sha, "pytorch")).toThrow(/measurement/);
});
