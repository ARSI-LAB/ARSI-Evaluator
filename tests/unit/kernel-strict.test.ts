import { expect, test } from "vitest";
import { parseKernelContract, parseKernelAssessment, KERNEL_TENSOR_DTYPES } from "../../src/plugins/benchmarks/operator/kernel/strict.js";
import { parseKernelManifest } from "../../src/plugins/benchmarks/operator/kernel/index.js";

const contract = { schemaVersion: 1, caseId: "fixed", inputs: [{ shape: [2, 4], dtype: "float16", contiguous: true }],
  output: { shape: [2, 2, 2], dtype: "float16", contiguous: true, independent: true }, inputUnmodified: true };
test("kernel manifest accepts and validates an explicit strict contract", () => {
  const task = { id: "t", problem: "p.py", candidate: "c.py", referenceKind: "pytorch", contract };
  expect(parseKernelManifest({ schemaVersion: 1, tasks: [task] })[0]?.contract).toEqual(contract);
  expect(() => parseKernelContract({ ...contract, output: { ...contract.output, shape: [0] } })).toThrow(/shape/);
  expect(() => parseKernelContract({ ...contract, unknown: true })).toThrow(/unknown/i);
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
test("strict verdict refuses not-run checks and unattributed candidate defects", () => {
  const value = { schemaVersion: 1, candidateSha256: "a".repeat(64), referenceKind: "pytorch", timingScope: "all-device-kernels",
    status: "passed", error: "", referenceMs: 2, candidateMs: 1, speedup: 2, assessment: assessment() };
  expect(kernelVerdict(value, value.candidateSha256, "pytorch", false, parsed, [42]).passed).toBe(true);
  value.assessment.checks[0]!.status = "not-run";
  expect(() => kernelVerdict(value, value.candidateSha256, "pytorch", false, parsed, [42])).toThrow(/Strict checks/);
  expect(() => kernelVerdict({ ...value, status: "candidate_error", referenceMs: null, candidateMs: null, speedup: null }, value.candidateSha256, "pytorch", false, parsed, [42])).toThrow(/evidence/);
});


test("strict performance verdict requires the observed environment identity", () => {
  const checks = { ...assessment(), environment: { ...assessment().environment, driver: null } };
  const value = { schemaVersion: 1, candidateSha256: "a".repeat(64), referenceKind: "pytorch", timingScope: "all-device-kernels",
    status: "passed", error: "", referenceMs: 2, candidateMs: 1, speedup: 2, assessment: checks };
  expect(() => kernelVerdict(value, value.candidateSha256, "pytorch", false, parsed, [42])).toThrow(/environment/);
});

test("kernel contract accepts every v1 tensor dtype for inputs and outputs", () => {
  for (const dtype of KERNEL_TENSOR_DTYPES) {
    const value = { ...contract, inputs: [{ shape: [2, 4], dtype, contiguous: true }],
      output: { shape: [2, 2, 2], dtype, contiguous: true, independent: true } };
    expect(parseKernelContract(value)).toEqual(value);
  }
});

test("kernel contract accepts mixed integer and floating input dtypes", () => {
  const value = { ...contract,
    inputs: [{ shape: [2, 4], dtype: "int64", contiguous: true }, { shape: [4], dtype: "int32", contiguous: true },
      { shape: [2, 4], dtype: "float32", contiguous: true }],
    output: { shape: [2, 2, 2], dtype: "float32", contiguous: true, independent: true } };
  expect(parseKernelContract(value)).toEqual(value);
});

test("kernel contract rejects dtypes outside the v1 vocabulary and reports the observed value", () => {
  for (const dtype of ["half", "torch.float32", "fp32", "float8_e4m3fn", null, 42]) {
    expect(() => parseKernelContract({ ...contract, inputs: [{ shape: [2, 4], dtype, contiguous: true }] }))
      .toThrow(`Invalid contract tensor dtype/layout: ${String(dtype)}`);
  }
});

test("widening dtype validation preserves the existing float16 contract digest", () => {
  expect(kernelContractDigest(parseKernelContract(contract))).toBe("270f44b1b441eb2d52a40dcdd7fc201bfe8dba892ddcdfbfffffff8ed8c1ceb8");
});
