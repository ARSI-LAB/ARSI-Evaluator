import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { delimiter, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);

/**
 * kernel 测量执行桥：Evaluator CLI 的 `kernel` 子命令族。
 *
 * python 执行体只保留三个 NPU 关注点入口（`src/adapters/kernel/`）：
 * - precision.py：精度门（多 seed 双跑 + kernel 官方容差，对照 problem.Model 参照）；
 * - timing.py：纯计时（bench_kernel_ms，--triton-only，warmup25/repeat100 同口径）；
 * - msprof_replay.py：msprof 采集目标（被 msprof 进程 attach 跑算子的唯一 py）。
 * msprof 采集编排/解析/缓存/roofline 分类在 ./profile.ts。每个入口进程 stdout
 * 只承载一份 JSON（末行）；业务失败 payload.error
 * 非空正常返回，解释器缺失/超时/取消/无 JSON 按 infra 故障抛 KernelExecError。
 * measure/verify 编排（产物三件套、verify.json、workdir 扫描）在 RSI 侧：
 * 它们是 RSI run 语义；本仓只提供三个纯测量原子。
 */

/** 执行目录定位失败/解释器缺失等执行环境故障。 */
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
  /** NPU 卡号（逻辑卡）：透传为子进程 KERNEL_NPU_DEVICE，缺省由执行体按环境决定。 */
  device?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * 执行目录定位（纯逻辑，moduleDir 可注入）：KERNEL_ATOM_DIR 显式覆盖 →
 * 从 moduleDir 逐级向上找 `<root>/src/adapters/kernel/precision.py`。
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
    const candidate = join(dir, "src", "adapters", "kernel", "precision.py");
    if (existsSync(candidate)) return dirname(candidate);
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new KernelExecError(sub, null,
    `kernel ${sub} cannot locate the kernel python entries: set KERNEL_ATOM_DIR to the adapters/kernel directory`, true);
}

/** 子进程失败的关键字段（ExecFileException 的窄化视图）。 */
interface ExecFailure {
  code?: unknown;
  killed?: unknown;
  stdout?: unknown;
  stderr?: unknown;
}

/** 失败归类：解释器缺失/超时/取消是环境故障；其余带退出码交调用方。 */
export function kernelFailure(sub: string, error: unknown): KernelExecError {
  const cause = error instanceof Object ? error as ExecFailure : {};
  if (cause.code === "ENOENT")
    return new KernelExecError(sub, null, `python interpreter not found for kernel ${sub}`, true);
  if (cause.killed === true)
    return new KernelExecError(sub, null, `kernel ${sub} was killed (timeout or cancellation)`, true);
  if (error instanceof Error && error.name === "AbortError")
    return new KernelExecError(sub, null, `kernel ${sub} was cancelled`, true);
  const code = cause.code;
  return new KernelExecError(sub, typeof code === "number" ? code : null,
    `kernel ${sub} failed: ${error instanceof Error ? error.message : String(error)}`, true);
}

async function readJson(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/** 解析入口进程 stdout 的单 JSON（取最后一个非空行，容忍设备运行时噪声输出）。 */
export function parseAtomPayload(sub: string, stdout: string): Record<string, unknown> {
  const lines = stdout.trim().split("\n").filter((line) => line.trim() !== "");
  const last = lines[lines.length - 1] ?? "";
  try {
    return JSON.parse(last) as Record<string, unknown>;
  } catch (error) {
    throw new KernelExecError(sub, null, `kernel ${sub} printed no JSON: ${String(error)}`, true,
      stdout.slice(0, 400));
  }
}

/** 单入口执行：成功返回 payload；业务失败（exit 非 0 但产物已落盘）也返回 payload。 */
async function runEntry(sub: string, entry: string, argv: readonly string[], out: string,
  options: KernelExecOptions = {}): Promise<Record<string, unknown>> {
  const atomDir = resolveAtomDir(sub, options);
  const env = {
    ...process.env,
    ...options.env,
    ...(options.device === undefined ? {} : { KERNEL_NPU_DEVICE: String(options.device) }),
    PYTHONPATH: process.env.PYTHONPATH === undefined || process.env.PYTHONPATH === ""
      ? atomDir
      : `${atomDir}${delimiter}${process.env.PYTHONPATH}`,
  };
  let payload: Record<string, unknown> | undefined;
  try {
    const { stdout } = await execFileAsync(options.python ?? "python",
      [join(atomDir, entry), ...argv], {
        cwd: atomDir, env, maxBuffer: 64 * 1024 * 1024, windowsHide: true,
        timeout: options.timeoutMs ?? 900_000,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
    payload = parseAtomPayload(sub, stdout);
  } catch (error) {
    const cause = error instanceof Object ? error as ExecFailure : {};
    if (cause.killed === true || (error instanceof Error && error.name === "AbortError"))
      throw kernelFailure(sub, error);
    // 业务失败退出时 --out 产物已落盘（error 字段在）；读取兜底。
    payload = await readJson(out);
    if (payload === undefined) throw kernelFailure(sub, error);
  }
  return payload ?? (await readJson(out)) ?? {};
}

const str = (value: unknown): string => (typeof value === "string" ? value : "");
const num = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

// ---------------- 三个测量原子（两个 python + 一个 TS 编排） ----------------

export interface KernelBenchArgs { problem: string; kernel: string; out: string }

export interface KernelBenchResult extends Record<string, unknown> {
  problem: string; kernel: string; out: string;
  time_ms: number | null; error: string;
}

/** 纯计时原子（--triton-only 口径；不带精度——精度由 precision 原子承担）。 */
export async function kernelBench(args: KernelBenchArgs, options: KernelExecOptions = {}): Promise<KernelBenchResult> {
  const payload = await runEntry("bench", "timing.py",
    ["--problem", args.problem, "--kernel", args.kernel, "--out", args.out],
    args.out, options);
  return { problem: args.problem, kernel: args.kernel, out: args.out,
    time_ms: num(payload["time_ms"]), error: str(payload["error"]) };
}

export interface KernelPrecisionResult extends Record<string, unknown> {
  problem: string; kernel: string; passed: boolean; error: string;
  tolerance: Record<string, unknown>;
}

/** 精度门原子：多 seed 双跑 + kernel 官方容差（对照 problem.Model 参照）。 */
export async function kernelPrecision(args: KernelBenchArgs & { seeds?: number[] },
  options: KernelExecOptions = {}): Promise<KernelPrecisionResult> {
  const seeds = args.seeds ?? [0, 1];
  const payload = await runEntry("precision", "precision.py",
    ["precision", "--problem", args.problem, "--kernel", args.kernel, "--out", args.out,
      "--seeds", ...seeds.map(String)],
    args.out, options);
  return { problem: args.problem, kernel: args.kernel,
    passed: payload["passed"] === true, error: str(payload["error"]),
    tolerance: payload["tolerance"] !== null && typeof payload["tolerance"] === "object"
      ? payload["tolerance"] as Record<string, unknown> : {} };
}

export { kernelProfile } from "./profile.js";

