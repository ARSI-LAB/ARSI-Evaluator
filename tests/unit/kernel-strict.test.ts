import { expect, test } from "vitest";
import { parseKernelContract, parseKernelAssessment } from "../../src/plugins/benchmarks/operator/kernel/strict.js";
import { parseKernelManifest } from "../../src/plugins/benchmarks/operator/kernel/index.js";

const contract = { schemaVersion: 1, caseId: "fixed", inputs: [{ shape: [2, 4], dtype: "float16", contiguous: true }],
  output: { shape: [2, 2, 2], dtype: "float16", contiguous: true, independent: true }, inputUnmodified: true };
test("kernel manifest accepts and validates an explicit strict contract", () => {
  const task = { id: "t", problem: "p.py", candidate: "c.py", referenceKind: "pytorch", contract };
  expect(parseKernelManifest({ schemaVersion: 1, tasks: [task] })[0]?.contract).toEqual(contract);
  expect(() => parseKernelContract({ ...contract, output: { ...contract.output, shape: [0] } })).toThrow(/shape/);
  expect(() => parseKernelContract({ ...contract, unknown: true })).toThrow(/unknown/i);
});
test("strict manifests retain mixed floating dtypes, scalars and optional contiguity", () => {
  const mixed = { ...contract, inputs: [
    { shape: [], dtype: "float32", contiguous: true },
    { shape: [2, 3], dtype: "bfloat16", contiguous: false },
  ], output: { shape: [], dtype: "bfloat16", contiguous: true, independent: true } };
  const task = { id: "t", problem: "p.py", candidate: "c.py", referenceKind: "pytorch", contract: mixed };
  expect(parseKernelManifest({ schemaVersion: 1, tasks: [task] })[0]?.contract).toEqual(mixed);
  for (const change of [{ dtype: "int32" }, { dtype: "float64" }, { contiguous: 0 }, { shape: [2, 0] }])
    expect(() => parseKernelContract({ ...mixed, inputs: [{ ...mixed.inputs[0], ...change }] })).toThrow();
  expect(() => parseKernelContract({ ...mixed, output: { ...mixed.output, dtype: "int32" } })).toThrow();
  expect(kernelContractDigest(parseKernelContract(contract))).toBe("270f44b1b441eb2d52a40dcdd7fc201bfe8dba892ddcdfbfffffff8ed8c1ceb8");
});
test("strict assessment rejects missing checks and unknown check states", () => {
  expect(() => parseKernelAssessment({ schemaVersion: 1, checks: [] }, parseKernelContract(contract), [42])).toThrow();
});

import { kernelContractDigest, KERNEL_CHECK_IDS } from "../../src/plugins/benchmarks/operator/kernel/strict.js";
import { kernelVerdict } from "../../src/plugins/benchmarks/operator/kernel/result.js";
const parsed = parseKernelContract(contract);
const assessment = () => ({ schemaVersion: 1, contractSha256: kernelContractDigest(parsed),
  checks: [0, 1].flatMap(call => KERNEL_CHECK_IDS.map(id => ({ id, seed: 42, call, status: "passed", message: "" }))),
  effectiveProtocol: { seeds: [42], rtol: 0, atol: 0, warmup: 5, repeat: 20, timingScope: "all-device-kernels", aggregation: "iteration-mean", timingSeed: 42 },
  environment: { python: "fixture", torch: "fixture", torchNpu: "fixture", triton: "fixture", cann: "fixture", driver: "fixture", device: "fixture", visibleDevices: "0" }, errorOwnership: null });
test("strict assessment requires complete unique per-seed and per-call evidence", () => {
  expect(parseKernelAssessment(assessment(), parsed, [42]).checks).toHaveLength(16);
  const missing = assessment(); missing.checks.pop();
  expect(() => parseKernelAssessment(missing, parsed, [42])).toThrow(/Incomplete/);
  const duplicate = assessment(); duplicate.checks[1] = duplicate.checks[0]!;
  expect(() => parseKernelAssessment(duplicate, parsed, [42])).toThrow(/Duplicate/);
  expect(() => parseKernelAssessment(assessment(), parsed, [43])).toThrow();
  expect(() => parseKernelAssessment({ ...assessment(), contractSha256: "bad" }, parsed, [42])).toThrow(/identity/);
});
test("strict assessment retains complete native failure messages", () => {
  const value = assessment();
  value.checks[0]!.message = "x".repeat(5000);
  expect(parseKernelAssessment(value, parsed, [42]).checks[0]?.message).toHaveLength(5000);
});
test("many-seed assessment validation preserves check order with linear seed lookups", () => {
  let reads = 0;
  const seeds = new Proxy(Array.from({ length: 32 }, (_, i) => i), {
    get(target, key, receiver) {
      if (typeof key === "string" && /^\d+$/u.test(key)) reads++;
      return Reflect.get(target, key, receiver);
    },
  });
  const value = assessment();
  value.effectiveProtocol.seeds = [...seeds];
  value.effectiveProtocol.timingSeed = 31;
  value.checks = seeds.flatMap(seed => value.checks.map(check => ({ ...check, seed }))).reverse();
  reads = 0;
  expect(parseKernelAssessment(value, parsed, seeds).checks).toEqual(value.checks);
  expect(reads).toBeLessThan(4 * seeds.length);
});
const protocol = { seeds: [42], rtol: 0, atol: 0, warmup: 5, repeat: 20 };

test("strict verdict binds the worker's effective protocol to the requested settings", () => {
  const value = { schemaVersion: 1, candidateSha256: "a".repeat(64), referenceKind: "pytorch",
    timingScope: "all-device-kernels", status: "passed", error: "", referenceMs: 2, candidateMs: 1, speedup: 2,
    assessment: assessment() };
  const strict = { contract: parsed, protocol: { ...protocol, repeat: 21 } };
  expect(() => kernelVerdict(value, value.candidateSha256, "pytorch", false, strict)).toThrow(/Effective protocol mismatch: repeat/);
});

test("strict verdict refuses not-run checks and unattributed candidate defects", () => {
  const value = { schemaVersion: 1, candidateSha256: "a".repeat(64), referenceKind: "pytorch", timingScope: "all-device-kernels",
    status: "passed", error: "", referenceMs: 2, candidateMs: 1, speedup: 2, assessment: assessment() };
  expect(kernelVerdict(value, value.candidateSha256, "pytorch", false, { contract: parsed, protocol }).passed).toBe(true);
  value.assessment.checks[0]!.status = "not-run";
  expect(() => kernelVerdict(value, value.candidateSha256, "pytorch", false, { contract: parsed, protocol })).toThrow(/Strict checks/);
  expect(() => kernelVerdict({ ...value, status: "candidate_error", referenceMs: null, candidateMs: null, speedup: null }, value.candidateSha256, "pytorch", false, { contract: parsed, protocol })).toThrow(/evidence/);
});


test("strict performance verdict requires the observed environment identity", () => {
  const checks = { ...assessment(), environment: { ...assessment().environment, driver: null } };
  const value = { schemaVersion: 1, candidateSha256: "a".repeat(64), referenceKind: "pytorch", timingScope: "all-device-kernels",
    status: "passed", error: "", referenceMs: 2, candidateMs: 1, speedup: 2, assessment: checks };
  expect(() => kernelVerdict(value, value.candidateSha256, "pytorch", false, { contract: parsed, protocol })).toThrow(/environment/);
});

test("live mutable-input verdict requires preparation evidence for both timers", () => {
  const mutable = { ...parsed, inputUnmodified: false };
  const checks = assessment();
  checks.contractSha256 = kernelContractDigest(mutable);
  checks.effectiveProtocol.warmup = 1;
  checks.effectiveProtocol.repeat = 1;
  const value = { schemaVersion: 1, candidateSha256: "a".repeat(64), referenceKind: "pytorch", timingScope: "all-device-kernels",
    status: "passed", error: "", referenceMs: 0.001, candidateMs: 0.001, speedup: 1, assessment: checks };
  const sample = (side: string) => ({
    csvPath: `profile-${side}/kernel_details.csv`, csvSha256: "0".repeat(64),
    tracePath: `profile-${side}/trace_view.json`, traceSha256: "0".repeat(64), warmup: 1, repeat: 1, meanMs: 0.001,
    rows: [0, 1].map(step => ({ step, device: "0", stream: "1", name: "work", startUs: step, durationUs: 1 })),
  });
  const old = { schemaVersion: 2, method: "profiler-flow/v1", reference: sample("reference"), candidate: sample("candidate") };
  const verdict = (result: unknown) => kernelVerdict(result, value.candidateSha256, "pytorch", false, { contract: mutable, protocol: { ...protocol, warmup: 1, repeat: 1 } });
  expect(() => verdict(value)).toThrow(/prepare-then-run/);
  expect(() => verdict({ ...value, timingEvidence: old })).toThrow(/prepare-then-run/);
  expect(verdict({ ...value, timingEvidence: { ...old, reference: { ...old.reference, stepLayout: "prepare-then-run" },
    candidate: { ...old.candidate, stepLayout: "prepare-then-run" } } }).passed).toBe(true);
});
