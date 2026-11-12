import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const MAX_KERNEL_TIMER_MS = 2147483647;

/** Execution environment failures, including missing worker directories or interpreters. */
export class KernelExecError extends Error {
  override readonly name = "KernelExecError";

  constructor(readonly sub: string, readonly exitCode: number | null, message: string,
    readonly infra: boolean, readonly payload?: unknown) {
    super(message);
  }
}

export interface KernelExecOptions {
  python?: string;
  env?: Readonly<Record<string, string>>;
  /** Logical NPU index passed as KERNEL_NPU_DEVICE; the worker uses its environment when omitted. */
  device?: number;
  timeoutMs?: number;
  /** Per stdout/stderr stream; omitted preserves complete output. */
  outputLimitBytes?: number;
  cleanupGraceMs?: number;
  cleanupTimeoutMs?: number;
  signal?: AbortSignal;
}

export function validateKernelExecOptions(options: KernelExecOptions): void {
  for (const name of ["outputLimitBytes", "cleanupGraceMs", "cleanupTimeoutMs"] as const) {
    const value = options[name];
    if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) throw new TypeError(`${name} must be a positive integer`);
  }
  if (options.timeoutMs !== undefined && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 0))
    throw new TypeError("timeoutMs must be a non-negative integer");
  for (const name of ["timeoutMs", "cleanupGraceMs", "cleanupTimeoutMs"] as const)
    if (options[name] !== undefined && options[name] > MAX_KERNEL_TIMER_MS)
      throw new TypeError(`${name} exceeds the Node timer range (${MAX_KERNEL_TIMER_MS} ms)`);
}

/**
 * Locate the worker directory: use KERNEL_ATOM_DIR when explicitly configured;
 * otherwise search ancestors of the injectable moduleDir for src/plugins/benchmarks/operator/kernel/runtime/precision.py.
 */
export function resolveAtomDir(sub: string, options: KernelExecOptions = {},
  moduleDir: string = dirname(fileURLToPath(import.meta.url))): string {
  const explicit = process.env.KERNEL_ATOM_DIR;
  if (explicit !== undefined && explicit !== "" && existsSync(join(explicit, "precision.py")))
    return explicit;
  // Published packages carry Python workers beside this compiled module.
  if (existsSync(join(moduleDir, "precision.py"))) return moduleDir;
  let dir = moduleDir;
  for (;;) {
    const candidate = join(dir, "src", "plugins", "benchmarks", "operator", "kernel", "runtime", "precision.py");
    if (existsSync(candidate)) return dirname(candidate);
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new KernelExecError(sub, null,
    `Kernel ${sub} cannot locate the Python workers: set KERNEL_ATOM_DIR to the kernel runtime directory`, true);
}
