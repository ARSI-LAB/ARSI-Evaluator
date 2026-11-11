import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { join, posix } from "node:path";
import type { EnvironmentSession, RuntimeRequirement } from "../../core/contracts/environment.js";
import type { ServiceBinding } from "../../core/contracts/plugin.js";
import type { SolveResult } from "../../core/contracts/result.js";
import type { AttemptContext, Solver, SolverProvenance } from "../../core/contracts/solver.js";
import type { PublicTask } from "../../core/contracts/task.js";
import { EvaluatorError } from "../../core/errors/evaluator-error.js";
import { expectRecord, rejectUnknown } from "../../core/validation/input.js";
import { consumeClaudeCode } from "../../runtimes/claudecode/protocol.js";
import { CLAUDE_CODE_ENTRY, CLAUDE_CODE_VERSION, claudeCodeRuntimeInstallation } from "../../runtimes/claudecode/runtime.js";

export function parseClaudeCodeConfig(value: unknown): Record<string, never> {
  rejectUnknown(expectRecord(value, "claudecode config"), [], "claudecode config");
  return {};
}

function messagesEndpoint(endpoint: string | null): string {
  const url = endpoint === null ? null : URL.parse(endpoint);
  if (!url || !["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new TypeError("claudecode requires an HTTP(S) base_url without credentials, query or fragment");
  }
  const base = url.href.replace(/\/+$/u, "");
  if (base.endsWith("/v1/messages")) throw new TypeError("claudecode base_url must omit /v1/messages");
  return base;
}

export class ClaudeCodeSolver implements Solver {
  private readonly endpoint: string;

  constructor(private readonly binding: ServiceBinding) {
    const { model } = binding;
    if (model.api !== "anthropic-messages") throw new TypeError("claudecode requires api: anthropic-messages on its selected service");
    this.endpoint = messagesEndpoint(model.endpoint);
    if (model.retry !== undefined) throw new TypeError("claudecode does not support services.*.retry");
    if (model.contextWindow !== undefined && (model.contextWindow < 100_000 || model.contextWindow > 1_000_000)) {
      throw new TypeError("claudecode contextWindow must be between 100000 and 1000000 tokens");
    }
  }

  requirements(): RuntimeRequirement[] {
    return [{ name: "node", version: "24.x", platform: "any" }, { name: "shell", version: "any", platform: "any" }];
  }

  runtimeInstallation = claudeCodeRuntimeInstallation;

  async provenance(signal: AbortSignal): Promise<SolverProvenance> {
    signal.throwIfAborted();
    return { claudeCodeVersion: CLAUDE_CODE_VERSION };
  }

  async solve(input: PublicTask, session: EnvironmentSession, context: AttemptContext): Promise<SolveResult> {
    const { signal } = context;
    signal.throwIfAborted();
    const { model, auth } = this.binding;
    if (!auth.value.trim() || /[\r\n\0]/u.test(auth.value)) {
      throw new EvaluatorError("MODEL_AUTH_FAILED", "claudecode requires a non-empty, single-line API key on its selected service");
    }
    if (input.attachments?.length || input.skillsDirectories?.length || input.mcpServers?.length) {
      throw new EvaluatorError("BENCHMARK_UNSUPPORTED", "claudecode supports text tasks without task skills or MCP servers");
    }
    const runtime = session.runtime;
    if (runtime?.stateRoot === undefined) {
      throw new EvaluatorError("ENV_RUNTIME_INSTALL_FAILED", "claudecode requires an environment-prepared runtime with writable state");
    }
    const mapping = session.modelEndpoint;
    const baseUrl = mapping?.originEndpoint === model.endpoint ? messagesEndpoint(mapping.baseUrl) : this.endpoint;
    const local = runtime.persistent;
    const path = local ? join : posix.join;
    const home = path(runtime.stateRoot, `attempt-${randomUUID()}`);
    const tools = "Read,Edit,Write,Bash";
    const gitBash = local && process.platform === "win32" ? process.env.CLAUDE_CODE_GIT_BASH_PATH : undefined;
    try {
      const handle = await session.start({
        executable: local ? process.execPath : "node",
        args: [path(runtime.root, "launch.mjs"), home, path(runtime.root, CLAUDE_CODE_ENTRY),
          "--bare", "--restricted", "--print", "--verbose", "--output-format", "stream-json", "--no-session-persistence",
          "--permission-mode", "dontAsk", "--tools", tools, "--allowedTools", tools,
          "--strict-mcp-config", "--disallowedTools", "mcp__*", "--model", model.name],
        cwd: session.workdir,
        env: gitBash === undefined ? {} : { CLAUDE_CODE_GIT_BASH_PATH: gitBash },
        inheritEnv: false,
        input: Buffer.from(JSON.stringify({ apiKey: auth.value, prompt: input.prompt, baseUrl, model: model.name,
          maxTokens: model.maxTokens, contextWindow: model.contextWindow }), "utf8"),
      }, signal);
      return await consumeClaudeCode(handle, context, auth.value);
    } finally {
      if (local) await rm(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {
        context.warning?.({ code: "CLEANUP_FAILED", message: "Could not remove the temporary Claude Code state directory" });
      });
    }
  }
}
