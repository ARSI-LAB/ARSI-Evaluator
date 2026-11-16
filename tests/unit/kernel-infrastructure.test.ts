import { expect, test } from "vitest";
import { kernelBenchVerdict, kernelVerdict } from "../../src/plugins/benchmarks/operator/kernel/result.js";
import { parseKernelContract } from "../../src/plugins/benchmarks/operator/kernel/strict.js";
import { VerificationError } from "../../src/core/errors/verification-error.js";

const sha = "a".repeat(64);
const failure = { operation: "precision", candidateSha256: sha, referenceKind: "pytorch", timingScope: "all-device-kernels",
  status: "infrastructure_error", error: "worker timed out", code: "WORKER_TIMEOUT", retryable: true,
  errorOwnership: "evaluation", diagnostics: [{ message: "stderr tail" }],
  referenceMs: null, candidateMs: null, speedup: null };

function evidence(run: () => unknown): Record<string, unknown> {
  try { run(); } catch (error) {
    expect(error).toBeInstanceOf(VerificationError);
    return (error as VerificationError).evidence as Record<string, unknown>;
  }
  throw new Error("expected a VerificationError");
}

test("retryable infrastructure results are surfaced with classification instead of a score", () => {
  const details = evidence(() => kernelVerdict(failure, sha, "pytorch", [], false, undefined, "precision"));
  expect(details).toMatchObject({ protocol: "kernel-v1", status: "infrastructure_error", code: "WORKER_TIMEOUT",
    retryable: true, errorOwnership: "evaluation", diagnostics: [{ message: "stderr tail" }] });
});

test("strict verification skips assessment validation for crashed workers", () => {
  const contract = parseKernelContract({ caseId: "case", inputs: [{ shape: [2], dtype: "float16", contiguous: true }],
    output: { shape: [2], dtype: "float16", contiguous: true, independent: true }, inputUnmodified: true });
  const strict = { contract, protocol: { seeds: [42], rtol: 0, atol: 0, warmup: 5, repeat: 20,
    tolerance: { mode: "explicit" as const, rtol: 0, atol: 0, safetyFactor: 10 } } };
  const details = evidence(() => kernelVerdict(failure, sha, "pytorch", [], false, strict, "precision"));
  expect(details).toMatchObject({ code: "WORKER_TIMEOUT", retryable: true });
});

test("bench verdicts also expose retryable infrastructure failures", () => {
  const details = evidence(() => kernelBenchVerdict({ ...failure, operation: "bench", timingScope: "triton-kernels",
    code: "WORKER_EXIT", error: "worker exited" }, sha, "pytorch"));
  expect(details).toMatchObject({ protocol: "kernel-bench/v1", status: "unavailable", code: "WORKER_EXIT", retryable: true });
});

test("malformed infrastructure classification is rejected rather than persisted", () => {
  for (const change of [
    { code: "UNKNOWN_CODE" }, { code: undefined }, { retryable: "yes" }, { retryable: undefined },
    { diagnostics: [] }, { diagnostics: undefined }, { diagnostics: [{ msg: "x" }] }, { diagnostics: ["x"] },
    { errorOwnership: "candidate" },
  ])
    expect(() => kernelVerdict({ ...failure, ...change }, sha, "pytorch", [], false, undefined, "precision")).toThrow();
});
