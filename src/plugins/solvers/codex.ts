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
import { consumeCodex } from "../../runtimes/codex/protocol.js";
import { CODEX_ENTRY, CODEX_VERSION, codexRuntimeInstallation } from "../../runtimes/codex/runtime.js";
import { loadAttachments, requireInputModalities } from "../../runtimes/multimodal/input.js";

export function parseCodexConfig(value: unknown): Record<string, never> {
  rejectUnknown(expectRecord(value, "codex config"), [], "codex config");
  return {};
}

function responsesEndpoint(endpoint: string | null): string {
  const url = endpoint === null ? null : URL.parse(endpoint);
  if (!url || !["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new TypeError("codex requires an HTTP(S) base_url without credentials, query or fragment");
  }
  return url.href.replace(/\/+$/u, "");
}

export class CodexSolver implements Solver {
  readonly inputModalities = ["text", "image"] as const;
  private readonly endpoint: string;

  constructor(private readonly binding: ServiceBinding) {
    if (binding.model.api !== "openai-responses") {
      throw new TypeError("codex requires api: openai-responses on its selected service");
    }
    this.endpoint = responsesEndpoint(binding.model.endpoint);
    if (binding.model.maxTokens !== undefined || binding.model.retry !== undefined) {
      throw new TypeError("codex does not support services.*.maxTokens or services.*.retry");
    }
  }

  requirements(): RuntimeRequirement[] {
    return [{ name: "node", version: "24.x", platform: "any" }, { name: "shell", version: "any", platform: "any" }];
  }

  runtimeInstallation = codexRuntimeInstallation;

  async provenance(signal: AbortSignal): Promise<SolverProvenance> {
    signal.throwIfAborted();
    return { codexVersion: CODEX_VERSION };
  }

  async solve(input: PublicTask, session: EnvironmentSession, context: AttemptContext): Promise<SolveResult> {
    const { signal } = context;
    signal.throwIfAborted();
    const { model, auth } = this.binding;
    if (!auth.value.trim() || /[\r\n\0]/u.test(auth.value)) {
      throw new EvaluatorError("MODEL_AUTH_FAILED", "codex requires a non-empty, single-line API key on its selected service");
    }
    if (input.skillsDirectories?.length || input.mcpServers?.length) {
      throw new EvaluatorError("BENCHMARK_UNSUPPORTED", "codex does not support task skills or MCP servers");
    }
    if (input.attachments?.some(attachment => attachment.kind === "pdf" && attachment.mode === "native")) {
      throw new EvaluatorError("BENCHMARK_UNSUPPORTED", "codex requires PDF attachments in pages mode");
    }
    requireInputModalities(input, model.inputModalities ?? ["text"]);
    const runtime = session.runtime;
    if (runtime?.stateRoot === undefined) {
      throw new EvaluatorError("ENV_RUNTIME_INSTALL_FAILED", "codex requires an environment-prepared runtime with writable state");
    }
    const mapping = session.modelEndpoint;
    const endpoint = mapping?.originEndpoint === model.endpoint ? responsesEndpoint(mapping.baseUrl) : this.endpoint;
    const local = runtime.persistent;
    const path = local ? join : posix.join;
    const home = path(runtime.stateRoot, `attempt-${randomUUID()}`);
    const settings = [
      'approval_policy="never"',
      "allow_login_shell=false",
      'web_search="disabled"',
      "analytics.enabled=false",
      "features.hooks=false",
      `projects.${JSON.stringify(session.workdir)}.trust_level="untrusted"`,
      'shell_environment_policy.inherit="core"',
      "shell_environment_policy.ignore_default_excludes=false",
      'shell_environment_policy.filters.EVALUATOR_CODEX_API_KEY="exclude"',
      'model_provider="ember"',
      'model_providers.ember.name="Ember Evaluator"',
      `model_providers.ember.base_url=${JSON.stringify(endpoint)}`,
      'model_providers.ember.env_key="EVALUATOR_CODEX_API_KEY"',
      'model_providers.ember.wire_api="responses"',
      ...(model.contextWindow === undefined ? [] : [`model_auto_compact_token_limit=${model.contextWindow}`]),
    ];
    const media = await loadAttachments(input, session, context);
    try {
      const handle = await session.start({
        executable: local ? process.execPath : "node",
        args: [path(runtime.root, "launch.mjs"), home, path(runtime.root, CODEX_ENTRY),
          "exec", "--json", "--ephemeral", "--ignore-user-config", "--ignore-rules", "--skip-git-repo-check",
          "--color", "never", "--sandbox", local ? "workspace-write" : "danger-full-access", "--model", model.name,
          ...settings.flatMap(setting => ["-c", setting]), "-"],
        cwd: session.workdir,
        env: {},
        inheritEnv: false,
        input: Buffer.from(JSON.stringify({ apiKey: auth.value, prompt: input.prompt, media }), "utf8"),
      }, signal);
      return await consumeCodex(handle, context, auth.value);
    } finally {
      if (local) await rm(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {
        context.warning?.({ code: "CLEANUP_FAILED", message: "Could not remove the temporary Codex state directory" });
      });
    }
  }
}
