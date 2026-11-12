// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { expectRecord, expectNonEmptyString, rejectUnknown } from "../../../../core/validation/input.js";

export const KERNEL_CHECK_IDS = ["entry", "shape", "dtype", "device", "layout", "independent-output", "input-unmodified", "numerical"] as const;
export type KernelCheckId = typeof KERNEL_CHECK_IDS[number];
export const KERNEL_TENSOR_DTYPES = ["float16", "bfloat16", "float32", "int64", "int32"] as const;
export type KernelTensorDtype = typeof KERNEL_TENSOR_DTYPES[number];
type TensorContract = { shape: number[]; dtype: KernelTensorDtype; contiguous: boolean };
export type KernelContract = { caseId: string; inputs: TensorContract[];
  output: TensorContract & { independent: boolean }; inputUnmodified: boolean };
export type KernelCheck = { id: KernelCheckId; seed: number; call: number;
  status: "passed" | "failed" | "not-run"; message: string };
export type KernelEffectiveProtocol = { seeds: number[]; rtol: number; atol: number; warmup: number; repeat: number;
  timingScope: "all-device-kernels"; aggregation: "iteration-mean"; timingSeed: number };
export const KERNEL_ENVIRONMENT_FIELDS = ["python", "torch", "torchNpu", "triton", "cann", "driver", "device", "visibleDevices"] as const;
export type KernelEnvironment = Record<typeof KERNEL_ENVIRONMENT_FIELDS[number], string | null>;
export type KernelAssessment = { contractSha256: string; checks: KernelCheck[];
  effectiveProtocol: KernelEffectiveProtocol; environment: KernelEnvironment; errorOwnership: "candidate" | "evaluation" | null };

const isKernelTensorDtype = (value: unknown): value is KernelTensorDtype =>
  typeof value === "string" && (KERNEL_TENSOR_DTYPES as readonly string[]).includes(value);

function tensor(value: unknown, output = false): TensorContract & { independent?: boolean } {
  const r = expectRecord(value, "contract tensor");
  rejectUnknown(r, output ? ["shape", "dtype", "contiguous", "independent"] : ["shape", "dtype", "contiguous"], "contract tensor");
  if (!Array.isArray(r.shape) || r.shape.some(n => !Number.isSafeInteger(n) || n <= 0)) throw new TypeError("contract tensor.shape must contain positive integers");
  if (!isKernelTensorDtype(r.dtype)) throw new TypeError(`contract tensor.dtype must be one of ${KERNEL_TENSOR_DTYPES.join(", ")}; got ${String(r.dtype)}`);
  if (typeof r.contiguous !== "boolean" || (output && typeof r.independent !== "boolean")) throw new TypeError("Invalid contract tensor layout");
  return { shape: r.shape as number[], dtype: r.dtype, contiguous: r.contiguous,
    ...(output ? { independent: r.independent as boolean } : {}) };
}
export function parseKernelContract(value: unknown): KernelContract {
  const r = expectRecord(value, "kernel contract");
  rejectUnknown(r, ["caseId", "inputs", "output", "inputUnmodified"], "kernel contract");
  if (!Array.isArray(r.inputs) || !r.inputs.length || typeof r.inputUnmodified !== "boolean") throw new TypeError("Invalid kernel contract");
  const output = tensor(r.output, true);
  return { caseId: expectNonEmptyString(r.caseId, "contract.caseId"), inputs: r.inputs.map(v => tensor(v)),
    output: { ...output, independent: output.independent === true }, inputUnmodified: r.inputUnmodified };
}
export function kernelContractDigest(contract: KernelContract): string {
  return createHash("sha256").update(JSON.stringify(parseKernelContract(contract))).digest("hex");
}
export function parseKernelAssessment(value: unknown, contract: KernelContract, seeds: number[]): KernelAssessment {
  const r = expectRecord(value, "kernel assessment");
  rejectUnknown(r, ["contractSha256", "checks", "effectiveProtocol", "environment", "errorOwnership"], "kernel assessment");
  if (r.contractSha256 !== kernelContractDigest(contract)) throw new TypeError("Invalid kernel assessment contract identity");
  if (!Array.isArray(r.checks) || r.checks.length !== seeds.length * 2 * KERNEL_CHECK_IDS.length) throw new TypeError("Incomplete kernel checks");
  const expectedSeeds = new Set(seeds);
  const seen = new Set<string>();
  const checks = r.checks.map(v => {
    const c = expectRecord(v, "kernel check");
    rejectUnknown(c, ["id", "seed", "call", "status", "message"], "kernel check");
    if (!KERNEL_CHECK_IDS.some(id => id === c.id) || !expectedSeeds.has(c.seed as number) || (c.call !== 0 && c.call !== 1) ||
      !["passed", "failed", "not-run"].includes(String(c.status)) || typeof c.message !== "string") throw new TypeError("Invalid kernel check");
    const key = `${c.seed}/${c.call}/${c.id}`;
    if (seen.has(key)) throw new TypeError("Duplicate kernel check");
    seen.add(key);
    return { id: c.id as KernelCheckId, seed: c.seed as number, call: c.call, status: c.status as KernelCheck["status"], message: c.message };
  });
  const p = expectRecord(r.effectiveProtocol, "effectiveProtocol");
  rejectUnknown(p, ["seeds", "rtol", "atol", "warmup", "repeat", "timingScope", "aggregation", "timingSeed"], "effectiveProtocol");
  if (JSON.stringify(p.seeds) !== JSON.stringify(seeds) || p.timingSeed !== seeds.at(-1) || p.timingScope !== "all-device-kernels" || p.aggregation !== "iteration-mean") throw new TypeError("Invalid effectiveProtocol identity");
  for (const name of ["rtol", "atol"] as const) if (typeof p[name] !== "number" || !Number.isFinite(p[name]) || p[name] < 0) throw new TypeError(`Invalid ${name}`);
  for (const name of ["warmup", "repeat"] as const) if (!Number.isSafeInteger(p[name]) || Number(p[name]) <= 0) throw new TypeError(`Invalid ${name}`);
  const e = expectRecord(r.environment, "kernel environment");
  rejectUnknown(e, [...KERNEL_ENVIRONMENT_FIELDS], "kernel environment");
  const environment = Object.fromEntries(KERNEL_ENVIRONMENT_FIELDS.map(name => {
    const v = e[name];
    if (v !== null && (typeof v !== "string" || !v.trim())) throw new TypeError(`Invalid environment.${name}`);
    return [name, v];
  })) as KernelEnvironment;
  if (r.errorOwnership !== null && r.errorOwnership !== "candidate" && r.errorOwnership !== "evaluation") throw new TypeError("Invalid errorOwnership");
  return { contractSha256: String(r.contractSha256), checks,
    effectiveProtocol: { seeds, rtol: Number(p.rtol), atol: Number(p.atol), warmup: Number(p.warmup), repeat: Number(p.repeat),
      timingScope: "all-device-kernels", aggregation: "iteration-mean", timingSeed: Number(p.timingSeed) }, environment, errorOwnership: r.errorOwnership };
}
