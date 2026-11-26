import { KERNEL_PROFILE_OUTPUT_POLICY } from "./msprof-csv.js";
import { parseKernelScopeTiming, parseKernelTimingEvidence } from "./timing.js";
import { expectNonEmptyString, expectRecord } from "../../../../core/validation/input.js";
import { VerificationError } from "../../../../core/errors/verification-error.js";
import type { JsonValue } from "../../../../core/contracts/task.js";
import type { VerifyResult } from "../../../../core/contracts/result.js";
import { parseKernelAssessment, type KernelContract, type KernelEffectiveProtocol } from "./strict.js";
import { parseKernelTolerance, resolveTolerance, type KernelToleranceConfig } from "./tolerance.js";
import { KERNEL_INFRASTRUCTURE_CODES, KERNEL_PROFILE_PROBE_REASONS } from "./runtime/execution.js";
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

const ERROR_STAT_KEYS = new Set(["count", "maxAbs", "maxRel", "p50Abs", "p90Abs", "p99Abs"]);

/** Validate the error distribution reported by the worker; unknown threshold keys stay allowed. */
export function parseKernelErrorStats(value: unknown): Record<string, number> {
  const r = expectRecord(value, "errorStats");
  const out: Record<string, number> = {};
  for (const [key, item] of Object.entries(r)) {
    if (typeof item !== "number" || !Number.isFinite(item) || item < 0) throw new TypeError(`Invalid errorStats.${key}`);
    if (key === "count" ? !Number.isSafeInteger(item) : !ERROR_STAT_KEYS.has(key) && !/^mismatch_gt_[0-9.eE+-]+$/u.test(key))
      throw new TypeError(`Invalid errorStats.${key}`);
    out[key] = item;
  }
  if (out.count === undefined) throw new TypeError("Missing errorStats.count");
  return out;
}

/** Validate retryable infrastructure evidence without letting it masquerade as candidate data. */
function infrastructureEvidence(r: Record<string, unknown>): { [key: string]: JsonValue } {
  if (r.code === undefined && r.retryable === undefined && r.diagnostics === undefined) return {};
  if (typeof r.code !== "string" || !(KERNEL_INFRASTRUCTURE_CODES as readonly string[]).includes(r.code))
    throw new TypeError("Invalid infrastructure error code");
  if (typeof r.retryable !== "boolean" || !Array.isArray(r.diagnostics) || !r.diagnostics.length)
    throw new TypeError("Invalid infrastructure error classification");
  return { code: r.code, retryable: r.retryable,
    diagnostics: r.diagnostics.map((value, index) => {
      const diagnostic = expectRecord(value, `diagnostics[${index}]`);
      if (Object.keys(diagnostic).some(key => key !== "message"))
        throw new TypeError("Invalid infrastructure diagnostic");
      return { message: expectNonEmptyString(diagnostic.message, "diagnostic.message") };
    }) };
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
  strict?: { contract: KernelContract; protocol: Pick<KernelEffectiveProtocol, "seeds" | "rtol" | "atol" | "warmup" | "repeat"> & { tolerance?: KernelToleranceConfig } },
  operation: "evaluate" | "precision" = "evaluate"): VerifyResult {
  const contract = strict?.contract;
  const r = expectRecord(value, "kernel result");
  if (r.operation !== operation || r.candidateSha256 !== candidateSha256 || r.referenceKind !== referenceKind ||
      r.timingScope !== "all-device-kernels" || typeof r.error !== "string") throw new Error("Invalid kernel result identity");
  if (r.errorOwnership !== undefined && r.errorOwnership !== "evaluation") throw new TypeError("Invalid kernel errorOwnership");
  const details: { [key: string]: JsonValue } = { protocol: "kernel-v1", operation, candidateSha256, referenceKind,
    timingScope: "all-device-kernels", status: typeof r.status === "string" ? r.status : "invalid", error: r.error,
    referenceMs: null, candidateMs: null, speedup: null,
    ...infrastructureEvidence(r),
    ...(r.errorOwnership === undefined ? {} : { errorOwnership: "evaluation" }),
    ...(profilingRequested ? { profilingRequested: true } : {}) };
  // Infrastructure failures short-circuit before assessment validation: a crashed worker
  // cannot be expected to have emitted correctness evidence.
  if (strict && r.status !== "infrastructure_error") {
    const assessment = parseKernelAssessment(r.assessment, strict.contract, strict.protocol.seeds);
    for (const name of ["warmup", "repeat"] as const)
      if (assessment.effectiveProtocol[name] !== strict.protocol[name])
        throw new VerificationError(`Effective protocol mismatch: ${name}`, {});
    if (strict.protocol.tolerance !== undefined) {
      const expected = resolveTolerance(strict.contract.output.dtype, strict.protocol.tolerance);
      for (const name of ["rtol", "atol"] as const)
        if (assessment.effectiveProtocol[name] !== expected[name])
          throw new VerificationError(`Effective tolerance mismatch: ${name}`, {});
      if (assessment.effectiveProtocol.tolerance !== undefined && assessment.effectiveProtocol.tolerance.mode !== expected.mode)
        throw new VerificationError("Effective tolerance mode mismatch", {});
    }
    details.assessment = finiteJson(assessment, "assessment");
    if (r.status === "passed" && (assessment.errorOwnership !== null || assessment.checks.some(c => c.status !== "passed")))
      throw new VerificationError("Strict checks did not pass", details);
    if (r.status === "passed" && Object.values(assessment.environment).some(value => value === null))
      throw new VerificationError("Strict measurement environment identity unavailable", details);
    if ((r.status === "incorrect" || r.status === "candidate_error") &&
      (assessment.errorOwnership !== "candidate" || !assessment.checks.some(c => c.status === "failed")))
      throw new VerificationError("Candidate failure lacks strict evidence", details);
  }
  if (r.tolerance !== undefined) {
    const tolerance = parseKernelTolerance(r.tolerance);
    if (strict && details.assessment !== undefined) {
      const assessed = (details.assessment as Record<string, any>).effectiveProtocol.tolerance;
      if (JSON.stringify(tolerance) !== JSON.stringify(assessed))
        throw new VerificationError("Tolerance provenance mismatch", details);
    }
    details.tolerance = finiteJson(tolerance, "tolerance");
  }
  if (r.errorStats !== undefined) details.errorStats = finiteJson(parseKernelErrorStats(r.errorStats), "errorStats");
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
    if (r.referenceMs !== null || r.candidateMs !== null || r.speedup !== null ||
        r.timing !== undefined || r.launchCount !== undefined) throw new Error("Failed kernel must not carry timing scores");
    return { passed: false, score: 0, details };
  }
  if (r.status !== "passed") throw new Error("Unknown kernel evaluation status");
  if (operation === "precision") {
    if (r.referenceMs !== null || r.candidateMs !== null || r.speedup !== null || r.timingEvidence !== undefined ||
        r.timing !== undefined || r.launchCount !== undefined)
      throw new VerificationError("Precision result must not carry timing measurements", details);
    return { passed: true, score: 1, details };
  }
  for (const name of ["referenceMs", "candidateMs", "speedup"] as const) {
    const measured = r[name];
    if (typeof measured !== "number" || !Number.isFinite(measured) || measured <= 0)
      throw new VerificationError(`Invalid kernel measurement: ${name}`, details);
    details[name] = measured;
  }
  if (r.timing !== undefined) {
    const timing = parseKernelScopeTiming(r.timing);
    if (Math.abs(timing.device.meanMs - Number(r.candidateMs)) > Math.max(1e-12, timing.device.meanMs * 1e-9))
      throw new VerificationError("Candidate scope timing disagrees with the measured candidate", details);
    if (r.launchCount !== undefined && r.launchCount !== timing.launchCount)
      throw new VerificationError("Candidate launchCount disagrees with timing evidence", details);
    details.timing = finiteJson(timing, "scope timing");
    details.launchCount = timing.launchCount;
  } else if (r.launchCount !== undefined) {
    throw new VerificationError("Candidate launchCount requires scope timing", details);
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
  const details: { [key: string]: JsonValue } = { protocol: "kernel-bench/v1", operation: "bench", candidateSha256, referenceKind,
    timingScope: "triton-kernels", status: "unavailable", error: r.error, ...infrastructureEvidence(r) };
  if (r.status === "infrastructure_error")
    throw new VerificationError("Kernel bench infrastructure failed", details);
  if (r.status !== "completed" || typeof r.candidateMs !== "number" || !Number.isFinite(r.candidateMs) || r.candidateMs <= 0 ||
      r.referenceMs !== null || r.speedup !== null)
    throw new VerificationError("Invalid kernel bench measurement", details);
  const completed: { [key: string]: JsonValue } = { ...details, status: "completed", candidateMs: r.candidateMs, referenceMs: null, speedup: null };
  if (r.timing !== undefined) {
    const timing = parseKernelScopeTiming(r.timing);
    if (Math.abs(timing.device.meanMs - r.candidateMs) > Math.max(1e-12, timing.device.meanMs * 1e-9))
      throw new VerificationError("Bench scope timing disagrees with the measured candidate", details);
    if (r.launchCount !== undefined && r.launchCount !== timing.launchCount)
      throw new VerificationError("Bench launchCount disagrees with timing evidence", details);
    completed.timing = finiteJson(timing, "scope timing");
    completed.launchCount = timing.launchCount;
  } else if (r.launchCount !== undefined) {
    throw new VerificationError("Bench launchCount requires scope timing", details);
  }
  return { passed: null, details: completed };
}

/** Publish profiler capability as diagnostic evidence, never as a candidate score. */
export function kernelProbeVerdict(value: unknown, candidateSha256: string, referenceKind: string,
  collection: "Default" | "PipeTimeline,Default"): VerifyResult {
  const r = expectRecord(value, "kernel probe result");
  if (r.operation !== "probe-profile" || r.candidateSha256 !== candidateSha256 || r.referenceKind !== referenceKind ||
      r.timingScope !== "all-device-kernels" || typeof r.error !== "string")
    throw new VerificationError("Invalid kernel profile probe identity", {});
  if (r.collection !== collection) throw new VerificationError("Kernel profile probe collection mismatch", {});
  if (r.status !== "available" && r.status !== "unavailable") throw new TypeError("Invalid kernel profile probe status");
  if (r.status === "available") {
    if (r.reason !== null || typeof r.msprofVersion !== "string" || !r.msprofVersion || r.error !== "")
      throw new TypeError("Invalid available kernel profile probe");
  } else if (!(KERNEL_PROFILE_PROBE_REASONS as readonly string[]).includes(String(r.reason)) || !r.error || r.msprofVersion !== null)
    throw new TypeError("Invalid unavailable kernel profile probe");
  if (r.durationSeconds !== undefined && (typeof r.durationSeconds !== "number" || !Number.isFinite(r.durationSeconds) || r.durationSeconds < 0))
    throw new TypeError("Invalid kernel profile probe duration");
  return { passed: null, details: { protocol: "kernel-probe/v1", operation: "probe-profile", candidateSha256,
    referenceKind, timingScope: "all-device-kernels", status: r.status, reason: r.reason as JsonValue, collection,
    msprofVersion: r.msprofVersion as JsonValue,
    msprofPath: r.msprofPath === undefined || r.msprofPath === null ? null : expectNonEmptyString(r.msprofPath, "probe msprofPath"),
    error: r.error,
    ...(r.durationSeconds === undefined ? {} : { durationSeconds: r.durationSeconds }) } };
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
