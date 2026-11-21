// SPDX-License-Identifier: Apache-2.0
import { expectRecord, expectNonEmptyString, rejectUnknown } from "../../../../core/validation/input.js";

export const KERNEL_TOLERANCE_MODES = ["explicit", "dtype", "observed", "frozen"] as const;
export type KernelToleranceMode = typeof KERNEL_TOLERANCE_MODES[number];
export type KernelToleranceConfig = { mode: KernelToleranceMode; rtol: number; atol: number; safetyFactor: number };
export type KernelTolerance = { mode: KernelToleranceMode; rtol: number; atol: number; source: string; observedMaxAbs?: number };

// Must match runtime/tolerance.py; fused fp16 kernels routinely need 1e-3.
export const KERNEL_DTYPE_TOLERANCES: Record<string, { rtol: number; atol: number }> = {
  float16: { rtol: 1e-3, atol: 1e-3 },
  bfloat16: { rtol: 1e-3, atol: 1e-3 },
  float32: { rtol: 5e-4, atol: 5e-4 },
  float64: { rtol: 1e-6, atol: 1e-6 },
  int64: { rtol: 0, atol: 0 },
  int32: { rtol: 0, atol: 0 },
};

/** Resolve the expected worker tolerance so verdicts cannot accept untracked looseness. */
export function resolveTolerance(dtype: string, config: KernelToleranceConfig): KernelTolerance {
  if (config.mode === "explicit" || config.mode === "frozen")
    return { mode: config.mode, rtol: config.rtol, atol: config.atol, source: config.mode };
  if (config.mode === "dtype") {
    const value = KERNEL_DTYPE_TOLERANCES[dtype] ?? KERNEL_DTYPE_TOLERANCES.float32!;
    return { mode: "dtype", rtol: value.rtol, atol: value.atol, source: `contract.output.dtype=${dtype}` };
  }
  throw new TypeError("observed tolerance requires measured error evidence from the policy preflight");
}

function nonnegative(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new TypeError(`${name} must be finite and nonnegative`);
  return value;
}

/** Validate worker-reported tolerance provenance. */
export function parseKernelTolerance(value: unknown): KernelTolerance {
  const t = expectRecord(value, "tolerance");
  rejectUnknown(t, ["mode", "rtol", "atol", "source", "observedMaxAbs"], "tolerance");
  if (!KERNEL_TOLERANCE_MODES.some(mode => mode === t.mode)) throw new TypeError("tolerance.mode must be explicit, dtype, observed or frozen");
  const tolerance: KernelTolerance = { mode: t.mode as KernelToleranceMode, rtol: nonnegative(t.rtol, "tolerance.rtol"),
    atol: nonnegative(t.atol, "tolerance.atol"), source: expectNonEmptyString(t.source, "tolerance.source") };
  if (t.observedMaxAbs !== undefined) tolerance.observedMaxAbs = nonnegative(t.observedMaxAbs, "tolerance.observedMaxAbs");
  return tolerance;
}
