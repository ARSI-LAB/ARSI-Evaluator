import { spawn } from "node:child_process";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, posix } from "node:path";
import { randomUUID } from "node:crypto";
import { expectNonEmptyString, expectRecord, rejectUnknown } from "../../core/validation/input.js";
import type { AttemptContext, PreparedSolver, Solver } from "../../core/contracts/solver.js";
import type { Selection, SolverSelection } from "../../core/contracts/config.js";
import type { PluginFactoryContext } from "../../core/contracts/plugin.js";
import type { PublicTask } from "../../core/contracts/task.js";
import { agentXEndpoint } from "./agentx-replay.js";
import { helperPath, parseMsprofConfig, parseMsprofOutput, resolveMsprofSettings, settleHelperResult, startMsprofCollection,
  type MsprofCollection, type MsprofConfig, type MsprofResult } from "../benchmarks/inference-engine/agentx/evidence/msprof-telemetry.js";

export type MsprofRemoteTarget =
  | { mode: "local" }
  | { mode: "ssh"; host: string; user: string; port: number; identityFile?: string }
  | { mode: "container"; host: string; user: string; port: number; identityFile?: string; container: string };

export type TelemetryMsprofConfig = {
  inner: Selection;
  target: MsprofRemoteTarget;
  periodSeconds: number;
  msprof: MsprofConfig;
};

type SshTarget = Extract<MsprofRemoteTarget, { mode: "ssh" | "container" }>;

function selection(value: unknown, name: string): Selection {
  const raw = expectRecord(value, name);
  rejectUnknown(raw, ["name", "config"], name);
  return {
    name: expectNonEmptyString(raw.name, `${name}.name`),
    config: expectRecord(raw.config ?? {}, `${name}.config`),
  };
}

function target(value: unknown): MsprofRemoteTarget {
  const raw = expectRecord(value, "telemetry-msprof.target");
  const mode = expectNonEmptyString(raw.mode, "telemetry-msprof.target.mode");
  if (mode === "local") {
    rejectUnknown(raw, ["mode"], "telemetry-msprof.target");
    return { mode: "local" };
  }
  if (mode !== "ssh" && mode !== "container") throw new TypeError("telemetry-msprof.target.mode must be local, ssh, or container");
  const keys = mode === "ssh"
    ? ["mode", "host", "user", "port", "identityFile"]
    : ["mode", "host", "user", "port", "identityFile", "container"];
  rejectUnknown(raw, keys, "telemetry-msprof.target");
  const host = expectNonEmptyString(raw.host, "telemetry-msprof.target.host");
  const user = expectNonEmptyString(raw.user, "telemetry-msprof.target.user");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/u.test(host) || !/^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/u.test(user)) {
    throw new TypeError("Invalid telemetry-msprof target host or user");
  }
  const port = raw.port === undefined ? 22 : (() => {
    if (typeof raw.port !== "number" || !Number.isSafeInteger(raw.port) || raw.port <= 0 || raw.port > 65535) {
      throw new TypeError("telemetry-msprof.target.port must be 1..65535");
    }
    return raw.port;
  })();
  const identityFile = raw.identityFile === undefined ? undefined : expectNonEmptyString(raw.identityFile, "telemetry-msprof.target.identityFile");
  if (mode === "ssh") return { mode: "ssh", host, user, port, ...(identityFile === undefined ? {} : { identityFile }) };
  return { mode: "container", host, user, port, ...(identityFile === undefined ? {} : { identityFile }), container: expectNonEmptyString(raw.container, "telemetry-msprof.target.container") };
}

export function parseTelemetryMsprofConfig(value: unknown): TelemetryMsprofConfig {
  const raw = expectRecord(value, "telemetry-msprof");
  rejectUnknown(raw, ["inner", "target", "periodSeconds", "msprof"], "telemetry-msprof");
  const inner = selection(raw.inner, "telemetry-msprof.inner");
  if (inner.name === "telemetry-msprof") throw new TypeError("telemetry-msprof.inner must not nest telemetry-msprof");
  if (inner.name === "agentx-replay" && (inner.config.telemetry as { msprof?: unknown } | undefined)?.msprof !== undefined) {
    throw new TypeError("AgentX telemetry.msprof conflicts with telemetry-msprof; use one collection path");
  }
  const periodSeconds = raw.periodSeconds === undefined ? 60 : (() => {
    if (typeof raw.periodSeconds !== "number" || !Number.isSafeInteger(raw.periodSeconds) || raw.periodSeconds <= 0) {
      throw new TypeError("telemetry-msprof.periodSeconds must be a positive integer");
    }
    return raw.periodSeconds;
  })();
  return {
    inner,
    target: target(raw.target),
    periodSeconds,
    msprof: parseMsprofConfig(raw.msprof),
  };
}

function shellQuote(value: string): string { return `'${value.replaceAll("'", "'\"'\"'")}'`; }

function sshArguments(target: SshTarget): string[] {
  return ["-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=15",
    "-o", "ServerAliveInterval=10", "-o", "ServerAliveCountMax=2", "-p", String(target.port),
    ...(target.identityFile === undefined ? [] : ["-i", target.identityFile]), `${target.user}@${target.host}`];
}

function scpArguments(target: SshTarget): string[] {
  return ["-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=15",
    "-P", String(target.port), ...(target.identityFile === undefined ? [] : ["-i", target.identityFile])];
}

type ProcessResult = { code: number | null; stdout: string; stderr: string };

async function runProcess(executable: string, args: string[], signal: AbortSignal,
  options: { input?: string; timeoutMs?: number } = {}): Promise<ProcessResult> {
  const active = options.timeoutMs === undefined ? signal : AbortSignal.any([signal, AbortSignal.timeout(options.timeoutMs)]);
  return await new Promise((resolve, reject) => {
    const child = spawn(executable, args, { signal: active, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "", exceeded = false;
    const append = (stream: "stdout" | "stderr") => (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      if (stdout.length + stderr.length + text.length > 1024 * 1024) { exceeded = true; child.kill("SIGTERM"); return; }
      if (stream === "stdout") stdout += text; else stderr += text;
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", append("stdout"));
    child.stderr.on("data", append("stderr"));
    child.on("error", error => reject(new Error(`Unable to start ${executable}`, { cause: error })));
    child.on("close", code => {
      if (exceeded) { reject(new Error(`${executable} output exceeded its protocol limit`)); return; }
      resolve({ code, stdout, stderr });
    });
    if (options.input === undefined) child.stdin.end();
    else child.stdin.end(options.input, "utf8");
  });
}

async function runRemote(target: SshTarget, command: string, signal: AbortSignal,
  timeoutMs = 60_000): Promise<ProcessResult> {
  return await runProcess("ssh", [...sshArguments(target), command], signal, { timeoutMs });
}

function insideTarget(target: MsprofRemoteTarget, command: string): string {
  return target.mode === "container"
    ? `docker exec ${shellQuote(target.container)} sh -lc ${shellQuote(command)}`
    : command;
}

function makeFailedCollection(error: unknown, requestedDevices: number[] | "all"): MsprofCollection {
  const result = Promise.resolve({ status: "error" as const, code: "preflight_failed",
    detail: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500) });
  return { requestedDevices, result, async stop() { await result; } };
}

async function preflightRemote(target: SshTarget, signal: AbortSignal): Promise<void> {
  const checks = [
    "command -v msprof",
    "npu-smi info -m",
    "pgrep -f '[m]sprof.*--sys-period'",
  ];
  for (const check of checks) {
    const result = await runRemote(target, insideTarget(target, check), signal, 30_000);
    if (check.startsWith("pgrep") && result.code === 1) continue;
    if (result.code !== 0) {
      throw new Error(`msprof preflight failed: ${check}; ${result.stderr.trim().slice(-400) || `exit ${result.code}`}`);
    }
  }
}

async function fetchRemoteArtifacts(target: SshTarget, remoteArtifacts: string, localRoot: string,
  signal: AbortSignal): Promise<void> {
  let hostArtifacts = remoteArtifacts;
  if (target.mode === "container") {
    hostArtifacts = `${remoteArtifacts}_fetched`;
    const copy = `docker cp ${shellQuote(`${target.container}:${remoteArtifacts}`)} ${shellQuote(hostArtifacts)}`;
    const result = await runRemote(target, copy, signal, 120_000);
    if (result.code !== 0) throw new Error(`Unable to copy msprof artifacts from container: ${result.stderr.trim().slice(-400)}`);
  }
  const result = await runProcess("scp", [...scpArguments(target), "-r", `${target.user}@${target.host}:${hostArtifacts}`, localRoot], signal, { timeoutMs: 120_000 });
  if (result.code !== 0) throw new Error(`Unable to fetch msprof artifacts: ${result.stderr.trim().slice(-400)}`);
}

async function startRemoteCollection(config: TelemetryMsprofConfig, context: AttemptContext): Promise<MsprofCollection> {
  const target = config.target;
  if (target.mode === "local") {
    return startMsprofCollection(resolveMsprofSettings(config.msprof, config.msprof.metricsUrl), context.paths.agent,
      config.periodSeconds, context.signal, "python3");
  }

  const requestedDevices: number[] | "all" = config.msprof.devices === "all" ? "all" : config.msprof.devices.map(device => device.deviceId);
  const innerTelemetry = config.inner.config.telemetry as { vllm?: { endpoint?: string } } | undefined;
  const stamp = new Date().toISOString().replaceAll(/[^0-9]/gu, "").slice(0, 14);
  const remoteArtifacts = posix.join("/tmp", `msprof_${context.key.runId}_${context.key.taskId}_${context.key.attemptId}_${stamp}_${randomUUID().slice(0, 8)}`.replaceAll(/[^a-zA-Z0-9_/.-]/gu, "_"));
  const localRoot = join(context.paths.agent, "msprof-remote");
  let settled = false, child: ReturnType<typeof spawn> | undefined;
  let resolveResult!: (value: MsprofResult) => void;
  const result = new Promise<MsprofResult>(resolve => { resolveResult = resolve; });
  const settle = (value: MsprofResult) => { if (!settled) { settled = true; resolveResult(value); } };

  try {
    await preflightRemote(target, context.signal);
    await runRemote(target, `rm -rf ${shellQuote(remoteArtifacts)} && mkdir -p ${shellQuote(remoteArtifacts)}`, context.signal);
    await runProcess("scp", [...scpArguments(target), helperPath(), `${target.user}@${target.host}:${remoteArtifacts}/msprof_service.py`], context.signal, { timeoutMs: 120_000 });
    if (target.mode === "container") {
      await runRemote(target, `docker exec ${shellQuote(target.container)} mkdir -p ${shellQuote(remoteArtifacts)}`, context.signal);
      const copy = `docker cp ${shellQuote(`${remoteArtifacts}/msprof_service.py`)} ${shellQuote(`${target.container}:${remoteArtifacts}/msprof_service.py`)}`;
      const copied = await runRemote(target, copy, context.signal);
      if (copied.code !== 0) throw new Error(`Unable to copy msprof helper into container: ${copied.stderr.trim().slice(-400)}`);
    }

    const settings = resolveMsprofSettings(config.msprof, innerTelemetry?.vllm?.endpoint);
    const helperConfig = {
      devices: requestedDevices === "all" ? ["all"] : requestedDevices,
      freqHz: config.msprof.freqHz,
      metrics: config.msprof.metrics,
      includeHbm: config.msprof.includeHbm,
      periodSec: config.periodSeconds,
      ...(settings.metricsUrl === undefined ? {} : { metricsUrl: settings.metricsUrl }),
      ...(settings.waitForTraffic === undefined ? {} : { waitForTraffic: settings.waitForTraffic }),
    };
    const helperCommand = insideTarget(target, `python3 -B -u ${posix.join(remoteArtifacts, "msprof_service.py")} --config ${shellQuote(JSON.stringify(helperConfig))} --artifacts ${shellQuote(remoteArtifacts)}`);
    child = spawn("ssh", [...sshArguments(target), helperCommand], { signal: context.signal, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", exceeded = false;
    const stdoutStream = child.stdout, stderrStream = child.stderr;
    if (!stdoutStream || !stderrStream) throw new Error("msprof helper did not provide stdout/stderr");
    stdoutStream.setEncoding("utf8");
    stderrStream.setEncoding("utf8");
    stdoutStream.on("data", (chunk: string) => { if (stdout.length + stderr.length + chunk.length > 1024 * 1024) { exceeded = true; child?.kill("SIGTERM"); } else stdout += chunk; });
    stderrStream.on("data", (chunk: string) => { if (stdout.length + stderr.length + chunk.length > 1024 * 1024) { exceeded = true; child?.kill("SIGTERM"); } else stderr += chunk; });
    child.on("error", error => settle({ status: "error", code: error.message.slice(0, 120) }));
    child.on("close", async code => {
      try {
        if (exceeded) throw new Error("msprof helper output exceeded its protocol limit");
        await fetchRemoteArtifacts(target, remoteArtifacts, localRoot, context.signal);
        settle(settleHelperResult(code, stdout, stderr));
      } catch (error) {
        settle({ status: "error", code: "artifact_fetch_failed",
          detail: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500) });
      }
    });
  } catch (error) {
    child?.kill("SIGTERM");
    return makeFailedCollection(error, requestedDevices);
  }

  return {
    requestedDevices,
    result,
    async stop() {
      if (settled) { await result; return; }
      try {
        await runRemote(target, insideTarget(target, `touch ${posix.join(remoteArtifacts, "msprof", "STOP")}`), context.signal, 15_000);
      } catch { /* The helper timeout or kill path below still produces diagnostics. */ }
      const graceful = setTimeout(() => { if (!settled) child?.kill("SIGTERM"); }, 30_000);
      const force = setTimeout(() => { if (!settled) child?.kill("SIGKILL"); }, 45_000);
      graceful.unref?.();
      force.unref?.();
      try { await result; } finally { clearTimeout(graceful); clearTimeout(force); }
    },
  };
}

async function copyEvidence(context: AttemptContext): Promise<void> {
  const destination = join(context.paths.artifacts, "profiling");
  await mkdir(destination, { recursive: true });
  for (const name of ["summary.json", "window.json", "SHA256SUMS"] as const) {
    await copyFile(join(context.paths.agent, "msprof", name), join(destination, name)).catch(() => undefined);
  }
  await writeFile(join(destination, "msprof-telemetry.json"),
    await readFile(join(context.paths.agent, "msprof-telemetry.json"), "utf8"), "utf8").catch(() => undefined);
}

export class TelemetryMsprofSolver {
  constructor(private readonly config: TelemetryMsprofConfig, private readonly inner: Solver) {}

  requirements() { return this.inner.requirements(); }
  async provenance(signal: AbortSignal, previous?: Record<string, string>) {
    const inner = await this.inner.provenance?.(signal, previous) ?? {};
    return { ...inner, telemetryMsprof: "wrapper-v1" };
  }
  get runtimeInstallation() {
    return this.inner.runtimeInstallation?.bind(this.inner);
  }

  private async withTelemetry(input: PublicTask, context: AttemptContext,
    solve: () => Promise<import("../../core/contracts/result.js").SolveResult>): Promise<import("../../core/contracts/result.js").SolveResult> {
    let collection: MsprofCollection;
    try { collection = await startRemoteCollection(this.config, context); }
    catch (error) { collection = makeFailedCollection(error, this.config.msprof.devices === "all" ? "all" : this.config.msprof.devices.map(device => device.deviceId)); }
    let result: import("../../core/contracts/result.js").SolveResult;
    try { result = await solve(); }
    finally {
      await collection.stop().catch(() => undefined);
      const msprof = await collection.result.catch(error => ({ status: "error" as const, code: "collection_unresolved", detail: String(error).slice(0, 500) }));
      await mkdir(context.paths.agent, { recursive: true });
      await writeFile(join(context.paths.agent, "msprof-telemetry.json"), JSON.stringify(msprof, null, 2) + "\n", "utf8");
      await writeFile(join(context.paths.agent, "profiling-diagnostic.json"), JSON.stringify({
        schemaVersion: 1, kind: "profiling-diagnostic", purpose: "diagnostic", msprof, msprofAttempt: {
          requestedDevices: (msprof.status === "completed" ? msprof.summary?.requestedDevices : undefined) ?? collection.requestedDevices, status: msprof.status,
          ...(msprof.status === "error" && msprof.code ? { code: msprof.code } : {}),
        },
      }, null, 2) + "\n", "utf8");
      await copyEvidence(context).catch(() => undefined);
    }
    return result;
  }

  async prepare(session: import("../../core/contracts/environment.js").EnvironmentSession, context: AttemptContext): Promise<PreparedSolver> {
    const prepared = await this.inner.prepare?.(session, context);
    if (prepared) {
      return {
        ...(prepared.inputModalities === undefined ? {} : { inputModalities: prepared.inputModalities }),
        solve: (input, active) => this.withTelemetry(input, active, () => prepared.solve(input, active)),
      };
    }
    return { solve: (input, active) => this.withTelemetry(input, active, () => this.inner.solve(input, session, active)) };
  }

  async solve(input: PublicTask, session: import("../../core/contracts/environment.js").EnvironmentSession, context: AttemptContext) {
    return await this.withTelemetry(input, context, () => this.inner.solve(input, session, context));
  }
}

export function registerTelemetryMsprof(ctx: import("@deepseek-ai/cordis").Context): void {
  ctx.evaluator.register("solver", "telemetry-msprof", parseTelemetryMsprofConfig, async (config, runtime: PluginFactoryContext) => {
    if (!runtime.prepareSolver) throw new TypeError("telemetry-msprof requires solver composition support");
    const inner = await runtime.prepareSolver(config.inner);
    return new TelemetryMsprofSolver(config, inner) as import("../../core/contracts/solver.js").Solver;
  });
}

export type { SolverSelection };
