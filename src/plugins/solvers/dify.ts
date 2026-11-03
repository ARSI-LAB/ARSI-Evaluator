import { fetchNetworkResponse } from "../../adapters/network/retry.js";
import type { ErrorCode } from "../../core/errors/registry.js";
import { classifyError } from "../../core/errors/classify.js";
import { EvaluatorError } from "../../core/errors/evaluator-error.js";
import type { ErrorDetails } from "../../core/contracts/errors.js";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createBundleSdk } from "agent-bundle-core";

import type { RuntimeAuth } from "../../config/schema.js";
import { expectNonEmptyString, expectRecord, rejectUnknown } from "../../config/schema.js";
import { verifyBundleCandidate } from "../../adapters/agentbundle/sdk.js";
import { difyRuntimeInstallation } from "../../adapters/harness/dify/runtime.js";
import { parseRunnerOutput, type RunnerOutput } from "../../adapters/harness/pi/protocol.js";
import type {
  EnvironmentSession,
  ProcessHandle,
  RuntimeInstallation,
  RuntimeRequirement,
} from "../../core/contracts/environment.js";
import type { SolveResult, Usage } from "../../core/contracts/result.js";
import type { AttemptContext, PreparedSolver, Solver, SolverProvenance } from "../../core/contracts/solver.js";
import type { PublicTask } from "../../core/contracts/task.js";
import type { ActivityListener } from "../../core/contracts/activity.js";
import { StringDecoder } from "node:string_decoder";
import { safeLiveText } from "../../core/live-progress.js";

export type DifySolverConfig = {
  baseUrl: string;
  apiKeyEnv: string;
  appId?: string;
  /** When set, the solver verifies and installs the bundle into Dify (SDK) before solving. */
  bundlePath?: string;
  registryPath?: string;
};

export function parseDifyConfig(value: unknown): DifySolverConfig {
  const config = expectRecord(value, "dify");
  rejectUnknown(config, ["baseUrl", "apiKeyEnv", "appId", "bundlePath", "registryPath"], "dify");
  const result: DifySolverConfig = {
    baseUrl: expectNonEmptyString(config.baseUrl, "dify.baseUrl").replace(/\/+$/, ""),
    apiKeyEnv: expectNonEmptyString(config.apiKeyEnv, "dify.apiKeyEnv"),
  };
  if (config.appId !== undefined) result.appId = expectNonEmptyString(config.appId, "dify.appId");
  if (config.bundlePath !== undefined) result.bundlePath = expectNonEmptyString(config.bundlePath, "dify.bundlePath");
  if (config.registryPath !== undefined) result.registryPath = expectNonEmptyString(config.registryPath, "dify.registryPath");
  return result;
}

/**
 * The Service API key lives in an environment variable for a pre-bound app.
 * Bundle mode derives the key from the SDK install result instead.
 */
export function resolveDifyAuth(config: DifySolverConfig): RuntimeAuth {
  if (config.bundlePath !== undefined) return { value: "", reference: null };
  const value = process.env[config.apiKeyEnv];
  if (value === undefined || value === "") {
    throw new TypeError(`dify solver requires environment variable ${config.apiKeyEnv} to hold the Dify Service API key`);
  }
  return { value, reference: config.apiKeyEnv };
}

export class DifySolverError extends EvaluatorError {
  constructor(code: ErrorCode, message: string, options?: ErrorOptions, details: ErrorDetails = {}) {
    super(code, `${code}: ${message}`, details, options);
    this.name = "DifySolverError";
  }
}

function redact(text: string, auth: RuntimeAuth): string {
  return auth.value === "" ? text : text.replaceAll(auth.value, "[redacted]");
}

/** Install seam so tests can stub the SDK; the default wires agent-bundle-core. */
export type DifyBundleInstaller = {
  verify(bundleDir: string, expectDigest?: string): Promise<{ digest: string; harnessName: string; versionRange: string }>;
  install(bundleDir: string): Promise<{ digest: string; installationId: string; appId?: string; apiKey?: string; reused: boolean }>;
};

function sdkInstaller(registryPath?: string): DifyBundleInstaller {
  const sdk = createBundleSdk(registryPath === undefined ? {} : { registryPath });
  return {
    async verify(bundleDir, expectDigest) {
      const result = await verifyBundleCandidate(bundleDir, expectDigest);
      return { digest: result.digest, harnessName: result.harness.name, versionRange: result.harness.versionRange };
    },
    async install(bundleDir) {
      const result = await sdk.install(bundleDir, { mode: "persistent" });
      return {
        digest: result.digest,
        installationId: result.installationId,
        ...(result.appId === undefined ? {} : { appId: result.appId }),
        ...(result.apiKey === undefined ? {} : { apiKey: result.apiKey }),
        reused: result.reused,
      };
    },
  };
}

type InstalledBundle = {
  digest: string;
  installationId: string;
  appId?: string;
  apiKey?: string;
  reused: boolean;
};

async function collect(stream: AsyncIterable<Uint8Array>): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

/** Read the runner stdout stream and keep the single terminal protocol message. */
async function protocol(handle: ProcessHandle, activity?: ActivityListener): Promise<{ output: RunnerOutput | null; stderr: string; exit: { code: number | null; signal: string | null } }> {
  let parsed: RunnerOutput | null = null;
  const consumeLine = (line: string) => {
    if (line === "") return;
    if (parsed !== null) throw new DifySolverError("SOLVER_PROTOCOL_INVALID", "runner emitted more than one terminal message");
    try {
      const message = parseRunnerOutput(JSON.parse(line));
      if (message.type === "activity") activity?.(message.activity);
      else parsed = message;
    } catch (error) {
      throw new DifySolverError("SOLVER_PROTOCOL_INVALID", error instanceof Error ? error.message : String(error), { cause: error });
    }
  };
  const stdout = (async () => {
    let buffered = "";
    const decoder = new StringDecoder("utf8");
    for await (const chunk of handle.stdout) {
      buffered += decoder.write(Buffer.from(chunk));
      if (buffered.length > 16 * 1024 * 1024) throw new DifySolverError("SOLVER_PROTOCOL_INVALID", "runner output exceeds protocol limit");
      while (true) {
        const newline = buffered.indexOf("\n");
        if (newline < 0) break;
        const line = buffered.slice(0, newline).trim();
        buffered = buffered.slice(newline + 1);
        consumeLine(line);
      }
    }
    buffered += decoder.end();
    if (buffered.trim() !== "") throw new DifySolverError("SOLVER_PROTOCOL_INVALID", "runner stdout ended with an incomplete protocol line");
  })();
  const stderr = collect(handle.stderr);
  try {
    const [exit, diagnostic] = await Promise.all([handle.done, stderr, stdout]);
    return { output: parsed, stderr: diagnostic, exit };
  } catch (error) {
    await handle.stop(100).catch(() => {});
    if (typeof error === "object" && error !== null) {
      Object.defineProperty(error, "runnerStderr", { value: await stderr.catch(() => ""), configurable: true });
    }
    throw error;
  }
}

function isLocal(session: EnvironmentSession): boolean {
  return asRecord(session.metadata)?.kind === "local";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export class DifySolver implements Solver {
  private installed: InstalledBundle | undefined;
  private candidateDigest: string | undefined;

  private readonly installer: DifyBundleInstaller;

  constructor(
    private readonly config: DifySolverConfig,
    private readonly auth: RuntimeAuth,
    installer?: DifyBundleInstaller,
  ) {
    this.installer = installer ?? sdkInstaller(config.registryPath);
  }

  requirements(): RuntimeRequirement[] {
    return [{ name: "node", version: "24.x", platform: "any" }];
  }

  runtimeInstallation(signal: AbortSignal): Promise<RuntimeInstallation> {
    return difyRuntimeInstallation(signal);
  }

  async provenance(signal: AbortSignal): Promise<SolverProvenance> {
    const provenance: SolverProvenance = { solver: "dify" };
    if (this.config.bundlePath !== undefined) {
      const candidate = await this.verifyCandidate(signal);
      provenance["bundleDigest"] = candidate.digest;
      return provenance;
    }
    if (this.config.appId !== undefined) {
      provenance["appId"] = this.config.appId;
    }
    const info = asRecord(await this.requestJson("GET", "/v1/info", this.auth, signal));
    if (info === null) throw new DifySolverError("SOLVER_PROTOCOL_INVALID", "GET /v1/info did not return an object");
    if (this.config.appId === undefined && typeof info["id"] === "string" && info["id"] !== "") {
      provenance["appId"] = info["id"];
    }
    for (const [key, field] of [["appName", "name"], ["appMode", "mode"]] as const) {
      const value = info[field];
      if (typeof value === "string" && value !== "") provenance[key] = value;
    }
    return provenance;
  }

  private async verifyCandidate(signal: AbortSignal): Promise<{ digest: string; versionRange: string }> {
    signal.throwIfAborted();
    const bundlePath = this.config.bundlePath;
    if (bundlePath === undefined) throw new DifySolverError("SOLVER_PROTOCOL_INVALID", "bundle mode requires bundlePath");
    const candidate = await this.installer.verify(bundlePath).catch((error: unknown) => {
      throw new DifySolverError(
        "ENV_RUNTIME_INSTALL_FAILED",
        `verify ${bundlePath}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    });
    if (candidate.harnessName !== "dify") {
      throw new DifySolverError("ENV_RUNTIME_INSTALL_FAILED", `unsupported harness: ${candidate.harnessName}`);
    }
    if (this.candidateDigest !== undefined && this.candidateDigest !== candidate.digest) {
      throw new DifySolverError("SOURCE_CHANGED", "bundle digest changed after the run was locked");
    }
    this.candidateDigest = candidate.digest;
    return candidate;
  }

  private async ensureInstalled(signal: AbortSignal): Promise<InstalledBundle> {
    if (this.installed !== undefined) return this.installed;
    const bundlePath = this.config.bundlePath;
    if (bundlePath === undefined) throw new DifySolverError("SOLVER_PROTOCOL_INVALID", "bundle mode requires bundlePath");
    const candidate = await this.verifyCandidate(signal);
    const installed = await this.installer.install(bundlePath).catch((error: unknown) => {
      throw new DifySolverError(
        "ENV_RUNTIME_INSTALL_FAILED",
        `install ${bundlePath}: ${redact(error instanceof Error ? error.message : String(error), this.auth)}`,
        { cause: error },
      );
    });
    if (installed.digest !== candidate.digest) {
      throw new DifySolverError("SOURCE_CHANGED", "installed bundle digest differs from the verified candidate");
    }
    if (installed.apiKey === undefined || installed.apiKey === "") {
      throw new DifySolverError("MODEL_AUTH_FAILED", `installation ${installed.installationId} carries no Service API key`);
    }
    this.installed = installed;
    return installed;
  }

  private effectiveAuth(): RuntimeAuth {
    if (this.config.bundlePath === undefined) return this.auth;
    const key = this.installed?.apiKey ?? "";
    return { value: key, reference: this.config.apiKeyEnv };
  }

  async prepare(session: EnvironmentSession, context: AttemptContext): Promise<PreparedSolver> {
    if (this.config.bundlePath !== undefined) await this.ensureInstalled(context.signal);
    return {
      solve: (input, solveContext) => this.solve(input, session, solveContext),
    };
  }

  async solve(input: PublicTask, session: EnvironmentSession, context: AttemptContext): Promise<SolveResult> {
    const runtime = session.runtime;
    if (!runtime || typeof runtime.root !== "string" || runtime.root === "" || typeof runtime.identity !== "string" || runtime.identity === "") {
      throw new DifySolverError("ENV_RUNTIME_INSTALL_FAILED", "dify solver requires an environment-prepared runtime");
    }
    if (this.config.bundlePath !== undefined) await this.ensureInstalled(context.signal);
    const auth = this.effectiveAuth();
    if (auth.value === "") throw new DifySolverError("MODEL_AUTH_FAILED", "no Service API key available for solving");

    const runnerInput = JSON.stringify({
      schemaVersion: 1,
      baseUrl: this.config.baseUrl,
      apiKey: auth.value,
      task: input.prompt,
      appId: this.installed?.appId ?? this.config.appId ?? null,
      attempt: { runId: context.key.runId, taskId: context.key.taskId, attemptId: context.key.attemptId },
      outputDir: session.agentOutputDir,
      ...(this.installed === undefined ? {} : {
        bundleDigest: this.installed.digest,
        installationId: this.installed.installationId,
        reused: this.installed.reused,
      }),
    });
    const handle = await session.start({
      executable: isLocal(session) ? process.execPath : "node",
      args: [join(runtime.root, "dify", "runner.mjs")],
      cwd: session.workdir,
      env: {},
      input: Buffer.from(`${runnerInput}\n`, "utf8"),
    }, context.signal);
    let outcome: Awaited<ReturnType<typeof protocol>>;
    try {
      outcome = await protocol(handle, item => context.activity?.({ ...item,
        ...(item.message === undefined ? {} : { message: safeLiveText(item.message, [auth.value]) }),
        ...(item.lines ? { lines: item.lines.map(line => safeLiveText(line, [auth.value])) } : {}) }));
    } catch (error) {
      const diagnostic = typeof error === "object" && error !== null && "runnerStderr" in error
        ? String(error.runnerStderr)
        : "";
      await this.writeStderrLog(context, diagnostic, auth);
      if (context.signal.aborted) throw new DOMException("The operation was aborted", "AbortError");
      throw error;
    }
    await this.writeStderrLog(context, outcome.stderr, auth);
    if (context.signal.aborted) throw new DOMException("The operation was aborted", "AbortError");
    if (outcome.output?.type === "error") {
      throw new DifySolverError(outcome.output.code, redact(outcome.output.message, auth), undefined, outcome.output.details);
    }
    if (outcome.exit.code !== 0 || outcome.exit.signal !== null) {
      throw new DifySolverError(
        "SOLVER_PROCESS_CRASHED",
        redact(outcome.stderr.trim() || `runner exited with code ${outcome.exit.code ?? "null"} signal ${outcome.exit.signal ?? "none"}`, auth),
      );
    }
    if (outcome.output?.type !== "result") {
      throw new DifySolverError("SOLVER_PROTOCOL_INVALID", "runner exited without a result message");
    }
    return outcome.output.result;
  }

  private async writeStderrLog(context: AttemptContext, stderr: string, auth: RuntimeAuth): Promise<void> {
    await writeFile(join(context.paths.agent, "runner-stderr.log"), redact(stderr, auth), { encoding: "utf8", mode: 0o600 });
  }

  private async requestJson(method: string, path: string, auth: RuntimeAuth, signal: AbortSignal): Promise<unknown> {
    const response = await this.request(method, path, auth, signal);
    try {
      return await response.json();
    } catch (error) {
      throw new DifySolverError("SOLVER_PROTOCOL_INVALID", `${method} ${path} returned invalid JSON`, { cause: error });
    }
  }

  private async request(method: string, path: string, auth: RuntimeAuth, signal: AbortSignal, body?: string): Promise<Response> {
    let response: Response;
    try {
      response = await fetchNetworkResponse(`${this.config.baseUrl}${path}`, {
        method,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${auth.value}` },
        ...(body === undefined ? {} : { body }),
        signal,
      }, { context: { phase: "solve", component: "model", secrets: [auth.value] } });
    } catch (error) {
      if (signal.aborted) throw new DOMException("The operation was aborted", "AbortError");
      throw new DifySolverError("MODEL_UNAVAILABLE", redact(`${method} ${path}: ${error instanceof Error ? error.message : String(error)}`, auth), { cause: error });
    }
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      const cause = Object.assign(new Error(redact(`${method} ${path} responded ${response.status}: ${text.slice(0, 300)}`, auth)), { status: response.status });
      throw new DifySolverError(classifyError(cause, { phase: "solve", component: "model" }).code, cause.message, { cause });
    }
    return response;
  }
}
