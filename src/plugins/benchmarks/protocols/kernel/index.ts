import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { dirname, join, relative, isAbsolute, posix, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { Benchmark } from "../../../../core/contracts/benchmark.js";
import type { SourceLock, TaskRef, PreparedTask } from "../../../../core/contracts/task.js";
import type { EnvironmentSession, EnvironmentSpec } from "../../../../core/contracts/environment.js";
import type { SolveResult } from "../../../../core/contracts/result.js";
import { expectRecord, expectNonEmptyString, expectPositiveInteger, rejectUnknown, type EffectiveConfig } from "../../../../config/schema.js";
import { VerificationError } from "../../../../core/errors/verification-error.js";
import { readProcess } from "../../../../adapters/verifiers/process.js";
import { kernelVerdict } from "./result.js";
import { kernelProfile } from "../../../../adapters/kernel/profile.js";

export function relativeFile(value: unknown, label: string): string {
  const path = expectNonEmptyString(value, label);
  if (isAbsolute(path) || path.includes("\\") || path.includes("\0") || path.split("/").some(p => p === ".." || p === "." || !p) || posix.normalize(path) !== path)
    throw new TypeError(`${label} must be a relative file without traversal`);
  return path;
}

export function parseKernelConfig(value: unknown) {
  const c = expectRecord(value, "kernel");
  rejectUnknown(c, ["manifest", "kernelRoot", "python", "device", "seeds", "rtol", "atol", "warmup", "repeat", "timeoutSeconds", "profiling"], "kernel");
  const p = expectRecord(c.profiling ?? {}, "profiling");
  rejectUnknown(p, ["enabled", "attemptTimeoutSeconds", "maxAttempts", "roundNum", "msprofBin", "deviceName", "cacheEnabled", "cacheDir"], "profiling");
  if (p.enabled !== undefined && typeof p.enabled !== "boolean") throw new TypeError("profiling.enabled must be boolean");
  if (p.cacheEnabled !== undefined && typeof p.cacheEnabled !== "boolean") throw new TypeError("profiling.cacheEnabled must be boolean");
  if (p.roundNum !== undefined && !Number.isSafeInteger(p.roundNum)) throw new TypeError("profiling.roundNum must be an integer");
  const profiling = {
    enabled: p.enabled === true,
    attemptTimeoutSeconds: expectPositiveInteger(p.attemptTimeoutSeconds ?? 300, "profiling.attemptTimeoutSeconds"),
    maxAttempts: expectPositiveInteger(p.maxAttempts ?? 2, "profiling.maxAttempts"),
    roundNum: p.roundNum === undefined ? 1 : p.roundNum as number,
    cacheEnabled: p.cacheEnabled !== false,
    ...(p.msprofBin === undefined ? {} : { msprofBin: expectNonEmptyString(p.msprofBin, "profiling.msprofBin") }),
    ...(p.deviceName === undefined ? {} : { deviceName: expectNonEmptyString(p.deviceName, "profiling.deviceName") }),
    ...(p.cacheDir === undefined ? {} : { cacheDir: expectNonEmptyString(p.cacheDir, "profiling.cacheDir") }),
  };
  const timeoutSeconds = expectPositiveInteger(c.timeoutSeconds ??
    (profiling.enabled ? profiling.maxAttempts * profiling.attemptTimeoutSeconds + 300 : 300), "timeoutSeconds");
  const nonnegative = (value: unknown, name: string) => {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new TypeError(`${name} must be finite and nonnegative`);
    return value;
  };
  const device = nonnegative(c.device ?? 0, "device");
  if (!Number.isSafeInteger(device)) throw new TypeError("device must be an integer");
  const seeds = c.seeds ?? [0, 1, 2];
  if (!Array.isArray(seeds) || !seeds.length || seeds.length > 100 || seeds.some(s => !Number.isSafeInteger(s) || s < 0 || s > 0xffffffff))
    throw new TypeError("seeds must contain 1-100 unsigned 32-bit integers");
  if (new Set(seeds).size !== seeds.length) throw new TypeError("seeds must be unique");
  return { manifest: expectNonEmptyString(c.manifest, "manifest"), ...(c.kernelRoot === undefined ? {} : { kernelRoot: expectNonEmptyString(c.kernelRoot, "kernelRoot") }),
    python: expectNonEmptyString(c.python ?? "python3", "python"), device, seeds: seeds as number[],
    rtol: nonnegative(c.rtol ?? 0.001, "rtol"), atol: nonnegative(c.atol ?? 0.001, "atol"),
    warmup: expectPositiveInteger(c.warmup ?? 5, "warmup"), repeat: expectPositiveInteger(c.repeat ?? 20, "repeat"),
    timeoutSeconds, profiling };
}
export type KernelConfig = ReturnType<typeof parseKernelConfig>;

export function parseKernelManifest(value: unknown) {
  const m = expectRecord(value, "kernel manifest");
  rejectUnknown(m, ["schemaVersion", "tasks"], "kernel manifest");
  if (m.schemaVersion !== 1 || !Array.isArray(m.tasks) || !m.tasks.length) throw new TypeError("Expected schemaVersion 1 and nonempty tasks");
  const ids = new Set<string>();
  return m.tasks.map((value, index) => {
    const t = expectRecord(value, `tasks[${index}]`);
    rejectUnknown(t, ["id", "problem", "candidate", "files", "referenceKind", "outputIndices"], "kernel task");
    const id = expectNonEmptyString(t.id, "task.id");
    if (ids.has(id)) throw new TypeError(`Duplicate kernel task: ${id}`);
    ids.add(id);
    if (t.referenceKind !== "pytorch" && t.referenceKind !== "original-kernel") throw new TypeError("referenceKind must be pytorch or original-kernel");
    const files = t.files ?? [];
    if (!Array.isArray(files)) throw new TypeError("files must be an array");
    const indices = t.outputIndices;
    if (indices !== undefined && (!Array.isArray(indices) || !indices.length || indices.some(i => !Number.isSafeInteger(i) || i < 0) || new Set(indices).size !== indices.length))
      throw new TypeError("outputIndices must be unique nonnegative integers");
    return { id, problem: relativeFile(t.problem, "problem"), candidate: relativeFile(t.candidate, "candidate"),
      files: files.map(f => relativeFile(f, "files")), referenceKind: t.referenceKind,
      ...(indices === undefined ? {} : { outputIndices: indices as number[] }) };
  });
}
export type KernelTask = ReturnType<typeof parseKernelManifest>[number];

const digest = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
const workerPath = fileURLToPath(new URL("../../../../adapters/kernel/precision.py", import.meta.url));
const benchPath = "src/kernel_agent/kernel_agent/triton_kernel_agent/opt_worker_component/benchmarking/bench_kernel_util.py";
// msprof 链的编排/解析/缓存已 TS 化；打包的 py 只剩被 msprof attach 跑算子的重放脚本。
const profilingFiles = ["msprof_replay.py"];

export class KernelBenchmark implements Benchmark {
  readonly evaluationKind = "quality";
  readonly validateSourceOnCompletedResume = true;
  constructor(private readonly config: KernelConfig) {}

  validateRun(config: EffectiveConfig): void {
    if (config.environment.name !== "local" || config.scheduler.name !== "local" || (config.scheduler.config.concurrency ?? 1) !== 1)
      throw new TypeError("kernel requires local environment and local scheduler concurrency 1");
    if (config.solver.name !== "kernel-replay") throw new TypeError("kernel requires the locked kernel-replay solver");
    if (config.verifier !== undefined) throw new TypeError("kernel uses its built-in verifier; remove benchmark.verifier");
    if (this.config.profiling.enabled && config.run.timeoutSeconds <= this.config.timeoutSeconds)
      throw new TypeError("run.timeoutSeconds must exceed kernel timeoutSeconds when profiling is enabled");
  }

  private async dataFile(path: string): Promise<string> {
    const root = await realpath(dirname(this.config.manifest));
    const file = await realpath(join(root, path));
    const rel = relative(root, file);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("Kernel data file escapes manifest directory");
    return file;
  }

  async resolveSource(previous: SourceLock | null, signal: AbortSignal): Promise<SourceLock> {
    signal.throwIfAborted();
    const manifest = await readFile(this.config.manifest);
    const tasks = parseKernelManifest(JSON.parse(manifest.toString("utf8")));
    const paths = [...new Set(tasks.flatMap(t => [t.problem, t.candidate, ...t.files]))].sort();
    const files = [{ path: "manifest.json", sha256: digest(manifest), origin: this.config.manifest }];
    for (const path of paths) {
      signal.throwIfAborted();
      const origin = await this.dataFile(path);
      files.push({ path: `data/${path}`, sha256: digest(await readFile(origin)), origin });
    }
    for (const [path, origin] of [["runtime/precision.py", workerPath], ["runtime/timing.py", this.config.kernelRoot === undefined ? fileURLToPath(new URL("../../../../adapters/kernel/timing.py", import.meta.url)) : join(this.config.kernelRoot, benchPath)]] as const) {
      files.push({ path, origin, sha256: digest(await readFile(origin)) });
    }
    for (const name of profilingFiles) {
      const origin = join(dirname(workerPath), name);
      files.push({ path: `runtime/${name}`, origin, sha256: digest(await readFile(origin)) });
    }
    const revision = digest(JSON.stringify(files.map(({ path, sha256 }) => ({ path, sha256 }))));
    if (previous && (previous.source !== "kernel-v1" || previous.revision !== revision)) throw new Error("Kernel evaluation source changed since locking");
    signal.throwIfAborted();
    return { source: "kernel-v1", revision, files, metadata: { schemaVersion: 1, tasks } };
  }

  async *enumerate(source: SourceLock, signal: AbortSignal): AsyncIterable<TaskRef> {
    for (const task of parseKernelManifest(source.metadata)) {
      signal.throwIfAborted();
      yield { id: task.id, recordKey: task.id };
    }
  }

  async prepare(ref: TaskRef, source: SourceLock, signal: AbortSignal): Promise<PreparedTask> {
    await this.resolveSource(source, signal);
    const task = parseKernelManifest(source.metadata).find(t => t.id === ref.id && t.id === ref.recordKey);
    if (!task) throw new Error("Unknown kernel task reference");
    const file = (path: string) => {
      const item = source.files.find(f => f.path === path);
      if (!item) throw new Error(`Missing locked file: ${path}`);
      return item;
    };
    const candidate = file(`data/${task.candidate}`);
    const selected = [...new Set([task.problem, ...task.files])].map(path => file(`data/${path}`))
      .filter(item => item.path !== candidate.path);
    selected.push(file("runtime/precision.py"), file("runtime/timing.py"));
    selected.push(...profilingFiles.map(name => file(`runtime/${name}`)));
    const env = (initialFiles: EnvironmentSpec["initialFiles"]): EnvironmentSpec => ({ workdir: ".", image: null, runtime: [], initialFiles,
      env: { ASCEND_RT_VISIBLE_DEVICES: String(this.config.device), KERNEL_NPU_DEVICE: String(this.config.device) } });
    return {
      input: { id: task.id, prompt: "Submit the frozen kernel artifact for independent evaluation.", payload: { candidateSha256: candidate.sha256 } },
      verification: { schemaVersion: 1, candidate: candidate.path, dataRoot: "data", candidateSha256: candidate.sha256,
        files: selected.map(f => ({ source: f.origin, target: f.path })),
        problem: `data/${task.problem}`, referenceKind: task.referenceKind, outputIndices: task.outputIndices ?? null,
        seeds: this.config.seeds, rtol: this.config.rtol, atol: this.config.atol, warmup: this.config.warmup, repeat: this.config.repeat,
        profiling: this.config.profiling,
        hashes: Object.fromEntries([...selected.map(f => [f.path, f.sha256]), [candidate.path, candidate.sha256]]) },
      solveEnv: env([{ source: candidate.origin, target: candidate.path }]),
      verifyEnv: null, transfer: null, verificationMode: "shared",
      artifactCollection: { kind: "artifacts", workdir: ".", paths: [candidate.path] },
      phaseTimeoutSeconds: { verify: this.config.timeoutSeconds },
    };
  }

  async verify(task: PreparedTask, result: SolveResult, session: EnvironmentSession | null, signal: AbortSignal) {
    if (!session) throw new Error("Kernel verification requires a private environment session");
    const { files, ...request } = expectRecord(task.verification, "kernel verification descriptor");
    if (result.finalText !== request.candidateSha256) throw new Error("Solver submitted a different kernel identity");
    const active = AbortSignal.any([signal, AbortSignal.timeout(this.config.timeoutSeconds * 1000)]);
    if (!Array.isArray(files)) throw new Error("Missing verifier files");
    // local 不支持归档恢复；Solver 结束并进入验证阶段后才注入私有材料。
    for (const item of files) {
      const file = expectRecord(item, "verifier file");
      if (typeof file.source !== "string" || typeof file.target !== "string") throw new Error("Invalid verifier file");
      await session.upload(file.source, file.target, active);
    }
    const handle = await session.start({ executable: this.config.python,
      args: ["runtime/precision.py", "--output", join(session.verifierOutputDir, "kernel-result.json")], cwd: session.workdir,
      env: {}, input: Buffer.from(JSON.stringify(request)) }, active);
    const process = await readProcess(handle, active);
    if (process.code !== 0) throw new VerificationError("Kernel worker did not return a result", { exitCode: process.code, stderr: process.stderr.slice(-4000) });
    let value: unknown;
    try { value = JSON.parse(process.stdout); }
    catch { throw new VerificationError("Kernel worker returned invalid JSON", { stderr: process.stderr.slice(-4000) }); }
    const record = expectRecord(value, "kernel result");
    if (this.config.profiling.enabled && record.status === "passed")
      await this.collectProfiling(request, session, active, record);
    return kernelVerdict(value, String(request.candidateSha256), String(request.referenceKind), this.config.profiling.enabled);
  }

  /** profiling.enabled 时接线 TS 编排（kernelProfile）采集详细硬件指标；失败降级为明确 failed 记录，不影响验收计时与评分。 */
  private async collectProfiling(request: Record<string, unknown>, session: EnvironmentSession,
    signal: AbortSignal, value: Record<string, unknown>): Promise<void> {
    const fail = (error: string): void => {
      value.profiling = { schemaVersion: 1, status: "failed", error: error.slice(0, 4000), kernels: [], metadata: {}, artifacts: [] };
    };
    try {
      const stem = "kernel-profile";
      const result = await kernelProfile({
        problem: join(session.workdir, String(request.problem)),
        kernel: join(session.workdir, String(request.candidate)),
        out: join(session.verifierOutputDir, `${stem}.json`), round: this.config.profiling.roundNum,
        ...(this.config.profiling.msprofBin === undefined ? {} : { msprofBin: this.config.profiling.msprofBin }),
        ...(this.config.profiling.deviceName === undefined ? {} : { deviceName: this.config.profiling.deviceName }),
      }, { python: this.config.python, signal,
        env: { ASCEND_RT_VISIBLE_DEVICES: String(this.config.device), KERNEL_NPU_DEVICE: String(this.config.device) } });
      if (result.error !== "") return fail(`msprof profiling failed: ${result.error}`);
      const raw = JSON.parse(await readFile(join(session.verifierOutputDir, `${stem}.raw.json`), "utf8"));
      value.profiling = prefixProfilingPaths(raw, `${stem}_profiling_root`);
    } catch (error) {
      fail(`profiling orchestration failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

/** 把 profile 原子产物中的相对路径统一前缀化为 verifier-relative（供报告证据链接可见）。 */
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
