import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { EnvironmentSession, ProcessHandle } from "../../../../../core/contracts/environment.js";
import { lockedCandidateFiles, type KernelRequest } from "./request.js";
import type { KernelBackend, KernelExecutionOptions } from "./backend.js";
import { expectNonEmptyString, expectRecord } from "../../../../../core/validation/input.js";
import { VerificationError } from "../../../../../core/errors/verification-error.js";
import { readProcess } from "../../../../../infrastructure/process/output.js";
import { KernelExecError, type KernelDiagnostic, type KernelInfrastructureCode } from "./execution.js";
import { kernelProcessEnvironment } from "./environment.js";
import { kernelProfile, probeKernelProfile } from "./profile.js";

const DIAGNOSTIC_TAIL = 4096;

function tail(text: string): string {
  return text.length <= DIAGNOSTIC_TAIL ? text : text.slice(-DIAGNOSTIC_TAIL);
}

function diagnosticsOf(process: { stdout: string; stderr: string }): KernelDiagnostic[] {
  const diagnostics = [
    ...(process.stdout ? [{ message: `stdout: ${tail(process.stdout)}` }] : []),
    ...(process.stderr ? [{ message: `stderr: ${tail(process.stderr)}` }] : []),
  ];
  return diagnostics.length ? diagnostics : [{ message: "worker produced no diagnostics" }];
}

function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** NPU-only execution. Benchmark owns task identity and verdict validation. */
export class NpuKernelBackend implements KernelBackend {
  constructor(private readonly config: KernelExecutionOptions) {}

  environment(): Record<string, string> {
    return { ASCEND_VISIBLE_DEVICES: String(this.config.device), ASCEND_RT_VISIBLE_DEVICES: String(this.config.device), KERNEL_NPU_DEVICE: "0" };
  }

  runtimeFiles(): { path: string; origin: string }[] {
    const asset = (name: string) => fileURLToPath(new URL(name, import.meta.url));
    return ["precision.py", "timing.py", "msprof_replay.py", "strict.py", "timing_evidence.py", "tolerance.py"]
      .map(name => ({ path: `runtime/${name}`, origin: asset(name) }));
  }

  private infrastructure(request: KernelRequest, code: KernelInfrastructureCode, error: string,
    diagnostics: KernelDiagnostic[], retryable = true): Record<string, unknown> {
    return { operation: request.operation ?? "evaluate",
      candidateSha256: request.candidateSha256 ?? "", referenceKind: request.referenceKind ?? "",
      timingScope: request.operation === "bench" ? "triton-kernels" : "all-device-kernels",
      status: "infrastructure_error", error, code, retryable, errorOwnership: "evaluation",
      referenceMs: null, candidateMs: null, speedup: null, diagnostics };
  }

  async execute(request: KernelRequest, session: EnvironmentSession, signal: AbortSignal): Promise<unknown> {
    if (request.operation === "probe-profile") {
      const probe = await probeKernelProfile({
        ...(this.config.profiling.collection === undefined ? {} : { collection: this.config.profiling.collection }),
        ...(this.config.profiling.msprofBin === undefined ? {} : { msprofBin: this.config.profiling.msprofBin }),
        attemptTimeoutSeconds: this.config.profiling.attemptTimeoutSeconds ?? 30,
      }, { python: this.config.python, signal,
        ...(this.config.outputLimitBytes === undefined ? {} : { outputLimitBytes: this.config.outputLimitBytes }),
        ...(this.config.cleanupGraceMs === undefined ? {} : { cleanupGraceMs: this.config.cleanupGraceMs }),
        ...(this.config.cleanupTimeoutMs === undefined ? {} : { cleanupTimeoutMs: this.config.cleanupTimeoutMs }),
        env: this.environment() },
      { session, atomDirectory: join(session.workdir, "runtime") });
      return { operation: "probe-profile", candidateSha256: request.candidateSha256 ?? "",
        referenceKind: request.referenceKind ?? "", timingScope: "all-device-kernels", ...probe };
    }
    if (request.operation === "profile") {
      const profile: Record<string, unknown> = {};
      await this.collectProfiling(request, session, signal, profile);
      return profile;
    }
    const resultPath = join(session.verifierOutputDir, "kernel-result.json");
    let handle: ProcessHandle;
    try {
      handle = await session.start({ executable: this.config.python,
        args: ["runtime/precision.py", "--output", resultPath], cwd: session.workdir,
        inheritEnv: false, env: kernelProcessEnvironment(join(session.workdir, "runtime"), { env: this.environment() }),
        input: Buffer.from(JSON.stringify(request)), outputBufferBytes: null }, signal);
    } catch (error) {
      if (signal.aborted) throw error;
      return this.infrastructure(request, "WORKER_START", "Kernel worker could not start", [{ message: failureMessage(error) }], false);
    }
    let process: { stdout: string; stderr: string; code: number | null; signal: string | null };
    try {
      process = await readProcess(handle, signal, this.config.outputLimitBytes ?? null, this.config.cleanupGraceMs);
    } catch (error) {
      // External cancellation aborts the run; only the per-phase timeout is a retryable infrastructure result.
      if (signal.aborted && signal.reason?.name !== "TimeoutError") throw error;
      if (signal.aborted)
        return this.infrastructure(request, "WORKER_TIMEOUT", "Kernel worker timed out", [{ message: failureMessage(error) }]);
      return this.infrastructure(request, "WORKER_PROTOCOL_INVALID", "Kernel worker output could not be captured",
        [{ message: failureMessage(error) }]);
    }
    if (process.code !== 0 || process.signal !== null)
      return this.infrastructure(request, "WORKER_EXIT",
        `Kernel worker exited with code ${process.code}${process.signal === null ? "" : ` (signal ${process.signal})`}`,
        diagnosticsOf(process));
    // The atomically replaced result file is the authoritative evidence; stdout is diagnostic only.
    let value: unknown;
    try {
      value = JSON.parse(await readFile(resultPath, "utf8"));
    } catch (error) {
      return this.infrastructure(request, "WORKER_PROTOCOL_INVALID", "Kernel worker did not persist a valid result file",
        [...diagnosticsOf(process), { message: failureMessage(error) }]);
    }
    let record: Record<string, unknown>;
    try { record = expectRecord(value, "kernel result"); }
    catch (error) {
      return this.infrastructure(request, "WORKER_PROTOCOL_INVALID", "Kernel worker result is not an object",
        [...diagnosticsOf(process), { message: failureMessage(error) }]);
    }
    const operation = request.operation ?? "evaluate";
    const timingScope = operation === "bench" ? "triton-kernels" : "all-device-kernels";
    if (record.operation !== operation || record.candidateSha256 !== request.candidateSha256 ||
        record.referenceKind !== request.referenceKind || record.timingScope !== timingScope ||
        typeof record.status !== "string" || typeof record.error !== "string")
      return this.infrastructure(request, "WORKER_PROTOCOL_INVALID",
        "Kernel worker result does not match the requested task identity", diagnosticsOf(process));
    if (this.config.profiling.enabled && record.status === "passed")
      await this.collectProfiling(request, session, signal, record);
    return value;
  }

  /** Collect detailed metrics through kernelProfile when enabled; record failures without affecting acceptance timing or scoring. */
  private async collectProfiling(request: KernelRequest, session: EnvironmentSession,
    signal: AbortSignal, value: Record<string, unknown>): Promise<void> {
    const fail = (error: string): void => {
      value.profiling = { status: "failed", error, kernels: [], metadata: {}, artifacts: [] };
    };
    try {
      const stem = "kernel-profile";
      const inputUnmodified = request.contract === undefined ? true : expectRecord(request.contract, "kernel contract").inputUnmodified;
      if (typeof inputUnmodified !== "boolean") throw new TypeError("contract.inputUnmodified must be a boolean");
      const { enabled: _enabled, roundNum, ...capture } = this.config.profiling;
      await kernelProfile({
        ...capture,
        problem: join(session.workdir, String(request.problem)),
        kernel: join(session.workdir, String(request.candidate)),
        candidateRoot: join(session.workdir, request.candidateRoot), candidateFiles: lockedCandidateFiles(request),
        out: join(session.verifierOutputDir, `${stem}.json`),
        round: roundNum,
        caseId: String(request.caseId),
        seed: (request.seeds as number[])[0]!, inputUnmodified,
        ...(request.contractSha256 === undefined ? {} : { contractSha256: String(request.contractSha256) }),
      }, { python: this.config.python, signal,
        ...(this.config.outputLimitBytes === undefined ? {} : { outputLimitBytes: this.config.outputLimitBytes }),
        ...(this.config.cleanupGraceMs === undefined ? {} : { cleanupGraceMs: this.config.cleanupGraceMs }),
        ...(this.config.cleanupTimeoutMs === undefined ? {} : { cleanupTimeoutMs: this.config.cleanupTimeoutMs }),
        env: this.environment() },
        { session, atomDirectory: join(session.workdir, "runtime"),
          sourceContext: { dataRoot: join(session.workdir, expectNonEmptyString(request.dataRoot, "kernel dataRoot")),
            hashes: Object.fromEntries(Object.entries(request.hashes).map(([path, hash]) => [join(session.workdir, path), hash])) } });
      const raw = expectRecord(JSON.parse(await readFile(join(session.verifierOutputDir, `${stem}.raw.json`), "utf8")), "kernel profile");
      const metadata = expectRecord(raw.metadata, "kernel profile metadata");
      value.profiling = prefixProfilingPaths(raw, expectNonEmptyString(metadata.artifactRoot, "profile artifact root"));
    } catch (error) {
      if (error instanceof KernelExecError) throw new VerificationError(error.message, { cleanup: "unconfirmed", protocol: "kernel-v1" });
      signal.throwIfAborted();
      fail(`profiling orchestration failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

/** Prefix profiling artifact paths relative to the verifier directory for report evidence links. */
export function prefixProfilingPaths<T>(raw: T, prefix: string): T {
  const prefixed = (v: unknown): unknown => typeof v === "string" && v !== "" && !v.startsWith("/") ? `${prefix}/${v}` : v;
  const out = structuredClone(raw) as Record<string, unknown>;
  if (Array.isArray(out.artifacts)) out.artifacts = out.artifacts.map(prefixed);
  const metadata = out.metadata;
  if (metadata !== null && typeof metadata === "object" && typeof (metadata as Record<string, unknown>).profileDir === "string")
    (metadata as Record<string, unknown>).profileDir = prefixed((metadata as Record<string, unknown>).profileDir);
  if (Array.isArray(out.kernels)) for (const kernel of out.kernels as Record<string, unknown>[]) {
    if (Array.isArray(kernel.artifacts)) kernel.artifacts = kernel.artifacts.map(prefixed);
    const km = kernel.metadata;
    if (km !== null && typeof km === "object" && typeof (km as Record<string, unknown>).profileDir === "string")
      (km as Record<string, unknown>).profileDir = prefixed((km as Record<string, unknown>).profileDir);
  }
  return out as T;
}
