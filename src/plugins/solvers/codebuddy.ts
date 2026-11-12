import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { join, posix } from "node:path";
import type { EnvironmentSession, RuntimeRequirement } from "../../core/contracts/environment.js";
import type { ServiceBinding } from "../../core/contracts/plugin.js";
import type { SolveResult } from "../../core/contracts/result.js";
import type { AttemptContext, Solver, SolverProvenance } from "../../core/contracts/solver.js";
import type { PublicTask } from "../../core/contracts/task.js";
import { EvaluatorError } from "../../core/errors/evaluator-error.js";
import { parseSolverToolPolicy, toolPolicyProvenance, type SolverToolPolicy } from "../../core/validation/solver-tool-policy.js";
import { consumeCodeBuddy } from "../../runtimes/codebuddy/protocol.js";
import { CODEBUDDY_ENTRY, CODEBUDDY_VERSION, codeBuddyRuntimeInstallation } from "../../runtimes/codebuddy/runtime.js";
import { loadAttachments, requireInputModalities } from "../../runtimes/multimodal/input.js";

export function parseCodeBuddyConfig(value: unknown): SolverToolPolicy {
  return parseSolverToolPolicy(value, "codebuddy config");
}

function apiBase(endpoint: string | null): string {
  const url = endpoint === null ? null : URL.parse(endpoint);
  if (!url || !["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash ||
      /\/(?:chat\/completions|responses)\/*$/u.test(url.pathname)) {
    throw new TypeError("codebuddy requires an HTTP(S) base_url without credentials, query, fragment or API method path");
  }
  return url.href.replace(/\/+$/u, "");
}

export class CodeBuddySolver implements Solver {
  readonly inputModalities = ["text", "image"] as const;
  private readonly endpoint: string;

  constructor(private readonly binding: ServiceBinding, private readonly policy: SolverToolPolicy = {}) {
    const { model } = binding;
    if (model.api !== "openai-completions" && model.api !== "openai-responses") {
      throw new TypeError("codebuddy requires api: openai-completions or openai-responses on its selected service");
    }
    if (model.contextWindow !== undefined || model.retry !== undefined) {
      throw new TypeError("codebuddy does not support services.*.contextWindow or services.*.retry");
    }
    this.endpoint = apiBase(model.endpoint);
  }

  requirements(): RuntimeRequirement[] {
    return [{ name: "node", version: "24.x", platform: "any" }, { name: "shell", version: "any", platform: "any" }];
  }

  runtimeInstallation = codeBuddyRuntimeInstallation;

  async provenance(signal: AbortSignal): Promise<SolverProvenance> {
    signal.throwIfAborted();
    return { ...toolPolicyProvenance(this.policy, "codebuddy-native"), codebuddyVersion: CODEBUDDY_VERSION };
  }

  async solve(input: PublicTask, session: EnvironmentSession, context: AttemptContext): Promise<SolveResult> {
    const { signal } = context;
    signal.throwIfAborted();
    const { model, auth } = this.binding;
    if (!auth.value.trim() || /[\r\n\0]/u.test(auth.value)) {
      throw new EvaluatorError("MODEL_AUTH_FAILED", "codebuddy requires a non-empty, single-line API key on its selected service");
    }
    if (input.skillsDirectories?.length || input.mcpServers?.length) {
      throw new EvaluatorError("BENCHMARK_UNSUPPORTED", "codebuddy does not support task skills or MCP servers");
    }
    if (input.attachments?.some(attachment => attachment.kind === "pdf" && attachment.mode === "native")) {
      throw new EvaluatorError("BENCHMARK_UNSUPPORTED", "codebuddy requires PDF attachments in pages mode");
    }
    requireInputModalities(input, model.inputModalities ?? ["text"]);
    const runtime = session.runtime;
    if (runtime?.stateRoot === undefined) {
      throw new EvaluatorError("ENV_RUNTIME_INSTALL_FAILED", "codebuddy requires an environment-prepared runtime with writable state");
    }
    const mapping = session.modelEndpoint;
    const baseUrl = mapping?.originEndpoint === model.endpoint ? apiBase(mapping.baseUrl) : this.endpoint;
    const local = runtime.persistent;
    const path = local ? join : posix.join;
    const home = path(runtime.stateRoot, `attempt-${randomUUID()}`);
    const token = randomUUID();
    const media = await loadAttachments(input, session, context);
    try {
      const handle = await session.start({
        executable: local ? process.execPath : "node",
        args: [path(runtime.root, "launch.mjs"), home, path(runtime.root, CODEBUDDY_ENTRY)],
        cwd: session.workdir,
        env: { NODE_USE_ENV_PROXY: "1" },
        inheritEnv: false,
        input: Buffer.from(JSON.stringify({
          apiKey: auth.value, api: model.api, baseUrl, model: model.name, maxTokens: model.maxTokens, toolPolicy: this.policy,
          supportsImages: model.inputModalities?.includes("image") ?? false, prompt: input.prompt, token, media,
        }), "utf8"),
      }, signal);
      return await consumeCodeBuddy(handle, context, [auth.value, token]);
    } finally {
      if (local) await rm(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {
        context.warning?.({ code: "CLEANUP_FAILED", message: "Could not remove the temporary CodeBuddy state directory" });
      });
    }
  }
}
