#!/usr/bin/env node
import { redactNetwork, networkSecrets } from "./config/network.js";
import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { CliOverrides, LoadedConfig } from "./config/schema.js";
import { rebuildReport } from "./report.js";
import { kernelBench, kernelPrecision, kernelProfile, KernelExecError, type KernelExecOptions } from "./adapters/kernel/cli.js";
import { formatError, redactDiagnostic, summarizeDiagnostic } from "./core/diagnostics.js";
import type { ProgressEvent } from "./core/progress.js";
import type { BenchmarkComponents } from "./core/contracts/components.js";
import { openPluginRegistry, type PluginRegistry } from "./plugin-runtime.js";
import { enumerateSelectedTasks } from "./core/task-selection.js";
import { classifyError, normalizeFailure } from "./core/errors/classify.js";
import type { Phase } from "./core/contracts/result.js";
import { CliLiveProgress, type ProgressMode } from "./cli-live-progress.js";
import { safeProgress } from "./core/live-progress.js";
import type { ProgressListener } from "./core/progress.js";
import { progressOperation } from "./core/progress-operation.js";

export type CliIO = { out(text: string): void; error(text: string): void; terminal?: NodeJS.WriteStream };
const defaultIO: CliIO = {
  terminal: process.stderr,
  out: text => {
    process.stdout.write(text + "\n");
  },
  error: text => {
    process.stderr.write(text + "\n");
  },
};
const help = `
Network configuration and explicit download diagnostics:
ember-evaluator inspect <yaml> [--network <yaml>] [--patch <path>]

Run an experiment:
ember-evaluator run <yaml> [--network <yaml>] [--progress <auto|tty|plain>] [--patch <path>] [--dry-run] [--task-ids-file <json>] [--resume [run-id]] [--model <name>] [--endpoint <url>] [--api-key <key> | --api-key-env <name>]

Prepare images and runtimes without evaluation:
ember-evaluator warmup <yaml> [--network <yaml>] [--progress <auto|tty|plain>] [--patch <path>] [--task-ids-file <json>] [model overrides]

Preview or remove evaluator image references:
ember-evaluator cleanup images [<yaml>] [--all] [--yes] [--patch <path>]

Retry network failures in the same run:
ember-evaluator retry --run <run-id-or-directory> [--network <yaml>] [--progress <auto|tty|plain>] [--task-id <id>] [--request-id <id>] [--reason <text>]
Discover and initialize:
ember-evaluator benchmark list [--patch <path>]
ember-evaluator benchmark info <name> [--patch <path>]
ember-evaluator init --benchmark <name> --output <yaml> [--patch <path>]
ember-evaluator doctor <yaml> [--network <yaml>] [--patch <path>] [model overrides]

Inspect configuration:
ember-evaluator config explain <yaml> [--patch <path>] [model overrides]
ember-evaluator config resolve <yaml> [--patch <path>] [model overrides]

Generate a report:
ember-evaluator report <run-dir>

Run kernel measurement atoms (bridge to the kernel executor; precision and bench follow
the original kernel verify-then-benchmark flow, profile and roofline are independent):
ember-evaluator kernel bench --problem <path> --kernel <path> --out <json> [--device <n>] [--python <py>]
ember-evaluator kernel precision --problem <path> --kernel <path> --out <json> [--seeds 0 1] [--device <n>] [--python <py>]
ember-evaluator kernel profile --problem <path> --kernel <path> --out <json> [--round <n>] [--device <n>] [--python <py>]
ember-evaluator kernel roofline --metrics <profile-json> --out <json> [--python <py>]

Show help:
ember-evaluator --help

`;

type Command = (
  | { kind: "cleanup-images"; file?: string; all: boolean; execute: boolean; patchPath?: string }
  | { kind: "retry"; run: string; taskIds: string[]; requestId?: string; reason?: string }
  | { kind: "help" }
  | { kind: "benchmark-list"; patchPath?: string }
  | { kind: "benchmark-info"; name: string; patchPath?: string }
  | { kind: "init"; name: string; output: string; patchPath?: string }
  | { kind: "doctor"; file: string; overrides: CliOverrides; patchPath?: string }
  | { kind: "inspect"; file: string; overrides: CliOverrides; patchPath?: string }
  | { kind: "config-explain"; file: string; overrides: CliOverrides; patchPath?: string }
  | { kind: "config-resolve"; file: string; overrides: CliOverrides; patchPath?: string }
  | { kind: "report"; directory: string }
  | { kind: "kernel-profile"; problem: string; kernel: string; out: string; round: number; device: number; python?: string }
  | { kind: "kernel-precision"; problem: string; kernel: string; out: string; seeds: number[]; device: number; python?: string }
  | { kind: "kernel-bench"; problem: string; kernel: string; out: string; device: number; python?: string }
  | { kind: "run"; file: string; overrides: CliOverrides; resume?: string | null; taskIdsFile?: string; patchPath?: string }
  | { kind: "warmup"; file: string; overrides: CliOverrides; taskIdsFile?: string; patchPath?: string }
  | { kind: "dry-run"; file: string; overrides: CliOverrides; taskIdsFile?: string; patchPath?: string }
) & { networkConfigPath?: string };

export function parseArgs(argv: string[]): Command {
  const networkIndex = argv.indexOf("--network");
  if (networkIndex >= 0) {
    if (!["run", "warmup", "retry", "doctor", "config", "inspect"].includes(argv[0] ?? "") || networkIndex === 0 ||
        argv.lastIndexOf("--network") !== networkIndex || !argv[networkIndex + 1] || argv[networkIndex + 1]!.startsWith("-"))
      throw new TypeError("Invalid --network option");
    const rest = [...argv]; rest.splice(networkIndex, 2);
    return { ...parseArgs(rest), networkConfigPath: resolve(argv[networkIndex + 1]!) };
  }
  if (argv[0] === "network") throw new TypeError("Use ember-evaluator doctor <yaml> or ember-evaluator inspect <yaml>; --network <yaml> remains supported");
  if (!argv.length || (argv.length === 1 && ["--help", "-h"].includes(argv[0]!))) return { kind: "help" };
  if (argv[0] === "cleanup") {
    if (argv[1] !== "images") throw new TypeError("Expected cleanup images [yaml] [--all] [--yes]");
    let file: string | undefined, patchPath: string | undefined, all = false, execute = false;
    for (let index = 2; index < argv.length; index++) {
      const arg = argv[index]!;
      if (arg === "--all" && !all) all = true;
      else if (arg === "--yes" && !execute) execute = true;
      else if (arg === "--patch" && patchPath === undefined && argv[index + 1] && !argv[index + 1]!.startsWith("-")) patchPath = resolve(argv[++index]!);
      else if (!arg.startsWith("-") && file === undefined) file = arg;
      else throw new TypeError("Unknown or repeated image cleanup option");
    }
    if (!file && !all) throw new TypeError("Image cleanup requires YAML or --all");
    if (!file && patchPath) throw new TypeError("--patch requires YAML");
    return { kind: "cleanup-images", all, execute, ...(file ? { file } : {}), ...(patchPath ? { patchPath } : {}) };
  }
  if (argv[0] === "warmup") {
    const parsed = parseArgs(["run", ...argv.slice(1)]);
    if (parsed.kind !== "run" || parsed.resume !== undefined) throw new TypeError("warmup does not accept --resume or --dry-run");
    const { resume: _resume, ...options } = parsed;
    return { ...options, kind: "warmup" };
  }
  if (argv[0] === "retry") {
    const values: Record<string, string> = {};
    const taskIds: string[] = [];
    for (let index = 1; index < argv.length; index += 2) {
      const key = argv[index]!, value = argv[index + 1];
      if (!["--run", "--task-id", "--request-id", "--reason"].includes(key) || !value || value.startsWith("--")) throw new TypeError("Invalid retry option");
      if (key === "--task-id") taskIds.push(value);
      else { if (values[key]) throw new TypeError("Repeated retry option"); values[key] = value; }
    }
    if (!values["--run"]) throw new TypeError("retry requires --run <run-id or directory>");
    return { kind: "retry", run: values["--run"], taskIds, ...(values["--request-id"] ? { requestId: values["--request-id"] } : {}), ...(values["--reason"] ? { reason: values["--reason"] } : {}) };
  }
  if (argv[0] === "benchmark" || argv[0] === "init") {
    const kind = argv[0] === "init" ? "init" : argv[1] === "list" ? "benchmark-list" : argv[1] === "info" ? "benchmark-info" : undefined;
    if (!kind) throw new TypeError("Expected benchmark list or benchmark info <name>");
    const options: Record<string, string> = {};
    const start = kind === "init" ? 1 : kind === "benchmark-list" ? 2 : 3;
    for (let i = start; i < argv.length; i += 2) {
      const flag = argv[i], value = argv[i + 1];
      if (!flag || !value || value.startsWith("-") || options[flag] !== undefined ||
        !(kind === "init" ? ["--benchmark", "--output", "--patch"] : ["--patch"]).includes(flag))
        throw new TypeError("Unknown, repeated or incomplete discovery/init option");
      options[flag] = value;
    }
    const patch = options["--patch"] === undefined ? {} : { patchPath: resolve(options["--patch"]) };
    if (kind === "benchmark-list") return { kind, ...patch };
    const name = kind === "init" ? options["--benchmark"] : argv[2];
    if (!name || name.startsWith("-")) throw new TypeError("A benchmark name is required");
    if (kind === "benchmark-info") return { kind, name, ...patch };
    if (!options["--output"]) throw new TypeError("init requires --output <yaml>");
    return { kind, name, output: resolve(options["--output"]), ...patch };
  }
  if (argv[0] === "doctor" || argv[0] === "inspect") {
    const parsed = parseArgs(["run", ...argv.slice(1)]);
    if (parsed.kind !== "run" || parsed.resume !== undefined || parsed.taskIdsFile !== undefined)
      throw new TypeError(`${argv[0]} accepts only an experiment YAML, --network, --patch and model overrides`);
    return { kind: argv[0], file: parsed.file, overrides: parsed.overrides,
      ...(parsed.patchPath === undefined ? {} : { patchPath: parsed.patchPath }) };
  }
  if (argv[0] === "report" && argv.length === 2 && !argv[1]!.startsWith("-"))
    return { kind: "report", directory: argv[1]! };
  if (argv[0] === "kernel") {
    const sub = argv[1];
    if (sub !== "bench" && sub !== "precision" && sub !== "profile")
      throw new TypeError("Expected kernel bench, precision or profile");
    const allowed = sub === "profile" ? ["--problem", "--kernel", "--out", "--round", "--device", "--python"]
      : sub === "precision" ? ["--problem", "--kernel", "--out", "--seeds", "--device", "--python"]
      : ["--problem", "--kernel", "--out", "--device", "--python"];
    const values: Record<string, string> = {};
    for (let i = 2; i < argv.length; i += 1) {
      const flag = argv[i]!;
      if (!allowed.includes(flag)) throw new TypeError(`Unknown kernel ${sub} option: ${flag}`);
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) throw new TypeError(`Missing value for ${flag} option`);
      if (values[flag] !== undefined) throw new TypeError(`Repeated ${flag} option`);
      values[flag] = value;
      i += 1;
    }
    const py = () => (values["--python"] === undefined ? {} : { python: values["--python"] });
    const device = () => (values["--device"] === undefined ? { device: 0 } : { device: integer("--device") });
    const integer = (flag: string, fallback?: number): number => {
      const raw = values[flag];
      if (raw === undefined) {
        if (fallback === undefined) throw new TypeError(`${flag} is required`);
        return fallback;
      }
      const value = Number(raw);
      if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${flag} must be a non-negative integer`);
      return value;
    };
    if (sub === "bench" || sub === "precision" || sub === "profile") {
      const problem = values["--problem"], kernel = values["--kernel"], out = values["--out"];
      if (problem === undefined || kernel === undefined || out === undefined)
        throw new TypeError(`kernel ${sub} requires --problem, --kernel and --out`);
      if (sub === "profile") {
        const round = integer("--round", 0);
        return { kind: "kernel-profile", problem: resolve(problem), kernel: resolve(kernel), out: resolve(out), round, ...device(), ...py() };
      }
      if (sub === "precision") {
        const seeds = (values["--seeds"] ?? "0 1").split(/\s+/).map(Number)
          .filter((seed) => Number.isSafeInteger(seed) && seed >= 0);
        return { kind: "kernel-precision", problem: resolve(problem), kernel: resolve(kernel), out: resolve(out), seeds, ...device(), ...py() };
      }
      return { kind: "kernel-bench", problem: resolve(problem), kernel: resolve(kernel), out: resolve(out), ...device(), ...py() };
    }
    throw new TypeError(`Unknown kernel subcommand: ${sub}`);
  }
  if (argv[0] === "config" && (argv[1] === "explain" || argv[1] === "resolve")) {
    const parsed = parseArgs(["run", ...argv.slice(2)]);
    if (parsed.kind !== "run" || parsed.resume !== undefined || parsed.taskIdsFile !== undefined)
      throw new TypeError("config commands accept only --patch and model overrides");
    return { kind: argv[1] === "explain" ? "config-explain" : "config-resolve", file: parsed.file,
      overrides: parsed.overrides, ...(parsed.patchPath === undefined ? {} : { patchPath: parsed.patchPath }) };
  }
  if (argv[0] !== "run" || !argv[1] || argv[1].startsWith("-"))
    throw new TypeError("Expected run <yaml> or report <run-dir>");
  const flags: Record<string, keyof CliOverrides> = {
    "--model": "model",
    "--endpoint": "endpoint",
    "--api-key": "apiKey",
    "--api-key-env": "apiKeyEnv",
  };
  const overrides: CliOverrides = {};
  let dryRun = false;
  let resume: string | null | undefined;
  let taskIdsFile: string | undefined;
  let patchPath: string | undefined;
  for (let index = 2; index < argv.length; ) {
    if (argv[index] === "--dry-run") {
      if (dryRun) throw new TypeError("Repeated --dry-run option");
      dryRun = true;
      index++;
      continue;
    }
    if (argv[index] === "--task-ids-file") {
      const value = argv[index + 1];
      if (taskIdsFile !== undefined || value === undefined || value.startsWith("--")) {
        throw new TypeError("Repeated or incomplete --task-ids-file option");
      }
      taskIdsFile = value;
      index += 2;
      continue;
    }
    if (argv[index] === "--patch") {
      const value = argv[index + 1];
      if (patchPath !== undefined || value === undefined || value.startsWith("--")) {
        throw new TypeError("Repeated or incomplete --patch option");
      }
      patchPath = resolve(value);
      index += 2;
      continue;
    }
    if (argv[index] === "--resume") {
      if (resume !== undefined) throw new TypeError("Repeated --resume option");
      const value = argv[index + 1];
      resume = value !== undefined && !value.startsWith("--") ? value : null;
      index += resume === null ? 1 : 2;
      continue;
    }
    const field = flags[argv[index]!];
    const value = argv[index + 1];
    if (!field || value === undefined || value.startsWith("--") || overrides[field] !== undefined)
      throw new TypeError("Unknown, repeated or incomplete run option");
    overrides[field] = value;
    index += 2;
  }
  if (overrides.apiKey !== undefined && overrides.apiKeyEnv !== undefined)
    throw new TypeError("Choose --api-key or --api-key-env");
  if (dryRun && resume !== undefined) throw new TypeError("--dry-run cannot be combined with --resume");
  return dryRun
    ? {
        kind: "dry-run",
        file: argv[1],
        overrides,
        ...(taskIdsFile === undefined ? {} : { taskIdsFile }),
        ...(patchPath === undefined ? {} : { patchPath }),
      }
    : {
        kind: "run",
        file: argv[1],
        overrides,
        ...(resume === undefined ? {} : { resume }),
        ...(taskIdsFile === undefined ? {} : { taskIdsFile }),
        ...(patchPath === undefined ? {} : { patchPath }),
      };
}

async function readTaskIds(path: string | undefined): Promise<string[] | undefined> {
  if (path === undefined) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(resolve(path), "utf8")) as unknown;
  } catch {
    throw new TypeError("task IDs file must contain valid JSON");
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new TypeError("task IDs file must be an object with taskIds");
  }
  const taskIds = (raw as { taskIds?: unknown }).taskIds;
  if (!Array.isArray(taskIds) || taskIds.length === 0 || taskIds.some(id => typeof id !== "string" || !id.trim())) {
    throw new TypeError("taskIds must be a non-empty array of non-empty strings");
  }
  if (new Set(taskIds).size !== taskIds.length) {
    throw new TypeError("taskIds must not contain duplicates");
  }
  return [...taskIds];
}

function applyTaskIds(config: LoadedConfig, taskIds: readonly string[] | undefined): void {
  if (taskIds === undefined) return;
  const run = { ...config.experiment.run };
  delete run.sampling;
  delete run.offset;
  config.experiment.run = { ...run, maxTasks: null, taskIds: [...taskIds] };
}

export async function runCli(
  argv: string[],
  io: CliIO = defaultIO,
  signal: AbortSignal = new AbortController().signal,
  execution?: { config: LoadedConfig; registry: PluginRegistry; runId?: string },
  observers?: { onProgress?: ProgressListener },
): Promise<number> {
  let mode: ProgressMode = "auto";
  const args = [...argv];
  const index = args.indexOf("--progress");
  if (index >= 0) {
    const value = args[index + 1];
    if (!["run", "retry", "warmup"].includes(args[0] ?? "") || index < 1 || !["auto", "tty", "plain"].includes(value ?? "") || args.lastIndexOf("--progress") !== index) {
      io.error("Invalid --progress option; expected auto, tty or plain on run/retry/warmup"); return 2;
    }
    mode = value as ProgressMode;
    args.splice(index, 2);
  }
  const stream = io.terminal;
  const live = CliLiveProgress.enabled(mode, stream) ? new CliLiveProgress(stream, text => io.error(text)) : undefined;
  const wrapped: CliIO = { out: text => live ? live.write(() => io.out(text)) : io.out(text),
    error: text => live ? live.write(() => io.error(text)) : io.error(text) };
  try {
    return await runCliCommand(args, wrapped, signal, execution, event => {
      live?.observe(event);
      observers?.onProgress?.(event);
    });
  } finally { live?.close(); }
}

async function runCliCommand(
  argv: string[], io: CliIO, signal: AbortSignal,
  execution: { config: LoadedConfig; registry: PluginRegistry; runId?: string } | undefined,
  onProgress: ProgressListener,
): Promise<number> {
  const started = performance.now();
  const debug = /^(1|true)$/i.test(process.env.EVALUATOR_DEBUG ?? "");
  const infoPhases = new Set([
    "deployment",
    "source",
    "resume",
    "recover",
    "retry",
    "execute",
    "install",
    "prepare",
    "environment",
    "solve",
    "transfer",
    "verify",
    "task",
    "report",
    "complete",
  ]);
  const secrets: string[] = [];
  let phase = "arguments";
  let detail = "Parsing command arguments";
  let networkHintShown = false;
  let debugHintShown = false;
  const writeHint = (message: string) => io.error(`[hint] ${message}`);
  const debugHint = () => {
    if (!debug && !debugHintShown) {
      debugHintShown = true;
      writeHint("Set EVALUATOR_DEBUG=1 for full errors and execution details. For saved tasks, see result.json / agent/stderr.log in the results directory.");
    }
  };
  const hint = (text: string) => {
    if (
      !networkHintShown &&
      /fetch failed|\b(?:ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|UND_ERR_\w+)\b/i.test(text)
    ) {
      networkHintShown = true;
      writeHint("Check connectivity to the URL/host above (DNS, proxy, TLS). Use --network network.yaml to select download sources and per-location proxies; the default Hugging Face origin is https://huggingface.co. Model API variables do not configure dataset access.");
    }
  };
  const progress = (event: ProgressEvent) => {
    event = safeProgress(event, secrets);
    onProgress(event);
    if (event.transient) return;
    if (event.taskId === undefined) {
      phase = event.phase;
      detail = event.message;
    }
    const verbose = !infoPhases.has(event.phase);
    if (!debug && verbose && !event.error && !event.warning) return;
    const ordinal = event.taskNumber === undefined ? "" : `Task ${event.taskNumber}/${event.taskTotal} `;
    const task =
      event.taskId === undefined
        ? ""
        : ` ${ordinal}task=${event.taskId}${debug ? ` attempt=${event.attemptId ?? "unknown"}` : ""}`;
    const level = event.error ? "error" : event.warning ? "warning" : verbose ? "debug" : "info";
    const structured = event.failure ? normalizeFailure(event.failure, secrets) : undefined;
    const safeMessage = redactDiagnostic(structured && !event.message.startsWith(`${structured.code}:`)
      ? `${structured.code}: ${event.message}` : event.message, secrets);
    const message = event.error && !debug ? summarizeDiagnostic(safeMessage) : safeMessage;
    const text = redactDiagnostic(
      `[${((performance.now() - started) / 1000).toFixed(1)}s] [${level}] [${event.phase}]${task} ${event.error ? "ERROR: " : ""}${message}`,
      secrets,
    );
    io.error(structured ? `${text} [${structured.category}/${structured.scope}]\n[hint] ${structured.hint}` : text);
    if (event.error) {
      hint(text);
      debugHint();
    }
  };
  const failure = (error: unknown) => {
    const text = formatError(error, secrets);
    const failurePhase: Phase = ["dispose", "recover"].includes(phase) ? "cleanup" : phase === "finalize" ? "store"
      : phase === "solve" || phase === "verify" || phase === "cleanup" || phase === "transfer" || phase === "collect" || phase === "store" ? phase : "prepare";
    const component = ["arguments", "config", "bootstrap", "resume"].includes(phase) ? "config" : phase === "report" ? "report"
      : phase === "source" || phase === "enumerate" ? "source" : ["scheduler", "execute"].includes(phase) ? "scheduler" : "runtime";
    const structured = classifyError(signal.aborted ? signal.reason : error, { phase: failurePhase, component, secrets,
      ...(signal.aborted ? { cancellation: "user" } : {}) });
    io.error(redactDiagnostic(`[${phase}] ERROR during ${detail}:\n${structured.code} [${structured.category}/${structured.scope}]: ${debug ? text : summarizeDiagnostic(text)}\n[hint] ${structured.hint}`, secrets));
    hint(text);
    debugHint();
  };
  let command: Command;
  try {
    command = parseArgs(argv);
  } catch (error) {
    failure(error);
    io.error(help);
    return 2;
  }
  const networkOptions = command.networkConfigPath === undefined ? {} : { networkConfigPath: command.networkConfigPath };
  if (command.kind === "help") {
    io.out(help);
    return 0;
  }
  if (command.kind === "cleanup-images") {
    try {
      phase = "cleanup";
      detail = command.execute ? "Removing evaluator image references" : "Previewing evaluator image references";
      secrets.push(...Object.entries(process.env).filter(([name]) => /(?:KEY|TOKEN|PASSWORD|SECRET)$/iu.test(name)).flatMap(([, value]) => value ? [value] : []));
      const { cleanupImages } = await import("./cleanup.js");
      const result = await cleanupImages({ ...command, signal, ...(execution ? { execution } : {}),
        onLoaded: config => secrets.push(...networkSecrets(config.network), ...Object.values(config.auths).map(auth => auth.value).filter(Boolean)) });
      io.out(JSON.stringify(result, null, 2));
      if (signal.aborted) return 130;
      return result.nodes.some(node => node.error || node.items.some(item => item.status === "failed")) ? 1 : 0;
    } catch (error) { failure(error); return signal.aborted ? 130 : 1; }
  }
  if (command.kind === "retry") {
    try {
      const { retryRun } = await import("./retry.js");
      return await retryRun(command, signal, io.out, progress);
    } catch (error) { failure(error); return signal.aborted ? 130 : 2; }
  }
  if (command.kind === "benchmark-list" || command.kind === "benchmark-info" || command.kind === "init") {
    let registry: PluginRegistry | undefined;
    try {
      registry = await openPluginRegistry(command.patchPath);
      const { benchmarkNames, benchmarkInfo, initializeExperiment } = await import("./commands/benchmark.js");
      if (command.kind === "benchmark-list") io.out(benchmarkNames(registry).join("\n"));
      else if (command.kind === "benchmark-info") io.out(JSON.stringify(benchmarkInfo(registry, command.name), null, 2));
      else { await initializeExperiment(registry, command.name, command.output); io.out(command.output); }
      return 0;
    } catch (error) { failure(error); return signal.aborted ? 130 : 2; }
    finally { await registry?.dispose(); }
  }
  if (command.kind === "doctor") {
    let registry: PluginRegistry | undefined;
    secrets.push(command.overrides.apiKey ?? "", process.env[command.overrides.apiKeyEnv ?? ""] ?? "");
    try {
      const { diagnoseDownloads } = await import("./commands/network-diagnosis.js");
      registry = await openPluginRegistry(command.patchPath);
      const { loadConfig } = await import("./config/load.js");
      const { bootstrapBenchmark } = await import("./bootstrap.js");
      const { diagnose } = await import("./commands/doctor.js");
      const config = await loadConfig(resolve(command.file), command.overrides, process.env, { registry, ...networkOptions });
      secrets.push(...networkSecrets(config.network), ...Object.values(config.auths).map(auth => auth.value));
      await bootstrapBenchmark(config, dirname(resolve(command.file)), command.patchPath, registry);
      const checks = await diagnose(config, command.file, signal);
      const network = await diagnoseDownloads({ config, configPath: command.file,
        ...(command.patchPath ? { patchPath: command.patchPath } : {}) }, signal, io.error);
      io.out(JSON.stringify({ checks, network }, null, 2));
      const networkPassed = network.status === "passed";
      return signal.aborted ? 130 : checks.some(check => check.status === "failed") || !networkPassed ? 1 : 0;
    } catch (error) { failure(error); return signal.aborted ? 130 : 2; }
    finally { await registry?.dispose(); }
  }
  if (command.kind === "report") {
    progress({ phase: "report", message: `Computing metrics and generating a report from saved results: ${resolve(command.directory)}` });
    try {
      await rebuildReport(command.directory);
      io.out(join(resolve(command.directory), "report.md"));
      return 0;
    } catch (error) {
      failure(error);
      return 1;
    }
  }
  if (command.kind === "kernel-profile" || command.kind === "kernel-precision" || command.kind === "kernel-bench") {
    const options: KernelExecOptions = { signal,
      ...(command.python === undefined ? {} : { python: command.python }),
      ...(command.device === 0 ? {} : { device: command.device }) };
    try {
      const payload = command.kind === "kernel-profile" ? await kernelProfile(command, options)
        : command.kind === "kernel-precision" ? await kernelPrecision(command, options)
        : await kernelBench(command, options);
      io.out(JSON.stringify(payload, null, 2));
      return 0;
    } catch (error) {
      // 业务错误（verify not passed / measure wrote nothing 等）按 kernel 契约退 1；
      // 执行环境故障（解释器缺失、超时、取消、无 JSON）走统一诊断路径退 2/130。
      if (error instanceof KernelExecError && !error.infra) {
        io.error(error.message);
        return 1;
      }
      failure(error);
      return signal.aborted ? 130 : 2;
    }
  }
  if (command.kind === "config-explain" || command.kind === "config-resolve" || command.kind === "inspect") {
    const { loadConfig } = await import("./config/load.js");
    const { stringify } = await import("yaml");
    const { explainConfig } = await import("./config/explain.js");
    const { exportConfig } = await import("./config/export.js");
    secrets.push(command.overrides.apiKey ?? "", process.env[command.overrides.apiKeyEnv ?? ""] ?? "");
    try {
      const config = await loadConfig(resolve(command.file), command.overrides, process.env, {
        allowMissingAuth: true, validatePlugins: true, ...networkOptions,
        ...(command.patchPath === undefined ? {} : { patchPath: command.patchPath }),
      });
      io.out(command.kind === "inspect" ? JSON.stringify({ experiment: exportConfig(config),
        network: { configPath: config.network!.origin, digest: config.network!.digest, settings: redactNetwork(config.network!.settings) } }, null, 2)
        : command.kind === "config-explain" ? explainConfig(config) : stringify(exportConfig(config)).trimEnd());
      if (JSON.stringify(config.persisted).includes("[runtime-provided]"))
        io.error("Runtime credentials were replaced with an EVALUATOR_API_KEY environment reference. Provide credentials through that variable or the CLI when running the exported configuration.");
      return 0;
    } catch (error) {
      failure(error);
      return 2;
    }
  }
  if (command.kind === "dry-run") {
    const { loadConfig } = await import("./config/load.js");
    const { bootstrapBenchmark } = await import("./bootstrap.js");
    secrets.push(
      command.overrides.apiKey ?? "",
      process.env[command.overrides.apiKeyEnv ?? ""] ?? "",
      process.env.MODEL_API_KEY ?? "",
      process.env.JUDGE_MODEL_API_KEY ?? "",
    );
    let config: LoadedConfig;
    let benchmarkComponents: BenchmarkComponents;
    let registry: PluginRegistry | undefined;
    try {
      const taskIds = await readTaskIds(command.taskIdsFile);
      progress({ phase: "config", message: `Loading and validating ${resolve(command.file)}` });
      registry = await openPluginRegistry(command.patchPath);
      config = await loadConfig(resolve(command.file), command.overrides, process.env, { registry, allowMissingAuth: true, ...networkOptions, ...(command.patchPath === undefined ? {} : { patchPath: command.patchPath }) });
      applyTaskIds(config, taskIds);
      secrets.push(...networkSecrets(config.network), ...Object.values(config.auths).map(auth => auth.value));
      progress({ phase: "bootstrap", message: `Initializing benchmark plugin: ${config.experiment.benchmark.name}` });
      benchmarkComponents = await bootstrapBenchmark(config, dirname(resolve(command.file)), command.patchPath, registry);
    } catch (error) {
      await registry?.dispose();
      failure(error);
      return signal.aborted ? 130 : 2;
    }
    let exitCode = 0;
    try {
      phase = "source";
      detail = `Resolving benchmark source ${config.experiment.benchmark.name}`;
      const source = await progressOperation(progress, { phase, message: `Preparing dataset ${config.experiment.benchmark.name} (checking the cache and downloading as needed)` }, signal,
        activity => benchmarkComponents.benchmark.resolveSource(null, signal, activity));
      phase = "enumerate";
      detail = `Enumerating tasks from ${source.source}`;
      const { selected } = await progressOperation(progress, { phase, message: `Reading tasks from ${source.source} revision=${source.revision}` }, signal,
        activity => enumerateSelectedTasks(
        benchmarkComponents.benchmark,
        source,
        config.experiment.run,
        signal,
        activity,
      ));
      signal.throwIfAborted();
      io.out(JSON.stringify({ taskIds: selected.map(ref => ref.id) }));
    } catch (error) {
      failure(error);
      exitCode = signal.aborted ? 130 : 2;
    } finally {
      progress({ phase: "dispose", message: "Releasing benchmark resources" });
      try {
        await benchmarkComponents.dispose();
        await registry?.dispose();
      } catch (error) {
        failure(error);
        if (exitCode !== 130) exitCode = 1;
      }
    }
    return exitCode;
  }
  if (command.kind === "warmup") {
    const { executeWarmup } = await import("./warmup.js");
    secrets.push(command.overrides.apiKey ?? "", ...Object.entries(process.env)
      .filter(([name]) => /(?:KEY|TOKEN|PASSWORD|SECRET)$/iu.test(name)).flatMap(([, value]) => value ? [value] : []));
    try {
      const taskIds = await readTaskIds(command.taskIdsFile);
      const result = await executeWarmup({ ...networkOptions, configPath: command.file, overrides: command.overrides, signal, onProgress: progress,
        ...(execution ? { execution } : {}),
        ...(command.patchPath ? { patchPath: command.patchPath } : {}), ...(taskIds ? { taskIds } : {}),
        onLoaded: config => { secrets.push(...networkSecrets(config.network), ...Object.values(config.auths).map(auth => auth.value)); } });
      io.out(`Image warmup: ${result.readyTaskIds.length}/${result.taskIds.length} tasks ready; ${result.failures.length} failed`);
      for (const { taskId, failure } of result.failures) {
        io.out(`${taskId}: [${failure.code}] ${failure.message}`);
      }
      return result.status === "ready" ? 0 : 1;
    } catch (error) { failure(error); return signal.aborted ? 130 : ["arguments", "config", "bootstrap"].includes(phase) ? 2 : 1; }
  }
  // Keep full experiment imports outside the offline report path.
  const { executeExperiment } = await import("./run.js");
  secrets.push(command.overrides.apiKey ?? "", process.env[command.overrides.apiKeyEnv ?? ""] ?? "",
    process.env.MODEL_API_KEY ?? "", process.env.JUDGE_MODEL_API_KEY ?? "");
  let taskIds: string[] | undefined;
  try { taskIds = await readTaskIds(command.taskIdsFile); }
  catch (error) { failure(error); return signal.aborted ? 130 : 2; }
  const outcome = await executeExperiment({ ...networkOptions, configPath: command.file, overrides: command.overrides, signal,
    ...(command.patchPath === undefined ? {} : { patchPath: command.patchPath }),
    ...(command.resume === undefined ? {} : { resume: command.resume === null ? true : command.resume }),
    ...(taskIds === undefined ? {} : { taskIds }),
    ...(execution === undefined ? {} : { execution }),
    onProgress: progress,
    onLoaded: config => { secrets.push(...networkSecrets(config.network), ...Object.values(config.auths).map(auth => auth.value)); },
    onDiagnostic: diagnostic => { phase = diagnostic.phase; failure(diagnostic.error); },
    onDeploymentLog: io.out,
  });
  if (outcome.result?.kind === "local" && outcome.diagnostics.length === 0) io.out(outcome.result.runDirectory);
  return outcome.exitCode;
}

// Global package installs can invoke the CLI through a symlink or Windows junction.
if (process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url) {
  const controller = new AbortController();
  const cancel = () => controller.abort(new DOMException("User cancelled", "AbortError"));
  process.on("SIGINT", cancel);
  process.on("SIGTERM", cancel);
  try {
    process.exitCode = await runCli(process.argv.slice(2), defaultIO, controller.signal);
  } catch (error) {
    defaultIO.error(formatError(error));
    process.exitCode = 1;
  } finally {
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
  }
}
