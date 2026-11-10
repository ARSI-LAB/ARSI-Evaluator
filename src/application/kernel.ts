import type { KernelExecOptions } from "../plugins/benchmarks/operator/kernel/runtime/cli.js";
export { parseKernelSeeds } from "../plugins/benchmarks/operator/kernel/runtime/seeds.js";

export type KernelCommand = (
  | { kind: "kernel-bench"; warmup?: number; repeat?: number }
  | { kind: "kernel-precision"; seeds: number[] }
  | { kind: "kernel-profile"; round: number; seed: number; warmup: number;
      maxAttempts?: number; attemptTimeoutSeconds?: number; cacheMaxEntries?: number; retryDelayMs?: number }
) & { problem: string; kernel: string; out: string; device: number }
  & Pick<KernelExecOptions, "python" | "timeoutMs" | "outputLimitBytes" | "cleanupGraceMs" | "cleanupTimeoutMs">;

export async function executeKernelCommand(command: KernelCommand, signal: AbortSignal) {
  const [{ kernelBench, kernelPrecision, KernelExecError }, { kernelProfile }] = await Promise.all([
    import("../plugins/benchmarks/operator/kernel/runtime/cli.js"),
    import("../plugins/benchmarks/operator/kernel/runtime/profile.js"),
  ]);
  const options: KernelExecOptions = { signal,
    ...(command.python === undefined ? {} : { python: command.python }),
    ...(command.timeoutMs === undefined ? {} : { timeoutMs: command.timeoutMs }),
    ...(command.outputLimitBytes === undefined ? {} : { outputLimitBytes: command.outputLimitBytes }),
    ...(command.cleanupGraceMs === undefined ? {} : { cleanupGraceMs: command.cleanupGraceMs }),
    ...(command.cleanupTimeoutMs === undefined ? {} : { cleanupTimeoutMs: command.cleanupTimeoutMs }),
    ...(command.device === 0 ? {} : { device: command.device }) };
  try {
    const payload = command.kind === "kernel-profile" ? await kernelProfile(command, options)
      : command.kind === "kernel-precision" ? await kernelPrecision(command, options) : await kernelBench(command, options);
    return { kind: "completed" as const, payload };
  } catch (error) {
    if (error instanceof KernelExecError && !error.infra) return { kind: "evaluation-failed" as const, message: error.message };
    throw error;
  }
}
