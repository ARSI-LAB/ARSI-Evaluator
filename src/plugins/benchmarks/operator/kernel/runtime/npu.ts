import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import type { EnvironmentSession } from "../../../../../core/contracts/environment.js";
import { lockedCandidateFiles, type KernelRequest } from "./request.js";
import type { KernelBackend, KernelExecutionOptions } from "./backend.js";
import { expectNonEmptyString, expectRecord } from "../../../../../core/validation/input.js";
import { VerificationError } from "../../../../../core/errors/verification-error.js";
import { readProcess } from "../../../../../infrastructure/process/output.js";
import { KernelExecError } from "./execution.js";
import { kernelProcessEnvironment } from "./environment.js";
import { kernelProfile } from "./profile.js";

/** NPU-only execution. Benchmark owns task identity and verdict validation. */
export class NpuKernelBackend implements KernelBackend {
  constructor(private readonly config: KernelExecutionOptions) {}

  environment(): Record<string, string> {
    return { ASCEND_VISIBLE_DEVICES: String(this.config.device), ASCEND_RT_VISIBLE_DEVICES: String(this.config.device), KERNEL_NPU_DEVICE: "0" };
  }

  runtimeFiles(): { path: string; origin: string }[] {
    const asset = (name: string) => fileURLToPath(new URL(name, import.meta.url));
    return ["precision.py", "timing.py", "msprof_replay.py", "strict.py", "timing_evidence.py"]
      .map(name => ({ path: `runtime/${name}`, origin: asset(name) }));
  }

  async execute(request: KernelRequest, session: EnvironmentSession, signal: AbortSignal): Promise<unknown> {
    if (request.operation === "profile") {
      const profile: Record<string, unknown> = {};
      await this.collectProfiling(request, session, signal, profile);
      return profile;
    }
    const handle = await session.start({ executable: this.config.python,
      args: ["runtime/precision.py", "--output", join(session.verifierOutputDir, "kernel-result.json")], cwd: session.workdir,
      inheritEnv: false, env: kernelProcessEnvironment(join(session.workdir, "runtime"), { env: this.environment() }),
      input: Buffer.from(JSON.stringify(request)), outputBufferBytes: null }, signal);
    const process = await readProcess(handle, signal, this.config.outputLimitBytes ?? null, this.config.cleanupGraceMs);
    if (process.code !== 0) throw new VerificationError("Kernel worker did not return a result", { exitCode: process.code, stderr: process.stderr });
    let value: unknown;
    try { value = JSON.parse(process.stdout); }
    catch { throw new VerificationError("Kernel worker returned invalid JSON", { stderr: process.stderr }); }
    const record = expectRecord(value, "kernel result");
    const persisted: unknown = JSON.parse(await readFile(join(session.verifierOutputDir, "kernel-result.json"), "utf8"));
    if (!isDeepStrictEqual(value, persisted))
      throw new VerificationError("Native kernel evidence differs from the worker result", {});
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
