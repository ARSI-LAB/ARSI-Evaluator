import type { WorkflowEvent } from "../core/contracts/workflow.js";
import { CommandUsageError, parseCommand as parseArgs } from "./commands.js";
import { readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { formatError, redactDiagnostic, summarizeDiagnostic } from "../core/errors/diagnostics.js";
import type { ProgressEvent } from "../core/progress/progress.js";
import { openPluginRegistry, type PluginRegistry } from "../application/plugins/open-registry.js";
import { cliPatchPath, loadCliExtensions, type CliExtensions } from "../application/plugins/cli-extensions.js";
import type { PluginCliResult } from "../core/contracts/plugin-extension.js";
import { classifyError, normalizeFailure } from "../core/errors/classify.js";
import type { Phase } from "../core/contracts/result.js";
import { CliLiveProgress, type ProgressMode } from "./live-progress.js";
import { safeProgress } from "../core/progress/live-progress.js";
import type { ProgressListener } from "../core/progress/progress.js";

export type CliIO = { out(text: string): void; error(text: string): void; terminal?: NodeJS.WriteStream };
export const defaultIO: CliIO = {
  terminal: process.stderr,
  out: text => {
    process.stdout.write(text + "\n");
  },
  error: text => {
    process.stderr.write(text + "\n");
  },
};
import type { Command } from "./commands.js";
export type { Command } from "./commands.js";

export { parseCommand as parseArgs } from "./commands.js";

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

export async function runCli(
  argv: string[],
  io: CliIO = defaultIO,
  signal: AbortSignal = new AbortController().signal,
  observers?: { onProgress?: ProgressListener },
): Promise<number> {
  let extensions: CliExtensions;
  try { extensions = await loadCliExtensions(cliPatchPath(argv)); }
  catch (error) { io.error(formatError(error)); return 2; }
  let mode: ProgressMode = "auto";
  const args = [...argv];
  const index = args.indexOf("--progress");
  if (index >= 0 && !extensions.commands.some(command => command.name === args[0])) {
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
    return await runCliCommand(args, extensions, wrapped, signal, event => {
      live?.observe(event);
      observers?.onProgress?.(event);
    });
  } finally { live?.close(); }
}

async function runCliCommand(
  argv: string[], extensions: CliExtensions, io: CliIO, signal: AbortSignal,
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
    command = parseArgs(argv, extensions);
  } catch (error) {
    if (error instanceof CommandUsageError) { failure(error); io.error(error.helpText); return 2; }
    failure(error);
    io.error("Use arsi-evaluator <command> --help for usage and parameter details.");
    return 2;
  }
  const networkOptions = command.networkConfigPath === undefined ? {} : { networkConfigPath: command.networkConfigPath };
  if (command.kind === "help") {
    io.out(command.text);
    return command.exitCode ?? 0;
  }
  if (command.kind === "plugin") {
    const label = command.plugin.name;
    // Plugin operations are infrastructure failures, so they must not use the task-oriented error taxonomy
    const report = (stage: string, error: unknown) => {
      const text = formatError(error, secrets);
      io.error(redactDiagnostic(`[${label}] ERROR during ${stage}:\n${text}`, secrets));
      hint(text);
    };
    let result: PluginCliResult;
    try {
      result = await command.plugin.run(command.argv, io, signal);
    } catch (error) {
      report(`loading the ${label} plugin`, error);
      return signal.aborted ? 130 : 1;
    }
    if (result.ok) return result.status;
    if (result.usage) {
      phase = "arguments";
      detail = `Parsing ${label} arguments`;
      failure(result.error);
      io.error(`Use arsi-evaluator ${label} <command> --help for usage and parameter details.`);
      return 2;
    }
    report(`running the ${label} plugin`, result.error);
    return signal.aborted ? 130 : 1;
  }
  if (command.kind === "workflow-list") {
    try {
      const { listWorkflows } = await import("../application/workflow.js");
      const templates = await listWorkflows(command.patchPath);
      io.out(command.json ? JSON.stringify(templates, null, 2) : templates.map(template => `${template.name}\t${template.version}`).join("\n"));
      return 0;
    } catch (error) { failure(error); return 2; }
  }
  if (command.kind === "run" || command.kind === "inspect" || command.kind === "dry-run" || command.kind === "warmup" || command.kind === "doctor") {
    try {
      phase = "config"; detail = `Loading ${command.file}`;
      const { inspectWorkflow, exportWorkflow } = await import("../application/workflow.js");
      const { maintainWorkflow } = await import("../application/workflow-maintenance.js");
      const { apiKey, plugins, ...parameterOverrides } = command.overrides;
      const env = { ...process.env };
      if (apiKey !== undefined) {
        if (!apiKey.trim()) throw new TypeError("API key must not be empty");
        env.EVALUATOR_CLI_API_KEY = apiKey;
        parameterOverrides.apiKeyEnv = "EVALUATOR_CLI_API_KEY";
      }
      secrets.push(...Object.entries(env).filter(([name]) => /(?:KEY|TOKEN|PASSWORD|SECRET)$/iu.test(name)).flatMap(([, value]) => value ? [value] : []));
      const taskIds = "taskIdsFile" in command ? await readTaskIds(command.taskIdsFile) : undefined;
      const options = { configPath: command.file, ...(plugins ? { plugins } : {}), ...networkOptions, env, signal,
        parameterOverrides: { ...parameterOverrides, ...(taskIds ? { taskIds } : {}) },
        ...(command.patchPath ? { patchPath: command.patchPath } : {}),
        onEvent: (event: WorkflowEvent) => progress(event.progress ?? { phase: event.status === "running" ? "workflow" : "execute", message: `${event.path}: ${event.message}`, error: event.status === "failed" }),
      };
      if (command.kind === "doctor" || command.kind === "dry-run") {
        const operation = command.kind === "doctor" ? "doctor" : "preview";
        const results = await maintainWorkflow({ ...options,
          ...(command.kind === "doctor" ? { onEvent: (event: WorkflowEvent) => io.error(event.message) } : {}),
        }, { operation, options: {} });
        if (command.kind === "dry-run" && results.every(item => item.status === "not-required"))
          throw new TypeError("This workflow does not provide a preview operation; use inspect to view its plan");
        io.out(JSON.stringify(results, null, 2));
        return signal.aborted ? 130 : results.some(item => ["failed", "incomplete", "deferred"].includes(item.status)) ? 1 : 0;
      }
      if (command.kind === "inspect") {
        if (command.output) { await exportWorkflow(options, command.output); io.out(command.output); }
        else io.out(JSON.stringify(await inspectWorkflow(options), null, 2));
        return 0;
      }
      if (command.kind === "warmup") {
        const { warmupWorkflow } = await import("../application/workflow-warmup.js");
        const results = await warmupWorkflow(options);
        const active = results.filter(item => item.status !== "not-required");
        if (!active.length) io.out("No warmup required");
        for (const result of active) {
          io.out("summary" in result && result.summary !== undefined ? result.summary : `${result.provider}: ${result.status}`);
          if ("details" in result) for (const line of result.details ?? []) io.out(line);
        }
        return signal.aborted ? 130 : active.some(item => item.status !== "passed") ? 1 : 0;
      }
      const { Evaluator, EvaluatorRunError } = await import("../application/evaluator.js");
      try {
        const result = await new Evaluator().run({ ...options,
          ...(command.resume === undefined ? {} : { resume: command.resume === null ? true : command.resume }) });
        io.out(result.runDirectory);
        return result.exitCode;
      } catch (error) {
        if (error instanceof EvaluatorRunError) { phase = error.phase; failure(error); if (error.result) io.out(error.result.runDirectory); return error.exitCode; }
        throw error;
      }
    } catch (error) { failure(error); return signal.aborted ? 130 : 2; }
  }
  if (command.kind === "cleanup-images") {
    try {
      phase = "cleanup";
      detail = command.execute ? "Removing evaluator image references" : "Previewing evaluator image references";
      secrets.push(...Object.entries(process.env).filter(([name]) => /(?:KEY|TOKEN|PASSWORD|SECRET)$/iu.test(name)).flatMap(([, value]) => value ? [value] : []));
      if (command.file) {
        const { maintainWorkflow } = await import("../application/workflow-maintenance.js");
        const results = await maintainWorkflow({ configPath: command.file, signal, ...networkOptions,
          ...(command.patchPath ? { patchPath: command.patchPath } : {}), onEvent: event => io.error(event.message) },
          { operation: "cleanup-images", options: { all: command.all, execute: command.execute } });
        io.out(JSON.stringify(results, null, 2));
        return results.some(item => item.status === "failed" || item.status === "incomplete" || item.status === "deferred") ? 1 : 0;
      }
      const { cleanupImages } = await import("../application/cleanup.js");
      const result = await cleanupImages({ execute: command.execute, signal });
      io.out(JSON.stringify(result, null, 2));
      if (signal.aborted) return 130;
      return result.nodes.some(node => node.error || node.items.some(item => item.status === "failed")) ? 1 : 0;
    } catch (error) { failure(error); return signal.aborted ? 130 : 1; }
  }
  if (command.kind === "retry") {
    try {
      if (command.networkConfigPath) throw new TypeError("Workflow retry uses the network settings from the original run");
      const { retryWorkflow } = await import("../application/workflow.js");
      const result = await retryWorkflow(command.run, { signal, taskIds: command.taskIds,
        ...(command.requestId ? { requestId: command.requestId } : {}), ...(command.reason ? { reason: command.reason } : {}),
        ...(command.patchPath ? { patchPath: command.patchPath } : {}), onEvent: event => progress(event.progress ?? { phase: "retry", message: `${event.path}: ${event.message}`, error: event.status === "failed" }) });
      if (result.request.status === "rejected") { io.error(`Retry request ${result.request.requestId}: ${result.request.message ?? "rejected"}`); return 2; }
      if (result.queued) { io.out(`Retry request ${result.request.requestId}: ${result.request.status}; ${result.directory}`); return 0; }
      io.out(`Workflow ${result.record.status}: ${result.directory}`);
      return result.record.status === "completed" ? 0 : result.record.status === "cancelled" ? 130 : 1;
    } catch (error) { failure(error); return signal.aborted ? 130 : 2; }
  }
  if (command.kind === "init-workflow") {
    try {
      const { initializeWorkflow } = await import("../application/workflow.js");
      await initializeWorkflow(command.name, command.output, command.patchPath);
      io.out(command.output); return 0;
    } catch (error) { failure(error); return 2; }
  }
  if (command.kind === "init" || command.kind === "benchmark-list" || command.kind === "benchmark-info") {
    let registry: PluginRegistry | undefined;
    try {
      registry = await openPluginRegistry(command.patchPath);
      const { benchmarkList, benchmarkInfo, formatBenchmarkTable, initializeExperiment } = await import("../application/benchmarks.js");
      if (command.kind === "benchmark-list") {
        const rows = benchmarkList(registry);
        io.out(command.json ? JSON.stringify(rows, null, 2) : formatBenchmarkTable(rows));
      } else if (command.kind === "benchmark-info") io.out(JSON.stringify(benchmarkInfo(registry, command.name), null, 2));
      else { await initializeExperiment(registry, command.name, command.output); io.out(command.output); }
      return 0;
    } catch (error) { failure(error); return signal.aborted ? 130 : 2; }
    finally { await registry?.dispose(); }
  }
  if (command.kind === "report") {
    progress({ phase: "report", message: `Computing metrics and generating a report from saved results: ${resolve(command.directory)}` });
    try {
      const { rebuildWorkflowReport } = await import("../application/workflow-report.js");
      await rebuildWorkflowReport(command.directory);
      io.out(join(resolve(command.directory), "report.md"));
      return 0;
    } catch (error) {
      failure(error);
      return 1;
    }
  }
  throw new Error("Unhandled CLI command");
}
