import { KERNEL_PROFILE_OUTPUT_POLICY } from "./msprof-csv.js";
import { parseKernelTimingEvidence } from "./timing.js";
import { expectNonEmptyString, expectRecord } from "../../../../core/validation/input.js";
import { VerificationError } from "../../../../core/errors/verification-error.js";
import type { JsonValue } from "../../../../core/contracts/task.js";
import type { VerifyResult } from "../../../../core/contracts/result.js";
import { parseKernelAssessment, type KernelContract, type KernelEffectiveProtocol } from "./strict.js";
import { isAbsolute, posix } from "node:path";

function finiteJson(value: unknown, label: string): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map((item, index) => finiteJson(item, `${label}[${index}]`));
  const record = expectRecord(value, label);
  return Object.fromEntries(Object.entries(record).map(([key, item]) => [key, finiteJson(item, `${label}.${key}`)]));
}

function artifactPaths(value: unknown): string[] {
  if (!Array.isArray(value)) throw new TypeError("Missing profiling artifacts");
  return value.map(artifact => {
    const path = expectNonEmptyString(artifact, "profiling.artifact");
    if (isAbsolute(path) || path.includes("\\") || /[\u0000-\u001f]/u.test(path) ||
        path.split("/").some(part => part === ".." || part === "." || !part) || posix.normalize(path) !== path)
      throw new TypeError("Profiling artifact must be a verifier-relative file without traversal");
    return path;
  });
}

export function assertKernelProfileOutputPolicy(profile: Record<string, unknown>): void {
  if (profile.status !== "completed") return;
  if (!Array.isArray(profile.kernels)) throw new TypeError("Missing kernel profiling evidence");
  for (const entry of [profile, ...profile.kernels]) {
    const metadata = expectRecord(expectRecord(entry, "profile entry").metadata, "profile metadata");
    if (metadata.outputPolicy !== KERNEL_PROFILE_OUTPUT_POLICY) throw new TypeError("Unsupported kernel profile outputPolicy");
  }
}

/** Validate the framework boundary; the profiler determines status, field availability and metric values. */
export function parseKernelProfiling(value: unknown, candidateFiles: { path: string; sha256: string }[]): { [key: string]: JsonValue } {
  const p = expectRecord(value, "kernel profiling");
  if ((p.status !== "completed" && p.status !== "failed") || typeof p.error !== "string")
    throw new TypeError("Invalid kernel profiling identity");
  if (!Array.isArray(p.kernels) || !Array.isArray(p.artifacts)) throw new TypeError("Missing kernel profiling evidence");
  assertKernelProfileOutputPolicy(p);
  const metadata = expectRecord(p.metadata, "profiling.metadata");
  if (metadata.profileDir !== undefined) artifactPaths([metadata.profileDir]);
  if (p.status === "completed" &&
      JSON.stringify(expectRecord(metadata.sources, "profiling sources").candidateFiles) !== JSON.stringify(candidateFiles))
    throw new VerificationError("Diagnostic candidate tree source mismatch", {});
  artifactPaths(p.artifacts);
  for (const value of p.kernels) {
    const kernel = expectRecord(value, "profiled kernel");
    expectNonEmptyString(kernel.name, "profiled kernel.name");
    expectRecord(kernel.metrics, "profiled kernel.metrics");
    if (kernel.artifacts !== undefined) artifactPaths(kernel.artifacts);
    const metadata = kernel.metadata === undefined ? {} : expectRecord(kernel.metadata, "profiled kernel.metadata");
    if (metadata.profileDir !== undefined) artifactPaths([metadata.profileDir]);
  }
  const result = finiteJson(p, "profiling");
  if (result === null || typeof result !== "object" || Array.isArray(result)) throw new TypeError("Invalid profiling object");
  return result;
}

/** Accept only complete, finite positive timings; infrastructure errors do not become candidate zero scores. */
export function kernelVerdict(value: unknown, candidateSha256: string, referenceKind: string,
  candidateFiles: { path: string; sha256: string }[], profilingRequested = false,
  strict?: { contract: KernelContract; protocol: Pick<KernelEffectiveProtocol, "seeds" | "rtol" | "atol" | "warmup" | "repeat"> },
  operation: "evaluate" | "precision" = "evaluate"): VerifyResult {
  const contract = strict?.contract;
  const r = expectRecord(value, "kernel result");
  if (r.operation !== operation || r.candidateSha256 !== candidateSha256 || r.referenceKind !== referenceKind ||
      r.timingScope !== "all-device-kernels" || typeof r.error !== "string") throw new Error("Invalid kernel result identity");
  const details: { [key: string]: JsonValue } = { protocol: "kernel-v1", operation, candidateSha256, referenceKind,
    timingScope: "all-device-kernels", status: typeof r.status === "string" ? r.status : "invalid", error: r.error,
    referenceMs: null, candidateMs: null, speedup: null,
    ...(profilingRequested ? { profilingRequested: true } : {}) };
  if (strict) {
    const assessment = parseKernelAssessment(r.assessment, strict.contract, strict.protocol.seeds);
    for (const name of ["rtol", "atol", "warmup", "repeat"] as const)
      if (assessment.effectiveProtocol[name] !== strict.protocol[name])
        throw new VerificationError(`Effective protocol mismatch: ${name}`, {});
    details.assessment = finiteJson(assessment, "assessment");
    if (r.status === "passed" && (assessment.errorOwnership !== null || assessment.checks.some(c => c.status !== "passed")))
      throw new VerificationError("Strict checks did not pass", details);
    if (r.status === "passed" && Object.values(assessment.environment).some(value => value === null))
      throw new VerificationError("Strict measurement environment identity unavailable", details);
    if ((r.status === "incorrect" || r.status === "candidate_error") &&
      (assessment.errorOwnership !== "candidate" || !assessment.checks.some(c => c.status === "failed")))
      throw new VerificationError("Candidate failure lacks strict evidence", details);
  }
  if (r.profiling !== undefined) {
    try { details.profiling = parseKernelProfiling(r.profiling, candidateFiles); }
    catch {
      // Do not copy unvalidated objects or exception messages into reports as unsafe evidence paths.
      details.profiling = { status: "failed", error: "Profiling result could not be adapted",
        kernels: [], metadata: { adapterError: true }, artifacts: [] };
    }
  } else if (profilingRequested && r.status === "passed") {
    details.profiling = { status: "failed", error: "Requested profiling did not return a result",
      kernels: [], metadata: { missingResult: true }, artifacts: [] };
  }
  if (r.status === "infrastructure_error") throw new VerificationError("Kernel evaluation infrastructure failed", details);
  if (r.status === "incorrect" || r.status === "candidate_error") {
    if (r.referenceMs !== null || r.candidateMs !== null || r.speedup !== null) throw new Error("Failed kernel must not carry timing scores");
    return { passed: false, score: 0, details };
  }
  if (r.status !== "passed") throw new Error("Unknown kernel evaluation status");
  if (operation === "precision") {
    if (r.referenceMs !== null || r.candidateMs !== null || r.speedup !== null || r.timingEvidence !== undefined)
      throw new VerificationError("Precision result must not carry timing measurements", details);
    return { passed: true, score: 1, details };
  }
  for (const name of ["referenceMs", "candidateMs", "speedup"] as const) {
    const measured = r[name];
    if (typeof measured !== "number" || !Number.isFinite(measured) || measured <= 0)
      throw new VerificationError(`Invalid kernel measurement: ${name}`, details);
    details[name] = measured;
  }
  if (strict || r.timingEvidence !== undefined) {
    const timing = parseKernelTimingEvidence(r.timingEvidence, contract);
    if (strict && (timing.reference.warmup !== strict.protocol.warmup || timing.reference.repeat !== strict.protocol.repeat))
      throw new VerificationError("Timing evidence warmup or repeat mismatch", details);
    if (Math.abs(timing.reference.meanMs - Number(r.referenceMs)) > 1e-12 || Math.abs(timing.candidate.meanMs - Number(r.candidateMs)) > 1e-12)
      throw new VerificationError("Timing evidence mean mismatch", details);
    details.timingEvidence = finiteJson(timing, "timing evidence");
  }
  const reference = details.referenceMs as number, candidate = details.candidateMs as number, speedup = details.speedup as number;
  if (Math.abs(reference / candidate - speedup) > 1e-8 * Math.max(1, speedup)) throw new Error("Inconsistent kernel speedup");
  return { passed: true, score: 1, details };
}

/** Timing-only measurements never imply correctness or a candidate score. */
export function kernelBenchVerdict(value: unknown, candidateSha256: string, referenceKind: string): VerifyResult {
  const r = expectRecord(value, "kernel bench result");
  if (r.operation !== "bench" || r.candidateSha256 !== candidateSha256 || r.referenceKind !== referenceKind ||
      r.timingScope !== "triton-kernels" || typeof r.error !== "string")
    throw new VerificationError("Invalid kernel bench identity", {});
  const details = { protocol: "kernel-bench/v1", operation: "bench", candidateSha256, referenceKind,
    timingScope: "triton-kernels", status: "unavailable", error: r.error };
  if (r.status !== "completed" || typeof r.candidateMs !== "number" || !Number.isFinite(r.candidateMs) || r.candidateMs <= 0 ||
      r.referenceMs !== null || r.speedup !== null)
    throw new VerificationError("Invalid kernel bench measurement", details);
  return { passed: null, details: { ...details, status: "completed", candidateMs: r.candidateMs, referenceMs: null, speedup: null } };
}

/** Validate independent capture receipts at the Benchmark boundary before publishing a diagnostic verdict. */
export function kernelProfileVerdict(value: unknown, candidateSha256: string, referenceKind: string, expected: {
  caseId: string; seed: number; warmup: number; inputUnmodified: boolean; collection: "Default" | "PipeTimeline,Default";
  problemSha256: string; contractSha256?: string; candidateFiles: { path: string; sha256: string }[];
}): VerifyResult {
  const profiling = parseKernelProfiling(expectRecord(value, "kernel result").profiling, expected.candidateFiles);
  const metadata = expectRecord(profiling.metadata, "profile metadata");
  const protocol = { caseId: expected.caseId, seeds: [expected.seed], warmup: expected.warmup, inputUnmodified: expected.inputUnmodified,
    collection: expected.collection, scope: "original-first-triton-kernel-or-file-stem",
    capture: "after-warmup-mstx-range", selectionPolicy: "last" };
  if (profiling.status === "completed") {
    const actual = expectRecord(metadata.diagnosticProtocol, "diagnosticProtocol");
    if (Object.entries(protocol).some(([name, value]) => JSON.stringify(actual[name]) !== JSON.stringify(value)) || metadata.collection !== expected.collection)
      throw new VerificationError("Diagnostic effective protocol mismatch", {});
    const trace = expectRecord(metadata.trace, "diagnostic trace");
    if (expected.collection === "Default" ? trace.status !== "unavailable" || trace.reason !== "not-requested-by-default-protocol" : trace.status !== "available")
      throw new VerificationError("Diagnostic trace availability mismatch", {});
    const sources = expectRecord(metadata.sources, "diagnostic sources");
    if (expectRecord(sources.candidate, "candidate source").sha256 !== candidateSha256 ||
        expectRecord(sources.problem, "problem source").sha256 !== expected.problemSha256)
      throw new VerificationError("Diagnostic native source mismatch", {});
    const replay = expectRecord(metadata.replay, "diagnostic replay");
    if (replay.seed !== expected.seed || replay.warmup !== expected.warmup || replay.inputUnmodified !== expected.inputUnmodified || replay.logicalDevice !== 0)
      throw new VerificationError("Diagnostic replay protocol mismatch", {});
  }
  return { passed: null, details: { protocol: "kernel-profile/v1", operation: "profile", candidateSha256, referenceKind,
    status: profiling.status === "completed" ? "completed" : "unavailable", cleanup: "confirmed",
    diagnosticProtocol: protocol, profiling,
    ...(expected.contractSha256 === undefined ? {} : { contractSha256: expected.contractSha256 }) } };
}
