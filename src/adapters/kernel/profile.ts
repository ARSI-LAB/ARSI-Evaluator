import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { appendFile, cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { parseMsprofMetricsTable, rowsToMetrics, metricsToCsv, type MetricRow } from "../../plugins/benchmarks/protocols/kernel/msprof-csv.js";
import { analyzeL2Cache, analyzeTraceEvents, extractTritonKernelName, getCoreUtilization, resolveUbRatio } from "../../plugins/benchmarks/protocols/kernel/msprof-analysis.js";
import { analyzeRoofline } from "../../plugins/benchmarks/protocols/kernel/roofline.js";
import { MsProfCache } from "../../plugins/benchmarks/protocols/kernel/msprof-cache.js";
import { KernelExecError, resolveAtomDir, type KernelExecOptions } from "./cli.js";

const execFileAsync = promisify(execFile);

/**
 * msprof 采集原子编排（原 adapters/kernel/msprof.py + kernel_profiler/ 包的 TS 化）：
 * python 侧只剩 msprof_replay.py 一个「被 msprof attach 跑算子」的执行体；
 * request 组装、缓存、msprof 子进程 spawn/重试、OPPROF CSV 解析、ub_ratio、
 * 核利用率、L2 分析与产物契约全部在本 TS 层。产物 schema 与 py 版一致。
 */

const UPSTREAM_COMMIT = "f542552167fef844e10b865dc001e5c019f01ea5";
const OUTPUT_POLICY = "kernel-original-f542-v1";
const DEFAULT_MSPROF_BIN = "/usr/local/Ascend/ascend-toolkit/latest/bin/msprof";

export interface KernelProfileArgs { problem: string; kernel: string; out: string; round: number;
  msprofBin?: string; deviceName?: string }

export interface KernelProfileResult extends Record<string, unknown> {
  kernel: string; problem: string; round: number;
  metrics: Record<string, unknown> | null; profile_dir: string;
  trace_analysis: Record<string, unknown> | null;
  roofline: Record<string, unknown> | null; error: string;
}

/** 采集步骤错误：retryable 决定是否进入下一次 attempt（与原版异常分类一致）。 */
class ProfileStepError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message);
  }
}

const sha256File = (path: string): string =>
  createHash("sha256").update(readFileSync(path)).digest("hex");

/** 采集产物结构性缺失 → 重试无意义（与原版 FileNotFoundError 不重试的分类一致）。 */
const NON_RETRYABLE_PREFIXES = [
  "No hash found", "No PipeUtilization.csv", "No L2Cache.csv",
  "No ResourceConflictRatio.csv", "No trace.json", "msprof binary not found",
  "msprof did not create OPPROF_",
];

/** msprof 二进制定位：显式配置必须存在；否则优先本地 CANN 安装，再退 PATH。 */
function resolveMsprofBin(explicit?: string): string {
  if (explicit !== undefined && explicit !== "") {
    if (!existsSync(explicit)) throw new ProfileStepError(`msprof binary not found: ${explicit}`, false);
    return explicit;
  }
  if (existsSync(DEFAULT_MSPROF_BIN)) return DEFAULT_MSPROF_BIN;
  return "msprof";
}

async function listArtifacts(root: string, directory: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else out.push(resolve(path).replace(`${resolve(root)}/`, ""));
    }
  };
  await walk(directory);
  return out.sort();
}

/** msprof 采集原子：缓存命中直接回放既有指标；未命中 spawn msprof（带 attempt 重试）。 */
export async function kernelProfile(args: KernelProfileArgs, options: KernelExecOptions = {}): Promise<KernelProfileResult> {
  const sub = "profile";
  const atomDir = resolveAtomDir(sub, options);
  const outPath = resolve(args.out);
  const dir = dirname(outPath);
  const stem = (args.out.split(/[/\\]/).pop() ?? "profile").replace(/\.json$/, "");
  const requestPath = join(dir, `${stem}.request.json`);
  const rawPath = join(dir, `${stem}.raw.json`);

  // 采集工作区：{stem}_profiling_root/profiling/{artifacts,logs}（原 _collect_main 命名续用）。
  let root = join(dir, `${stem}_profiling_root`);
  for (let suffix = 0; existsSync(root);) {
    suffix += 1;
    root = join(dir, `${stem}_profiling_root_${suffix}`);
  }
  const profilingDir = join(root, "profiling");
  const artifactsDir = join(profilingDir, "artifacts");
  const logsDir = join(profilingDir, "logs");
  await mkdir(artifactsDir, { recursive: true });
  await mkdir(logsDir, { recursive: true });
  const log = (line: string): void => {
    try { void appendFile(join(logsDir, "profiler.log"), `${new Date().toISOString()} INFO ${line}\n`, "utf8"); }
    catch { /* 日志失败不影响采集 */ }
  };

  const kernelBytes = await readFile(args.kernel);
  // 候选暂存为 .py 后缀副本（dataRoot 内）：workspace 物化的 content 无后缀，
  // replay 侧 spec_from_file_location 无法识别；暂存路径同时满足协议锁子路径
  // 检查。原始路径与 hash 仍进 metadata 供溯源。
  const stagedKernelPath = resolve(join(artifactsDir, "candidate_staged.py"));
  await writeFile(stagedKernelPath, kernelBytes);
  const request: Record<string, unknown> = {
    problem: args.problem,
    candidate: args.kernel,
    dataRoot: dirname(resolve(args.problem)),
    hashes: { [args.problem]: sha256File(args.problem), [args.kernel]: sha256File(args.kernel) },
    seeds: [0], warmup: 25, repeat: 100, rtol: 0.001, atol: 0.001, outputIndices: null,
    candidateSha256: sha256File(args.kernel), referenceKind: "problem-model",
    profiling: { enabled: true, roundNum: args.round, cacheEnabled: true },
  };
  await writeFile(requestPath, JSON.stringify(request, null, 2), "utf8");

  const result: Record<string, unknown> = {
    schemaVersion: 1, status: "failed", error: "", kernels: [],
    metadata: {
      outputPolicy: OUTPUT_POLICY, upstreamCommit: UPSTREAM_COMMIT,
      scope: "original-first-triton-kernel-or-file-stem",
      collection: "PipeTimeline,Default", seed: 0, roundNum: args.round,
      cacheRequested: true, cacheHit: false,
      retryPolicy: { maxAttempts: 2, attemptTimeoutSeconds: 300 },
    },
    artifacts: [],
  };
  const metadata = result.metadata as Record<string, unknown>;
  const started = Date.now();
  try {
    // 重放请求与原 _prepare_wrapper 同构：绝对路径 + 按绝对路径索引的 hash。
    const replayRequest = {
      problem: resolve(args.problem), candidate: stagedKernelPath,
      dataRoot: dirname(resolve(args.problem)),
      hashes: { [resolve(args.problem)]: (request.hashes as Record<string, string>)[args.problem],
        [stagedKernelPath]: (request.hashes as Record<string, string>)[args.kernel] },
      seeds: [0], warmup: 25,
    };
    const replayRequestPath = join(profilingDir, "request.json");
    await writeFile(replayRequestPath, JSON.stringify(replayRequest, null, 2), "utf8");
    metadata["sources"] = {
      candidate: { path: resolve(args.kernel), sha256: (request.hashes as Record<string, string>)[args.kernel] },
      problem: { path: replayRequest.problem, sha256: (request.hashes as Record<string, string>)[args.problem] },
    };

    // 采集缓存按可见卡集合 + 目标卡号区分（不同卡的耗时证据不可互换复用）。
    const cacheScope = process.env["ASCEND_RT_VISIBLE_DEVICES"] === undefined
      ? (options.device === undefined ? undefined : `device-${options.device}`)
      : `${process.env["ASCEND_RT_VISIBLE_DEVICES"]}${options.device === undefined ? "" : `:device-${options.device}`}`;
    const cache = await MsProfCache.open(cacheScope, undefined, log);
    metadata["cacheEnabled"] = cache !== null;
    let metrics: Record<string, Record<string, unknown>> | null = null;
    let profileDir = "";
    let metricsRecords: Record<string, unknown>[] | null = null;
    const kernelName = extractTritonKernelName(args.kernel, kernelBytes.toString("utf8"));

    const cached = cache === null ? null
      : await cache.get(kernelBytes, cacheScope, log);
    metadata["cacheHit"] = cached !== null;
    if (cached !== null) {
      // 命中：把缓存区备份的 profile 目录拷回本仓库产物树，保证 profileDir 相对可迁移。
      metrics = cached.metrics as Record<string, Record<string, unknown>>;
      metricsRecords = cached.metricsRecords;
      if (cached.profileDir !== "" && existsSync(cached.profileDir)) {
        const copied = join(profilingDir, "cache-hit-profile");
        await cp(cached.profileDir, copied, { recursive: true });
        profileDir = copied;
      }
      log(`cache hit; metrics rebuilt from MSProfCache`);
    } else {
      const python = process.env["KERNEL_PROFILER_PYTHON"] ?? options.python ?? "python";
      const msprofBin = resolveMsprofBin(args.msprofBin);
      const outDirName = `msprof_round_${args.round}`;
      const outputDir = join(artifactsDir, outDirName);
      // replay 子进程结构化结果通道（kernel 协议行退役后的 result.json 契约）：
      // 采集链路失败时优先透传这里的真实业务错误，避免只剩表层 CSV 缺失提示。
      const replayResultPath = join(artifactsDir, "replay-result.json");
      const maxAttempts = 2;
      const attemptTimeout = 300_000;
      let lastError: Error | null = null;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        log(`msprof profiling attempt ${attempt}/${maxAttempts}...`);
        // triton cache 隔离：每次 attempt 全新缓存目录，杜绝上次编译残留干扰 autotune 判定。
        const tritonCacheDir = join(artifactsDir, ".triton_cache", outDirName);
        await rm(tritonCacheDir, { recursive: true, force: true });
        await mkdir(tritonCacheDir, { recursive: true });
        const env: NodeJS.ProcessEnv = {
          ...process.env, ...options.env,
          ...(options.device === undefined ? {} : { KERNEL_NPU_DEVICE: String(options.device) }),
          PYTHONPATH: process.env.PYTHONPATH === undefined || process.env.PYTHONPATH === ""
            ? atomDir : `${atomDir}${delimiter}${process.env.PYTHONPATH}`,
          TRITON_CACHE_DIR: tritonCacheDir,
          ENABLE_PRINT_UB_BITS: "true",
          TRITON_PRINT_AUTOTUNING: "1",
          // msprof 只透传 PRESERVE_ENV 列出的变量给被采集进程；设备绑定必须显式保留。
          PRESERVE_ENV: ["PATH", "LD_LIBRARY_PATH", "PYTHONPATH", "TRITON_CACHE_DIR", "TORCH_EXTENSIONS_DIR",
            "CONDA_PREFIX", "CONDA_DEFAULT_ENV", "ASCEND_VISIBLE_DEVICES", "ASCEND_AICPU_PATH",
            "ASCEND_RT_VISIBLE_DEVICES", "KERNEL_NPU_DEVICE"].join(","),
        };
        try {
          const application = `${python} ${join(atomDir, "msprof_replay.py")} --request ${replayRequestPath} --output ${replayResultPath}`;
          const { stdout, stderr } = await execFileAsync(msprofBin,
            ["op", `--output=${outputDir}`, `--application=${application}`,
              `--kernel-name=${kernelName}`, "--aic-metrics=PipeTimeline,Default"], {
            cwd: artifactsDir, env, maxBuffer: 64 * 1024 * 1024, windowsHide: true,
            timeout: attemptTimeout,
            ...(options.signal === undefined ? {} : { signal: options.signal }),
          });
          const consoleText = `${stdout}${stderr}`;
          await appendFileSafe(join(logsDir, "console.log"), consoleText);
          const profDirs = (await exists(outputDir))
            ? (await readdir(outputDir)).filter(name => name.startsWith("OPPROF_")).sort()
            : [];
          if (profDirs.length === 0)
            throw new ProfileStepError(`msprof did not create OPPROF_* directory in ${outputDir}`, false);
          const profDir = join(outputDir, profDirs[profDirs.length - 1]!);
          const ubRatio = await resolveUbRatio(consoleText, tritonCacheDir, kernelName, args.deviceName);
          // 指标表组装顺序与原版一致：CSV 表 → ub_ratio 列 → core_utilization → L2 分析。
          const rows: MetricRow[] = await parseMsprofMetricsTable(profDir);
          for (const row of rows) row["ub_ratio"] = ubRatio;
          const table = rowsToMetrics(rows);
          const coreUtilization = await getCoreUtilization(profDir);
          for (const entry of Object.values(table)) entry["core_utilization"] = coreUtilization;
          const l2 = await analyzeL2Cache(profDir);
          for (const entry of Object.values(table)) entry["l2_cache_analysis"] = l2;
          metrics = table;
          profileDir = profDir;
          log(`msprof profiling completed (round ${args.round})`);
          break;
        } catch (error) {
          if (error instanceof KernelExecError) throw error;
          const message = error instanceof Error ? error.message : String(error);
          // replay 子进程若写出了结构化结果且带业务错误，真实原因优先于
          // msprof 表层提示（CSV 缺失/目录缺失只是下游症状）。
          try {
            const replayResult = JSON.parse(await readFile(replayResultPath, "utf8")) as Record<string, unknown>;
            if (typeof replayResult["error"] === "string" && replayResult["error"] !== "")
              throw new ProfileStepError(`replay kernel failed: ${replayResult["error"]}`, false);
          } catch (readError) {
            if (readError instanceof ProfileStepError) throw readError;
            // 结果文件不存在/损坏：沿用 msprof 原始错误继续分类
          }
          const timedOut = (error as { killed?: boolean }).killed === true;
          // 与原版异常分类一致：采集产物结构性缺失（目录/CSV/trace/编译元数据）不重试；
          // 超时、退出码非零、ub_ratio 数值类错误可重试（msprof 偶发抖动）。
          const retryable = timedOut || !NON_RETRYABLE_PREFIXES.some(prefix => message.includes(prefix));
          lastError = error instanceof Error ? error : new Error(message);
          log(`attempt ${attempt} failed: ${message}`);
          if (!retryable || attempt >= maxAttempts) break;
          await new Promise(wait => setTimeout(wait, 2 ** attempt * 1000)); // 指数退避 2/4s
        }
      }
      if (metrics === null)
        throw lastError ?? new Error("msprof profiling failed without diagnostics");
    }

    if (metrics !== null) {
      const timestamp = new Date().toISOString().replace(/\.\d+Z$/, "Z");
      const originalMetadata = {
        kernel_file: resolve(args.kernel), problem_file: resolve(args.problem),
        round_num: args.round, timestamp, msprof_version: null,
      };
      // round{N}_msprof_metrics.json 与 metrics-dataframe.csv / original-result.json
      // 与 py 版产物一一对应，保持归档与对账口径不变。
      await writeFile(join(logsDir, `round${String(args.round).padStart(3, "0")}_msprof_metrics.json`),
        JSON.stringify({ metrics, metadata: originalMetadata, profile_dir: profileDir }, null, 2), "utf8");
      await writeFile(join(profilingDir, "metrics-dataframe.csv"),
        metricsToCsv(metricsRecords === null
          ? Object.entries(metrics).map(([blockId, entry]) => ({ block_id: blockId, ...entry }) as MetricRow)
          : metricsRecords as MetricRow[]), "utf8");
      await writeFile(join(profilingDir, "original-result.json"),
        JSON.stringify({ metrics, metadata: originalMetadata, profile_dir: profileDir }, null, 2), "utf8");
      metadata["originalMetadata"] = originalMetadata;
      if (profileDir !== "") metadata["profileDir"] = relativeTo(root, profileDir);
      const replayJsonPath = join(profilingDir, "replay.json");
      if (existsSync(replayJsonPath))
        metadata["replay"] = JSON.parse(await readFile(replayJsonPath, "utf8")) as unknown;
      const artifacts = await listArtifacts(root, profilingDir);
      result["kernels"] = [{
        name: kernelName, metrics,
        metadata: { ...metadata }, artifacts,
      }];
      result["status"] = "completed";
      result["error"] = "";
      if (cache !== null)
        await cache.put(kernelBytes, cacheScope, profileDir,
          metrics,
          { ...(metadata as Record<string, unknown>), round_num: args.round,
            device: process.env["ASCEND_RT_VISIBLE_DEVICES"], problem_file: resolve(args.problem) },
          metricsRecords);
    }
  } catch (error) {
    if (error instanceof KernelExecError) throw error;
    result["error"] = `${error instanceof Error ? error.name : "Error"}: ${
      error instanceof Error ? error.message : String(error)}`.slice(0, 4000);
    log(`profiling failed: ${result["error"]}`);
  }
  metadata["durationSeconds"] = (Date.now() - started) / 1000;
  result["artifacts"] = [...await listArtifacts(root, profilingDir), "profiling/result.json"];
  await writeFile(join(profilingDir, "result.json"), JSON.stringify(result, null, 2), "utf8");
  await writeFile(rawPath, JSON.stringify(result, null, 2), "utf8");

  const payload: Record<string, unknown> = {
    kernel: args.kernel, problem: args.problem, round: args.round,
    measured_by: "rsi-profile", metrics: null, profile_dir: "", error: "",
  };
  if (result["status"] === "completed") {
    const entry = (result.kernels as Record<string, unknown>[])[0] ?? {};
    payload["metrics"] = entry["metrics"] ?? {};
    const rel = String((entry.metadata as Record<string, unknown>)?.["profileDir"] ?? "");
    payload["profile_dir"] = rel !== "" ? resolve(join(root, rel)) : "";
  } else {
    payload["error"] = String(result["error"]) || "msprof profiling returned no kernels";
  }
  if (payload["profile_dir"] !== "") {
    // 流水线 trace 分析（原版 orchestrator 语义）：profile_dir/trace.json →
    // trace_analysis.json 落盘 + 随载荷回传；trace 缺失或分析失败按无数据跳过。
    try {
      const profDir = String(payload["profile_dir"]);
      const traceData = JSON.parse(await readFile(join(profDir, "trace.json"), "utf8")) as { traceEvents?: unknown };
      const analysis = analyzeTraceEvents(traceData.traceEvents);
      if (analysis !== null) {
        payload["trace_analysis"] = analysis;
        await writeFile(join(profDir, "trace_analysis.json"), JSON.stringify(analysis, null, 2), "utf8");
      }
    } catch { /* 无 trace 数据：payload 不带 trace_analysis 字段 */ }
    // roofline 分类并入本原子：唯一输入就是 metrics 表，采集+分析一体出结果；
    // 分类失败不阻断采集结论，payload 带默认判定（"no"）。
    const metricsTable = payload["metrics"];
    if (metricsTable !== null && typeof metricsTable === "object" && Object.keys(metricsTable as object).length > 0)
      payload["roofline"] = analyzeRoofline(metricsTable as Record<string, Record<string, unknown>>) as unknown;
  }
  await writeFile(outPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return { kernel: args.kernel, problem: args.problem, round: args.round,
    metrics: payload["metrics"] as Record<string, unknown> | null,
    profile_dir: String(payload["profile_dir"]),
    trace_analysis: (payload["trace_analysis"] ?? null) as Record<string, unknown> | null,
    roofline: (payload["roofline"] ?? null) as Record<string, unknown> | null,
    error: String(payload["error"]) };
}

/** 相对路径化（原 _relative 语义；越界时返回绝对路径，由调用方兜底）。 */
function relativeTo(root: string, path: string): string {
  const normalized = resolve(path).replace(/\\/g, "/");
  const base = resolve(root).replace(/\\/g, "/");
  return normalized.startsWith(`${base}/`) ? normalized.slice(base.length + 1) : normalized;
}

async function exists(path: string): Promise<boolean> {
  try {
    await readdir(path);
    return true;
  } catch {
    return false;
  }
}

async function appendFileSafe(path: string, text: string): Promise<void> {
  try {
    await appendFile(path, text, "utf8");
  } catch {
    // console.log 落盘失败不影响采集。
  }
}
