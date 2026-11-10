import { existsSync, readFileSync } from "node:fs";
import { appendFile, lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createHash } from "node:crypto";
import { KERNEL_PROFILE_OUTPUT_POLICY, parseMsprofMetricsTable, rowsToMetrics, metricsToCsv, type MetricRow } from "../msprof-csv.js";
import { analyzeL2Cache, analyzeTraceEvents, findTritonKernelName } from "../msprof-analysis.js";
import { analyzeRoofline } from "../roofline.js";
import { MsProfCache } from "../msprof-cache.js";
import { KernelExecError, MAX_KERNEL_TIMER_MS, validateKernelExecOptions, resolveAtomDir, type KernelExecOptions } from "./cli.js";

import type { CommandSpec, EnvironmentSession } from "../../../../../core/contracts/environment.js";
import { startLocalProcess } from "../../../../../infrastructure/process/local.js";
import { readProcess } from "../../../../../infrastructure/process/output.js";
import { kernelProcessEnvironment } from "./environment.js";

/** The SDK session owns all profiler children; standalone CLI calls own a process group. */
export type KernelProfileExecution = {
  session: Pick<EnvironmentSession, "start" | "workdir">;
  atomDirectory: string;
  /** SDK-only source context, including reference dependencies and locked runtime files. */
  sourceContext?: { dataRoot: string; hashes: Record<string, string> };
};
async function runProfileProcess(command: CommandSpec, signal: AbortSignal, options: KernelExecOptions, consolePath: string, execution?: KernelProfileExecution): Promise<void> {
  const handle = execution ? await execution.session.start({ ...command, cwd: execution.session.workdir }, signal)
    : await startLocalProcess(command, signal);
  try {
    const result = await readProcess(handle, signal, options.outputLimitBytes ?? null, options.cleanupGraceMs);
    await appendFileSafe(consolePath, `${result.stdout}${result.stderr}`);
    if (result.code !== 0) throw new ProfileStepError(`msprof exited with ${result.code}: ${result.stderr.slice(-4000)}`, true);
  } finally {
    let closed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await handle.stop(options.cleanupGraceMs ?? 100);
      closed = await Promise.race([handle.done.then(() => true, () => false),
        new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), options.cleanupTimeoutMs ?? 3000); })]);
    } catch { /* The caller must retain the unconfirmed cleanup outcome. */ }
    finally { if (timer) clearTimeout(timer); }
    if (!closed) throw new KernelExecError("profile", null, "Profiling process cleanup unconfirmed", true, { cleanup: "unconfirmed" });
  }
}

/**
 * msprof capture orchestration, ported from adapters/kernel/msprof.py and kernel_profiler.
 * msprof_replay.py is the only Python worker executed under msprof.
 * This TypeScript layer owns request assembly, caching, msprof process retries, OPPROF CSV parsing,
 * ub_ratio, core utilization, L2 analysis and artifact contracts, preserving the Python artifact schema.
 */

const UPSTREAM_COMMIT = "f542552167fef844e10b865dc001e5c019f01ea5";
const DEFAULT_MSPROF_BIN = "/usr/local/Ascend/ascend-toolkit/latest/bin/msprof";

export interface KernelProfileArgs { problem: string; kernel: string; out: string; round: number;
  candidateRoot: string; candidateFiles: { path: string; sha256: string }[];
  inputUnmodified?: boolean;
  seed?: number; warmup?: number; caseId?: string; contractSha256?: string; collection?: "Default" | "PipeTimeline,Default";
  msprofBin?: string; deviceName?: string; maxAttempts?: number; attemptTimeoutSeconds?: number; retryDelayMs?: number; cacheEnabled?: boolean; cacheDir?: string; cacheMaxEntries?: number }

async function stageCandidateTree(args: KernelProfileArgs, artifactsDir: string): Promise<{
  root: string; sourceRoot: string; entry: string; files: { path: string; sha256: string }[]; hashes: Record<string, string>; bytes: Buffer;
}> {
  if (typeof args.candidateRoot !== "string" || !isAbsolute(args.candidateRoot) || !Array.isArray(args.candidateFiles) || !args.candidateFiles.length)
    throw new TypeError("candidateRoot requires an absolute directory and a nonempty candidateFiles inventory");
  const root = resolve(args.candidateRoot);
  const entry = relative(root, resolve(args.kernel)).split(sep).join("/");
  const files: { path: string; sha256: string }[] = [];
  const seen = new Set<string>();
  for (const file of args.candidateFiles) {
    if (file === null || typeof file !== "object" || typeof file.path !== "string" || isAbsolute(file.path) ||
        file.path.includes("\\") || /[\u0000-\u001f]/u.test(file.path) || file.path.split("/").some(part => !part || part === "." || part === "..") ||
        posix.normalize(file.path) !== file.path || seen.has(file.path) || !/^[0-9a-f]{64}$/.test(file.sha256))
      throw new TypeError("candidateFiles must contain unique safe relative files with SHA-256 hashes");
    seen.add(file.path);
    files.push({ path: file.path, sha256: file.sha256 });
  }
  if (!seen.has(entry)) throw new TypeError("candidateFiles must include the candidate entry within candidateRoot");
  files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const stagedRoot = resolve(artifactsDir, "candidate");
  const hashes: Record<string, string> = {};
  let bytes: Buffer | undefined;
  for (const file of files) {
    const source = join(root, file.path);
    if (await realpath(source) !== source || !(await lstat(source)).isFile())
      throw new TypeError(`Candidate source must be a safe regular file: ${source}`);
    const content = await readFile(source);
    if (createHash("sha256").update(content).digest("hex") !== file.sha256)
      throw new Error(`Locked candidate source changed: ${file.path}`);
    const staged = join(stagedRoot, file.path);
    await mkdir(dirname(staged), { recursive: true });
    await writeFile(staged, content);
    hashes[staged] = file.sha256;
    if (file.path === entry) bytes = content;
  }
  if (bytes === undefined) throw new TypeError("Missing candidate entry bytes");
  return { root: stagedRoot, sourceRoot: root, entry, files, hashes, bytes };
}

/** Preserve the requested delay while respecting Node's signed 32-bit timer range. */
export async function waitForProfileRetry(attempt: number, retryDelayMs: number | undefined, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  let remaining = retryDelayMs === undefined ? (1n << BigInt(attempt)) * 1000n : BigInt(retryDelayMs);
  const maxTimerMs = BigInt(MAX_KERNEL_TIMER_MS);
  while (remaining > 0n) {
    const milliseconds = remaining > maxTimerMs ? maxTimerMs : remaining;
    await delay(Number(milliseconds), undefined, signal === undefined ? {} : { signal });
    remaining -= milliseconds;
  }
}

export interface KernelProfileResult extends Record<string, unknown> {
  kernel: string; problem: string; round: number;
  metrics: Record<string, unknown> | null; profile_dir: string;
  trace_analysis: Record<string, unknown> | null;
  roofline: Record<string, unknown> | null; error: string;
}

/** Capture failure whose retryable flag controls whether another attempt is allowed. */
class ProfileStepError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message);
  }
}

const sha256File = (path: string): string =>
  createHash("sha256").update(readFileSync(path)).digest("hex");

/** Structurally missing capture artifacts are not retryable, matching FileNotFoundError handling. */
const NON_RETRYABLE_PREFIXES = [
  "No hash found", "No PipeUtilization.csv", "No L2Cache.csv",
  "No ResourceConflictRatio.csv", "No trace.json", "msprof binary not found",
  "msprof did not create OPPROF_",
];

/** Locate msprof: require explicit paths to exist, then prefer local CANN installations over PATH. */
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

function validateReplayProtocol(value: unknown, seed: number, warmup: number, inputUnmodified: boolean): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new ProfileStepError("Replay effective input protocol mismatch", false);
  const replay = value as Record<string, unknown>;
  if (replay.seed !== seed || replay.warmup !== warmup || replay.inputUnmodified !== inputUnmodified)
    throw new ProfileStepError("Replay effective input protocol mismatch", false);
  const captured = replay["capture"];
  if (captured === null || typeof captured !== "object" || Array.isArray(captured))
    throw new ProfileStepError("Replay effective capture protocol mismatch", false);
  const capture = captured as Record<string, unknown>;
  if (capture["method"] !== "mstx" || capture["range"] !== "rsi_operator_profile" || capture["toolId"] !== 0x1001 ||
      !Number.isSafeInteger(capture["rangeId"]) || Number(capture["rangeId"]) < 0 ||
      capture["warmupCompleted"] !== warmup || capture["callsInRange"] !== 1)
    throw new ProfileStepError("Replay effective capture protocol mismatch", false);
  if (!Number.isSafeInteger(replay["logicalDevice"]) || Number(replay["logicalDevice"]) < 0 ||
      !Number.isSafeInteger(replay["deviceCount"]) || Number(replay["deviceCount"]) <= Number(replay["logicalDevice"]) ||
      replay["environment"] === null || typeof replay["environment"] !== "object" || Array.isArray(replay["environment"]))
    throw new ProfileStepError("Replay device observations are invalid", false);
  return replay;
}

/** Replay cached metrics on a hit; otherwise spawn msprof with bounded capture attempts. */
export async function kernelProfile(args: KernelProfileArgs, options: KernelExecOptions = {}, execution?: KernelProfileExecution): Promise<KernelProfileResult> {
  validateKernelExecOptions(options);
  if (options.timeoutMs !== undefined && options.timeoutMs > 0)
    options = { ...options, signal: AbortSignal.any([...(options.signal ? [options.signal] : []), AbortSignal.timeout(options.timeoutMs)]) };
  options.signal?.throwIfAborted();
  const seed = args.seed ?? 0;
  const inputUnmodified = args.inputUnmodified === undefined ? true : args.inputUnmodified;
  if (typeof inputUnmodified !== "boolean") throw new TypeError("inputUnmodified must be a boolean");
  const warmup = args.warmup ?? 25;
  const collection = args.collection === undefined ? "PipeTimeline,Default" : args.collection;
  if (collection !== "Default" && collection !== "PipeTimeline,Default")
    throw new TypeError("profiling.collection must be Default or PipeTimeline,Default");
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff) throw new TypeError("seed must be an unsigned 32-bit integer");
  if (!Number.isSafeInteger(warmup) || warmup < 1) throw new TypeError("profiling warmup must be a positive integer");
  const maxAttempts = args.maxAttempts ?? 2;
  const attemptTimeoutSeconds = args.attemptTimeoutSeconds ?? 300;
  for (const [name, value] of [["maxAttempts", maxAttempts], ["attemptTimeoutSeconds", attemptTimeoutSeconds]] as const)
    if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive integer`);
  if (attemptTimeoutSeconds * 1000 > MAX_KERNEL_TIMER_MS)
    throw new TypeError("attemptTimeoutSeconds exceeds the Node timer range");
  if (args.cacheMaxEntries !== undefined && (!Number.isSafeInteger(args.cacheMaxEntries) || args.cacheMaxEntries <= 0))
    throw new TypeError("cacheMaxEntries must be a positive integer");
  if (args.retryDelayMs !== undefined && (!Number.isSafeInteger(args.retryDelayMs) || args.retryDelayMs < 0))
    throw new TypeError("retryDelayMs must be a non-negative integer");
  const cacheEnabled = args.cacheEnabled !== false;
  const sub = "profile";
  const atomDir = execution?.atomDirectory ?? resolveAtomDir(sub, options);
  const outPath = resolve(args.out);
  const dir = dirname(outPath);
  const stem = (args.out.split(/[/\\]/).pop() ?? "profile").replace(/\.json$/, "");
  const requestPath = join(dir, `${stem}.request.json`);
  const rawPath = join(dir, `${stem}.raw.json`);

  // Capture workspace: {stem}_profiling_root/profiling/{artifacts,logs}, preserving _collect_main naming.
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
    catch { /* Log write failures must not interrupt capture. */ }
  };

  const tree = await stageCandidateTree(args, artifactsDir);
  const kernelBytes = tree.bytes;
  const context = execution?.sourceContext;
  const fixedFiles: { path: string; sha256: string }[] = [];
  if (context) {
    if (!isAbsolute(context.dataRoot)) throw new TypeError("Profile source dataRoot must be absolute");
    for (const [path, expected] of Object.entries(context.hashes)) {
      if (!isAbsolute(path) || !/^[a-f0-9]{64}$/.test(expected) || !(await lstat(path)).isFile() || await realpath(path) !== path)
        throw new TypeError(`Profile source must be a safe locked regular file: ${path}`);
      if (sha256File(path) !== expected) throw new Error(`Locked profile source changed: ${path}`);
      const dataPath = relative(context.dataRoot, path);
      const inData = dataPath !== ".." && !dataPath.startsWith(`..${sep}`) && !isAbsolute(dataPath);
      const normalized = (inData ? dataPath : relative(execution.session.workdir, path)).split(sep).join("/");
      if (normalized === ".." || normalized.startsWith("../") || isAbsolute(normalized))
        throw new TypeError(`Profile source is outside dataRoot and workdir: ${path}`);
      fixedFiles.push({ path: `${inData ? "data" : "work"}/${normalized}`, sha256: expected });
    }
    fixedFiles.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    if (context.hashes[resolve(args.problem)] !== sha256File(args.problem))
      throw new Error("Locked profile problem source changed or missing");
  }
  const selectionPolicy = "entry-first-then-declared-python/v1";
  let kernelName = findTritonKernelName(kernelBytes.toString("utf8"));
  let selectedSource = tree.entry;
  if (kernelName === undefined) {
    for (const file of tree.files) {
      if (file.path === tree.entry || !file.path.endsWith(".py")) continue;
      kernelName = findTritonKernelName(await readFile(join(tree.root, file.path), "utf8"));
      if (kernelName !== undefined) { selectedSource = file.path; break; }
    }
  }
  kernelName ??= basename(tree.entry, ".py");
  const candidate = resolve(args.kernel);
  const problem = resolve(args.problem);
  const stagedKernelPath = join(tree.root, tree.entry);
  const candidateHash = tree.hashes[stagedKernelPath]!;
  const problemHash = sha256File(problem);
  const dataRoot = context?.dataRoot ?? dirname(problem);
  const request = {
    problem, candidate, dataRoot, candidateRoot: tree.sourceRoot,
    hashes: { [problem]: problemHash, ...context?.hashes,
      ...Object.fromEntries(tree.files.map(file => [join(tree.sourceRoot, file.path), file.sha256])) },
    seeds: [seed], warmup, inputUnmodified,
    candidateSha256: candidateHash, referenceKind: "problem-model",
    profiling: { enabled: true, collection, roundNum: args.round, cacheEnabled },
  };
  await writeFile(requestPath, JSON.stringify(request, null, 2), "utf8");

  const result: Record<string, unknown> = {
    schemaVersion: 1, status: "failed", error: "", kernels: [],
    metadata: {
      outputPolicy: KERNEL_PROFILE_OUTPUT_POLICY, upstreamCommit: UPSTREAM_COMMIT, artifactRoot: basename(root),
      scope: "original-first-triton-kernel-or-file-stem",
      collection, seed, roundNum: args.round, attempts: 0, cleanup: "confirmed",
      diagnosticProtocol: { caseId: args.caseId ?? "standalone", seeds: [seed], warmup, collection, inputUnmodified,
        scope: "original-first-triton-kernel-or-file-stem", capture: "after-warmup-mstx-range", selectionPolicy: "last" },
      trace: { status: "unavailable", reason: collection === "Default" ? "not-requested-by-default-protocol" : "collection-not-completed" },
      hardwareDerived: { ubRatio: "unavailable", coreUtilization: "unavailable", reason: "No explicit hardware denominators provided" },
      cacheRequested: cacheEnabled, cacheHit: false,
      retryPolicy: { maxAttempts, attemptTimeoutSeconds, ...(args.retryDelayMs === undefined ? {} : { retryDelayMs: args.retryDelayMs }) },
    },
    artifacts: [],
  };
  const metadata = result.metadata as Record<string, unknown>;
  const started = Date.now();
  try {
    const replayRequest = {
      problem, candidate: stagedKernelPath, dataRoot, candidateRoot: tree.root,
      hashes: { [problem]: problemHash, ...context?.hashes, ...tree.hashes },
      seeds: [seed], warmup, inputUnmodified,
    };
    const replayRequestPath = join(profilingDir, "request.json");
    await writeFile(replayRequestPath, JSON.stringify(replayRequest, null, 2), "utf8");
    metadata["sources"] = {
      candidate: { path: candidate, sha256: candidateHash }, candidateFiles: tree.files,
      ...(context === undefined ? {} : { fixedFiles }),
      problem: { path: problem, sha256: problemHash },
      ...(args.contractSha256 === undefined ? {} : { contractSha256: args.contractSha256 }),
    };

    // Include visible devices and the target device in cache identity; timing evidence is device-specific.
    const workerEnv = kernelProcessEnvironment(atomDir, options);
    const visibleDevices = workerEnv.ASCEND_RT_VISIBLE_DEVICES ?? workerEnv.ASCEND_VISIBLE_DEVICES;
    const logicalDevice = workerEnv.KERNEL_NPU_DEVICE;
    const deviceScope = visibleDevices === undefined
      ? (logicalDevice === undefined ? undefined : `device-${logicalDevice}`)
      : `${visibleDevices}${logicalDevice === undefined ? "" : `:device-${logicalDevice}`}`;
    // Only evidence from the same post-warmup capture protocol can satisfy a cache hit.
    metadata["kernelSelection"] = { policy: selectionPolicy, sourcePath: selectedSource, kernelName };
    const cacheScope = deviceScope === undefined ? undefined : JSON.stringify({
      deviceScope, diagnosticProtocol: metadata["diagnosticProtocol"], problemHash, entry: tree.entry,
      candidateFiles: tree.files, selectionPolicy,
      ...(context && { problemPath: relative(dataRoot, problem).split(sep).join("/"), fixedFiles }),
    });
    const cache = cacheEnabled ? await MsProfCache.open(cacheScope, args.cacheDir, log, args.cacheMaxEntries) : null;
    metadata["cacheEnabled"] = cache !== null;
    let metrics: Record<string, Record<string, unknown>> | null = null;
    let profileDir = "";
    const restoredDir = join(profilingDir, "cache-hit-profile");
    const cached = cache === null ? null : await cache.restore(restoredDir);
    metadata["cacheHit"] = cached !== null;
    if (cached !== null) {
      // Restore cached profiles into the artifact tree so profileDir remains relative and portable.
      metrics = cached.metrics;
      profileDir = restoredDir;
      const replay = validateReplayProtocol(cached.replay, seed, warmup, inputUnmodified);
      metadata["replay"] = replay;
      await writeFile(join(profilingDir, "replay.json"), JSON.stringify(replay, null, 2), "utf8");
      log(`cache hit; metrics rebuilt from MSProfCache`);
    } else {
      const python = (execution ? options.python : process.env["KERNEL_PROFILER_PYTHON"] ?? options.python) ?? "python";
      const msprofBin = resolveMsprofBin(args.msprofBin);
      const attemptTimeout = attemptTimeoutSeconds * 1000;
      let lastError: Error | null = null;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        metadata["attempts"] = attempt;
        log(`msprof profiling attempt ${attempt}/${maxAttempts}...`);
        const attemptDir = join(artifactsDir, `attempt-${attempt}`);
        const outputDir = join(attemptDir, `msprof_round_${args.round}`);
        const replayResultPath = join(attemptDir, "replay-result.json");
        const tritonCacheDir = join(attemptDir, ".triton_cache");
        const consolePath = join(logsDir, attempt === 1 ? "console.log" : `console-attempt-${attempt}.log`);
        await mkdir(attemptDir);
        await mkdir(tritonCacheDir);
        const env: Record<string, string> = {
          ...workerEnv,
          TRITON_CACHE_DIR: tritonCacheDir,
          ENABLE_PRINT_UB_BITS: "true",
          TRITON_PRINT_AUTOTUNING: "1",
        };
        // msprof replays in a child process. Forward the filtered environment and the capture settings.
        env.PRESERVE_ENV = Object.keys(env).join(",");
        try {
          const application = `${python} ${join(atomDir, "msprof_replay.py")} --request ${replayRequestPath} --output ${replayResultPath}`;
          const active = AbortSignal.any([...(options.signal ? [options.signal] : []), AbortSignal.timeout(attemptTimeout)]);
          await runProfileProcess({ executable: msprofBin,
            args: ["op", `--output=${outputDir}`, `--application=${application}`,
              `--kernel-name=${kernelName}`, `--aic-metrics=${collection}`,
              "--mstx=on", "--mstx-include=rsi_operator_profile"],
            cwd: artifactsDir, env, inheritEnv: false,
            input: null, outputBufferBytes: null }, active, options, consolePath, execution);
          const profDirs = (await exists(outputDir))
            ? (await readdir(outputDir)).filter(name => name.startsWith("OPPROF_")).sort()
            : [];
          if (profDirs.length === 0)
            throw new ProfileStepError(`msprof did not create OPPROF_* directory in ${outputDir}`, false);
          const profDir = join(outputDir, profDirs[profDirs.length - 1]!);
          const rows: MetricRow[] = await parseMsprofMetricsTable(profDir);
          const table = rowsToMetrics(rows);
          const coreKeys = ["aiv_vec_ratio", "aiv_scalar_ratio", "aiv_mte2_ratio", "aiv_mte3_ratio", "aic_cube_ratio"];
          if (!Object.values(table).some(row => coreKeys.some(key => typeof row[key] === "number" && Number.isFinite(row[key]) && Number(row[key]) >= 0 && Number(row[key]) <= 1)))
            throw new ProfileStepError("No valid core pipe metrics", false);
          const replay = validateReplayProtocol(JSON.parse(await readFile(replayResultPath, "utf8")), seed, warmup, inputUnmodified);
          const l2 = await analyzeL2Cache(profDir);
          metadata["replay"] = replay;
          await writeFile(join(profilingDir, "replay.json"), JSON.stringify(replay, null, 2), "utf8");
          for (const entry of Object.values(table)) entry["l2_cache_analysis"] = l2;
          metadata["metricUnits"] = Object.fromEntries([...new Set(Object.values(table).flatMap(row => Object.keys(row)))].map(name => [name,
            name.endsWith("_ratio") ? "ratio" : name.endsWith("(%)") ? "percent" : name.endsWith("(us)") ? "microseconds" :
              name.endsWith("(GB/s)") ? "GB/s" : name.endsWith("(KB)") ? "KB" : name.endsWith("_instructions") ? "count" : "structured-analysis"]));
          metadata["missingMetrics"] = coreKeys.filter(key => !Object.values(table).some(row => typeof row[key] === "number"));
          metrics = table;
          profileDir = profDir;
          log(`msprof profiling completed (round ${args.round})`);
          break;
        } catch (error) {
          if (error instanceof KernelExecError) throw error;
          options.signal?.throwIfAborted();
          const message = error instanceof Error ? error.message : String(error);
          // Prefer the structured replay error when available; missing CSV or directories in msprof
          // output may only be downstream symptoms.
          try {
            const replayResult = JSON.parse(await readFile(replayResultPath, "utf8")) as Record<string, unknown>;
            if (typeof replayResult["error"] === "string" && replayResult["error"] !== "")
              throw new ProfileStepError(`replay kernel failed: ${replayResult["error"]}`, false);
          } catch (readError) {
            if (readError instanceof ProfileStepError) throw readError;
            // Missing or invalid result file: classify the original msprof error.
          }
          const timedOut = (error as { killed?: boolean }).killed === true;
          // Structural omissions (directories, CSV, traces or compilation metadata) are not retryable.
          // Timeouts, nonzero exit codes and invalid ub_ratio values may be transient msprof failures.
          const retryable = error instanceof ProfileStepError ? error.retryable : timedOut || !NON_RETRYABLE_PREFIXES.some(prefix => message.includes(prefix));
          lastError = error instanceof Error ? error : new Error(message);
          log(`attempt ${attempt} failed: ${message}`);
          if (!retryable || attempt >= maxAttempts) break;
          await waitForProfileRetry(attempt, args.retryDelayMs, options.signal);
        }
      }
      if (metrics === null)
        throw lastError ?? new Error("msprof profiling failed without diagnostics");
    }

    if (metrics !== null) {
      if (collection === "PipeTimeline,Default") {
        let trace: { traceEvents?: unknown };
        try { trace = JSON.parse(await readFile(join(profileDir, "trace.json"), "utf8")) as { traceEvents?: unknown }; }
        catch { throw new ProfileStepError("No trace.json valid data found", false); }
        if (!Array.isArray(trace.traceEvents)) throw new ProfileStepError("No trace.json events found", false);
        metadata["trace"] = { status: "available", artifact: "trace.json" };
      }
      const timestamp = new Date().toISOString().replace(/\.\d+Z$/, "Z");
      const originalMetadata = {
        kernel_file: resolve(args.kernel), problem_file: resolve(args.problem),
        round_num: args.round, timestamp, msprof_version: null,
      };
      // round{N}_msprof_metrics.json, metrics-dataframe.csv and original-result.json
      // preserve the Python artifact set for archiving and reconciliation.
      await writeFile(join(logsDir, `round${String(args.round).padStart(3, "0")}_msprof_metrics.json`),
        JSON.stringify({ metrics, metadata: originalMetadata, profile_dir: profileDir }, null, 2), "utf8");
      await writeFile(join(profilingDir, "metrics-dataframe.csv"),
        metricsToCsv(Object.entries(metrics).map(([blockId, entry]) => ({ block_id: blockId, ...entry }))), "utf8");
      await writeFile(join(profilingDir, "original-result.json"),
        JSON.stringify({ metrics, metadata: originalMetadata, profile_dir: profileDir }, null, 2), "utf8");
      metadata["originalMetadata"] = originalMetadata;
      if (profileDir !== "") metadata["profileDir"] = relativeTo(root, profileDir);
      const artifacts = profileDir ? await listArtifacts(root, profileDir) : [];
      result["kernels"] = [{
        name: kernelName, metrics,
        metadata: { ...metadata }, artifacts,
      }];
      result["status"] = "completed";
      result["error"] = "";
      if (cache !== null && cached === null)
        await cache.put(profileDir, { metrics, replay: metadata["replay"] as Record<string, unknown> });
    }
  } catch (error) {
    if (error instanceof KernelExecError) throw error;
    options.signal?.throwIfAborted();
    result["error"] = `${error instanceof Error ? error.name : "Error"}: ${
      error instanceof Error ? error.message : String(error)}`;
    log(`profiling failed: ${result["error"]}`);
  }
  metadata["durationSeconds"] = (Date.now() - started) / 1000;
  result["artifacts"] = [...await listArtifacts(root, profilingDir), "profiling/result.json"];

  const payload: Record<string, unknown> = {
    kernel: args.kernel, problem: args.problem, round: args.round,
    measured_by: "rsi-profile", metrics: null, profile_dir: "", trace_analysis: null, error: "",
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
    // Only the explicitly requested full protocol reads or analyzes pipeline trace data.
    if (collection === "PipeTimeline,Default") try {
      const profDir = String(payload["profile_dir"]);
      const traceData = JSON.parse(await readFile(join(profDir, "trace.json"), "utf8")) as { traceEvents?: unknown };
      const analysis = analyzeTraceEvents(traceData.traceEvents);
      if (analysis !== null) {
        payload["trace_analysis"] = analysis;
        await writeFile(join(profDir, "trace_analysis.json"), JSON.stringify(analysis, null, 2), "utf8");
      }
    } catch { /* Trace analysis remains null when it cannot be derived. */ }
    // Roofline classification consumes only the metrics table and runs as part of capture.
    // Classification failure leaves the capture result usable with the default "no" classification.
    const metricsTable = payload["metrics"];
    if (metricsTable !== null && typeof metricsTable === "object" && Object.keys(metricsTable as object).length > 0)
      payload["roofline"] = analyzeRoofline(metricsTable as Record<string, Record<string, unknown>>) as unknown;
  }
  result["analysis"] = { trace: payload["trace_analysis"] ?? null, roofline: payload["roofline"] ?? null };
  await writeFile(join(profilingDir, "result.json"), JSON.stringify(result, null, 2), "utf8");
  await writeFile(rawPath, JSON.stringify(result, null, 2), "utf8");
  await writeFile(outPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return { kernel: args.kernel, problem: args.problem, round: args.round,
    metrics: payload["metrics"] as Record<string, unknown> | null,
    profile_dir: String(payload["profile_dir"]),
    trace_analysis: (payload["trace_analysis"] ?? null) as Record<string, unknown> | null,
    roofline: (payload["roofline"] ?? null) as Record<string, unknown> | null,
    error: String(payload["error"]) };
}

/** Convert to relative paths; return absolute paths outside the root for the caller to handle. */
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
    // Failure to persist console.log output must not interrupt capture.
  }
}

export async function profileSingleKernel(args: Omit<KernelProfileArgs, "candidateRoot" | "candidateFiles">,
  options: KernelExecOptions = {}): Promise<KernelProfileResult> {
  const kernel = resolve(args.kernel);
  const sha256 = createHash("sha256").update(await readFile(kernel)).digest("hex");
  return kernelProfile({ ...args, candidateRoot: dirname(kernel), candidateFiles: [{ path: basename(kernel), sha256 }] }, options);
}
