import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { join, posix } from "node:path";
import type { EnvironmentSession, RuntimeRequirement } from "../../core/contracts/environment.js";
import type { ServiceBinding } from "../../core/contracts/plugin.js";
import type { SolveResult } from "../../core/contracts/result.js";
import type { AttemptContext, Solver, SolverProvenance } from "../../core/contracts/solver.js";
import type { PublicTask } from "../../core/contracts/task.js";
import { EvaluatorError } from "../../core/errors/evaluator-error.js";
import { parseSolverToolPolicy, toolPolicyProvenance, unsupportedToolPolicy, type SolverToolPolicy } from "../../core/validation/solver-tool-policy.js";
import { loadAttachments, requireInputModalities } from "../../runtimes/multimodal/input.js";
import { consumeTrae } from "../../runtimes/trae/protocol.js";
import { TRAE_VERSION, traeRuntimeInstallation } from "../../runtimes/trae/runtime.js";

// Captured from the locked headless CLI, including tools exposed after the first batch is removed.
const TRAE_TOOLS = [
  "Read", "Write", "Edit", "Bash", "Agent", "ListAgents", "Skill", "TaskCreate", "TaskGet", "TaskList",
  "TaskUpdate", "exec", "wait", "Monitor", "SendMessage", "TaskStop", "TaskOutput", "WebFetch",
  "Glob", "Grep", "WebSearch", "web_search",
];

const TRAE_WIRE_APIS = new Map<string, string>([
  ["openai-completions", "chat_completions"],
  ["openai-responses", "responses"],
  ["anthropic-messages", "anthropic_messages"],
]);

export function parseTraeConfig(value: unknown): SolverToolPolicy {
  const policy = parseSolverToolPolicy(value, "trae config");
  if (policy.webSearch === "enabled" || policy.webFetch === "enabled") {
    unsupportedToolPolicy("trae", "the locked headless exec mode cannot explicitly enable web search or fetch");
  }
  return policy;
}

function apiBase(endpoint: string | null): string {
  const url = endpoint === null ? null : URL.parse(endpoint);
  if (!url || !["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new TypeError("trae requires an HTTP(S) base_url without credentials, query or fragment");
  }
  return url.href.replace(/\/+$/u, "");
}

export class TraeSolver implements Solver {
  readonly inputModalities = ["text", "image"] as const;
  private readonly endpoint: string;
  private readonly wireApi: string;

  constructor(private readonly binding: ServiceBinding, private readonly policy: SolverToolPolicy = {}) {
    const { model } = binding;
    const api = model.api;
    const wireApi = api === null ? undefined : TRAE_WIRE_APIS.get(api);
    if (wireApi === undefined) {
      throw new TypeError("trae requires api: openai-completions, openai-responses or anthropic-messages on its selected service");
    }
    this.wireApi = wireApi;
    this.endpoint = apiBase(model.endpoint);
    if (model.maxTokens !== undefined || model.contextWindow !== undefined || model.retry !== undefined) {
      throw new TypeError("trae does not support services.*.maxTokens, services.*.contextWindow or services.*.retry");
    }
  }

  requirements(): RuntimeRequirement[] {
    return [{ name: "node", version: "24.x", platform: "any" }, { name: "shell", version: "any", platform: "any" }];
  }

  runtimeInstallation = traeRuntimeInstallation;

  async provenance(signal: AbortSignal): Promise<SolverProvenance> {
    signal.throwIfAborted();
    return { ...toolPolicyProvenance(this.policy, "trae-native"), traeVersion: TRAE_VERSION };
  }

  async solve(input: PublicTask, session: EnvironmentSession, context: AttemptContext): Promise<SolveResult> {
    const { signal } = context;
    signal.throwIfAborted();
    const { model, auth } = this.binding;
    if (!auth.value.trim() || /[\r\n\0]/u.test(auth.value)) {
      throw new EvaluatorError("MODEL_AUTH_FAILED", "trae requires a non-empty, single-line API key on its selected service");
    }
    if (input.skillsDirectories?.length || input.mcpServers?.length) {
      throw new EvaluatorError("BENCHMARK_UNSUPPORTED", "trae does not support task skills or MCP servers");
    }
    if (input.attachments?.some(attachment => attachment.kind === "pdf" && attachment.mode === "native")) {
      throw new EvaluatorError("BENCHMARK_UNSUPPORTED", "trae requires PDF attachments in pages mode");
    }
    requireInputModalities(input, model.inputModalities ?? ["text"]);
    const runtime = session.runtime;
    if (runtime?.stateRoot === undefined) {
      throw new EvaluatorError("ENV_RUNTIME_INSTALL_FAILED", "trae requires an environment-prepared runtime with writable state");
    }
    const mapping = session.modelEndpoint;
    const endpoint = mapping?.originEndpoint === model.endpoint ? apiBase(mapping.baseUrl) : this.endpoint;
    const local = runtime.persistent;
    const path = local ? join : posix.join;
    const home = path(runtime.stateRoot, `attempt-${randomUUID()}`);
    const settings = [
      'approval_policy="never"',
      "allow_login_shell=false",
      'web_search="disabled"',
      "analytics.enabled=false",
      "features.hooks=false",
      "resource_dirs=[]",
      `projects.${JSON.stringify(session.workdir)}.trust_level="untrusted"`,
      'shell_environment_policy.inherit="core"',
      'shell_environment_policy.exclude=["EVALUATOR_TRAE_API_KEY"]',
      'model_provider="ember"',
      'model_providers.ember.name="Ember Evaluator"',
      `model_providers.ember.base_url=${JSON.stringify(endpoint)}`,
      'model_providers.ember.env_key="EVALUATOR_TRAE_API_KEY"',
      `model_providers.ember.wire_api=${JSON.stringify(this.wireApi)}`,
      ...(local && process.platform === "win32" ? ['windows.sandbox="unelevated"'] : []),
    ];
    const denied = this.policy.tools === "none" ? TRAE_TOOLS : [
      ...(this.policy.webSearch === "disabled" ? ["WebSearch", "web_search"] : []),
      ...(this.policy.webFetch === "disabled" ? ["WebFetch"] : []),
    ];
    const media = await loadAttachments(input, session, context);
    try {
      const handle = await session.start({
        executable: local ? process.execPath : "node",
        args: [path(runtime.root, "launch.mjs"), home, "exec", "--json", "--ephemeral",
          "--ignore-rules", "--skip-git-repo-check", "--color", "never", "--sandbox", local ? "workspace-write" : "danger-full-access",
          "--model", model.name, ...settings.flatMap(setting => ["-c", setting]),
          ...denied.flatMap(tool => ["--disallowed-tool", tool]), "-"],
        cwd: session.workdir,
        env: {},
        inheritEnv: false,
        input: Buffer.from(JSON.stringify({ apiKey: auth.value, prompt: input.prompt, media }), "utf8"),
      }, signal);
      return await consumeTrae(handle, context, auth.value);
    } finally {
      if (local) await rm(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {
        context.warning?.({ code: "CLEANUP_FAILED", message: "Could not remove the temporary TRAE state directory" });
      });
    }
  }
}
