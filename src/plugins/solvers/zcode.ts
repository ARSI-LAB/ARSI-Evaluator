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
import { consumeZCode } from "../../runtimes/zcode/protocol.js";
import { readZCodeSourceLock, ZCODE_ENTRY, zcodeRuntimeInstallation } from "../../runtimes/zcode/runtime.js";

export function parseZCodeConfig(value: unknown): Record<string, never> {
  rejectUnknown(expectRecord(value, "zcode config"), [], "zcode config");
  return {};
}

function apiBase(endpoint: string | null): string {
  const url = endpoint === null ? null : URL.parse(endpoint);
  if (!url || !["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash ||
      /\/(?:chat\/completions|responses|messages(?:\/count_tokens)?)\/*$/u.test(url.pathname)) {
    throw new TypeError("zcode requires an HTTP(S) base_url without credentials, query, fragment or API method path");
  }
  return url.href.replace(/\/+$/u, "");
}

export class ZCodeSolver implements Solver {
  private readonly endpoint: string;

  constructor(private readonly binding: ServiceBinding) {
    const { model } = binding;
    if (model.api === null || !["openai-completions", "openai-responses", "anthropic-messages"].includes(model.api)) {
      throw new TypeError("zcode requires api: openai-completions, openai-responses or anthropic-messages");
    }
    if (model.maxTokens !== undefined || model.contextWindow !== undefined || model.retry !== undefined) {
      throw new TypeError("zcode does not support services.*.maxTokens, services.*.contextWindow or services.*.retry");
    }
    this.endpoint = apiBase(model.endpoint);
  }

  requirements(): RuntimeRequirement[] {
    return [{ name: "node", version: "24.x", platform: "any" }, { name: "shell", version: "any", platform: "any" }];
  }

  runtimeInstallation = zcodeRuntimeInstallation;

  async provenance(signal: AbortSignal): Promise<SolverProvenance> {
    const { cliVersion, commit } = await readZCodeSourceLock(signal);
    return { zcodeVersion: cliVersion, zcodeCommit: commit };
  }

  async solve(input: PublicTask, session: EnvironmentSession, context: AttemptContext): Promise<SolveResult> {
    const { signal } = context;
    signal.throwIfAborted();
    const { model, auth } = this.binding;
    if (!auth.value.trim() || /[\r\n\0]/u.test(auth.value)) {
      throw new EvaluatorError("MODEL_AUTH_FAILED", "zcode requires a non-empty, single-line API key on its selected service");
    }
    if (input.attachments?.length || input.skillsDirectories?.length || input.mcpServers?.length) {
      throw new EvaluatorError("BENCHMARK_UNSUPPORTED", "zcode supports text tasks without task skills or MCP servers");
    }
    const runtime = session.runtime;
    if (runtime?.stateRoot === undefined) {
      throw new EvaluatorError("ENV_RUNTIME_INSTALL_FAILED", "zcode requires an environment-prepared runtime with writable state");
    }
    const mapping = session.modelEndpoint;
    const baseUrl = mapping?.originEndpoint === model.endpoint ? apiBase(mapping.baseUrl) : this.endpoint;
    const local = runtime.persistent;
    const path = local ? join : posix.join;
    const home = path(runtime.stateRoot, `attempt-${randomUUID()}`);
    const token = randomUUID();
    try {
      const handle = await session.start({
        executable: local ? process.execPath : "node",
        args: [path(runtime.root, "launch.mjs"), home, path(runtime.root, ZCODE_ENTRY)],
        cwd: session.workdir,
        env: { NODE_USE_ENV_PROXY: "1" },
        inheritEnv: false,
        input: Buffer.from(JSON.stringify({ apiKey: auth.value, api: model.api, baseUrl, model: model.name, prompt: input.prompt, token }), "utf8"),
      }, signal);
      return await consumeZCode(handle, context, [auth.value, token]);
    } finally {
      if (local) await rm(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {
        context.warning?.({ code: "CLEANUP_FAILED", message: "Could not remove the temporary ZCode state directory" });
      });
    }
  }
}
