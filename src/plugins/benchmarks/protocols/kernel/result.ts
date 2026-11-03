import { expectNonEmptyString, expectRecord } from "../../../../config/schema.js";
import { VerificationError } from "../../../../core/errors/verification-error.js";
import type { JsonValue } from "../../../../core/contracts/task.js";
import type { VerifyResult } from "../../../../core/contracts/result.js";
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

function metadataPaths(metadata: Record<string, unknown>): void {
  for (const name of ["rawMetricsJson", "originalResultJson", "metricsDataframeCsv", "profileDir"])
    if (metadata[name] !== undefined) artifactPaths([metadata[name]]);
}

/** 只校验框架边界；成功、缺失字段和指标值由原 profiler 决定。 */
export function parseKernelProfiling(value: unknown): { [key: string]: JsonValue } {
  const p = expectRecord(value, "kernel profiling");
  if (p.schemaVersion !== 1 || (p.status !== "completed" && p.status !== "failed") || typeof p.error !== "string")
    throw new TypeError("Invalid kernel profiling identity");
  if (!Array.isArray(p.kernels) || !Array.isArray(p.artifacts)) throw new TypeError("Missing kernel profiling evidence");
  metadataPaths(expectRecord(p.metadata, "profiling.metadata"));
  artifactPaths(p.artifacts);
  for (const value of p.kernels) {
    const kernel = expectRecord(value, "profiled kernel");
    expectNonEmptyString(kernel.name, "profiled kernel.name");
    expectRecord(kernel.metrics, "profiled kernel.metrics");
    if (kernel.artifacts !== undefined) artifactPaths(kernel.artifacts);
    const metadata = kernel.metadata === undefined ? {} : expectRecord(kernel.metadata, "profiled kernel.metadata");
    metadataPaths(metadata);
  }
  const result = finiteJson(p, "profiling");
  if (result === null || typeof result !== "object" || Array.isArray(result)) throw new TypeError("Invalid profiling object");
  return result;
}

/** 计时只接受完整的有限正数，基础设施错误不会转成候选零分。 */
export function kernelVerdict(value: unknown, candidateSha256: string, referenceKind: string, profilingRequested = false): VerifyResult {
  const r = expectRecord(value, "kernel result");
  if (r.schemaVersion !== 1 || r.candidateSha256 !== candidateSha256 || r.referenceKind !== referenceKind ||
      r.timingScope !== "all-device-kernels" || typeof r.error !== "string") throw new Error("Invalid kernel result identity");
  const details: { [key: string]: JsonValue } = { protocol: "kernel-v1", candidateSha256, referenceKind,
    timingScope: "all-device-kernels", status: typeof r.status === "string" ? r.status : "invalid", error: r.error,
    referenceMs: null, candidateMs: null, speedup: null,
    ...(profilingRequested ? { profilingRequested: true } : {}) };
  if (r.profiling !== undefined) {
    try { details.profiling = parseKernelProfiling(r.profiling); }
    catch {
      // 不转存未校验对象或异常消息，避免不安全证据路径进入报告。
      details.profiling = { schemaVersion: 1, status: "failed", error: "Profiling result could not be adapted",
        kernels: [], metadata: { adapterError: true }, artifacts: [] };
    }
  } else if (profilingRequested && r.status === "passed") {
    details.profiling = { schemaVersion: 1, status: "failed", error: "Requested profiling did not return a result",
      kernels: [], metadata: { missingResult: true }, artifacts: [] };
  }
  if (r.status === "infrastructure_error") throw new VerificationError("Kernel evaluation infrastructure failed", details);
  if (r.status === "incorrect" || r.status === "candidate_error") {
    if (r.referenceMs !== null || r.candidateMs !== null || r.speedup !== null) throw new Error("Failed kernel must not carry timing scores");
    return { passed: false, score: 0, details };
  }
  if (r.status !== "passed") throw new Error("Unknown kernel evaluation status");
  for (const name of ["referenceMs", "candidateMs", "speedup"] as const) {
    const measured = r[name];
    if (typeof measured !== "number" || !Number.isFinite(measured) || measured <= 0)
      throw new VerificationError(`Invalid kernel measurement: ${name}`, details);
    details[name] = measured;
  }
  const reference = details.referenceMs as number, candidate = details.candidateMs as number, speedup = details.speedup as number;
  if (Math.abs(reference / candidate - speedup) > 1e-8 * Math.max(1, speedup)) throw new Error("Inconsistent kernel speedup");
  return { passed: true, score: 1, details };
}
