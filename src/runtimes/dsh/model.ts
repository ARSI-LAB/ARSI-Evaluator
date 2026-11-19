import { stringify } from "yaml";
import type { ModelConfig } from "../../core/contracts/config.js";
import { AgentBundleError } from "../agentbundle/cli.js";

export const DSH_AUTH_ENV = "ARSI_EVALUATOR_API_KEY";
export const DSH_ENDPOINT_PROVIDER = "arsi-evaluator";

export function dshModelPatch(model: ModelConfig): string {
  if (model.endpoint === null && (model.provider === "amazon-bedrock" || model.provider === "azure-openai")) {
    throw new AgentBundleError(
      "CONFIG_INVALID",
      "this provider requires endpoint or authentication fields outside the supported model contract",
    );
  }
  if (
    model.endpoint === null &&
    (model.provider === "deepseek-official" || (model.provider === "deepseek" && model.api === null))
  ) {
    return stringify([
      { id: "agent-default-model", config: { provider: "deepseek-official", model: model.name,
        ...(model.reasoningEffort === undefined ? {} : { reasoningEffort: model.reasoningEffort }) } },
      { id: "llm-deepseek", config: {
        apiKeyEnv: DSH_AUTH_ENV,
        ...(model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens }),
        ...(model.reasoningEffort === undefined ? {} : { thinking: "enabled", reasoningEffort: model.reasoningEffort }),
      } },
    ]);
  }
  if (model.endpoint !== null) {
    const url = new URL(model.endpoint);
    if (
      url.username ||
      url.password ||
      [...url.searchParams.keys()].some(key => /key|token|secret|password|auth/i.test(key))
    ) {
      throw new AgentBundleError("CONFIG_INVALID", "model endpoint cannot contain credentials");
    }
    if (!model.api) throw new AgentBundleError("CONFIG_INVALID", "an explicit endpoint requires an API protocol");
  } else if (!model.provider) throw new AgentBundleError("CONFIG_INVALID", "a provider is required without an endpoint");
  const provider = model.endpoint !== null ? DSH_ENDPOINT_PROVIDER : model.provider;
  if (!provider) throw new AgentBundleError("CONFIG_INVALID", "a provider is required without an endpoint");
  return stringify([
    { id: "agent-default-model", config: { provider, model: model.name,
      ...(model.reasoningEffort === undefined ? {} : { reasoningEffort: model.reasoningEffort }) } },
    { id: "llm-pi-ai", config: {
      providers: {
        [provider]: {
          apiKeyEnv: DSH_AUTH_ENV,
          ...(model.endpoint === null ? {} : { baseURL: model.endpoint }),
          ...(model.api === null ? {} : { api: model.api }),
          ...(model.reasoningEffort === undefined ? {} : { reasoning: model.reasoningEffort }),
          models: [{ id: model.name, ...(model.inputModalities === undefined ? {} : { input: model.inputModalities.filter(kind => kind !== "pdf") }), ...(model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens }),
            ...(model.reasoningEffort === undefined ? {} : {
              reasoningEfforts: { [model.reasoningEffort]: model.reasoningEffort },
              compat: model.api === "anthropic-messages" ? { forceAdaptiveThinking: true }
                : model.api === "openai-completions" ? { thinkingFormat: "openai", supportsReasoningEffort: true } : {},
            }) }],
        },
      },
    } },
  ]);
}

export type DshPermissionMode = "workspace-write" | "danger-full-access";

/** Replace only the headless text ingress; preserve the installed candidate tools. */
export function dshSdkPatch(profile: string, workspaceRoot: string, mode: DshPermissionMode): string {
  return stringify([
    { id: "headless-startup", disabled: true }, { id: "headless-runner", disabled: true },
    { id: "session-title-llm", disabled: true },
    { id: "sandbox-policy", inject: [], config: { mode, workspaceRoot, additionalWritableRoots: [] } },
    { insert: [{ id: "sdk-app-startup", name: "@deepseek-ai/dsh-sdk-app", config: { profile } },
      { id: "sdk-jsonrpc-server", name: "@deepseek-ai/dsh-sdk-jsonrpc-server", inject: ["sdkAppStartup", "loader"], config: { maxTokensAsSuccess: false } }] },
  ]);
}

/**
 * DSH's sandbox mode with explicit noninteractive approval. The patch replaces
 * DSH's preset table, so it must keep a preset matching the composed default.
 */
export function dshPermissionPatch(mode: DshPermissionMode): string {
  return stringify([
    { id: "approval", config: { policy: "never" } },
    {
      id: "permission",
      config: {
        presets: {
          [mode]: { sandbox: mode, approval: "never" },
        },
      },
    },
  ]);
}
