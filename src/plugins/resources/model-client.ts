import type { Context } from "@deepseek-ai/cordis";
import type { ResourceProvider, WorkflowObject } from "../../core/contracts/workflow.js";
import type { WorkflowApplication } from "../steps/workflow-builtins.js";
import { workflowObject } from "../../core/workflow/values.js";
import { expectNonEmptyString, rejectUnknown } from "../../core/validation/input.js";
import { requireNetwork } from "./network-runtime.js";
import { fetchNetworkResponse } from "../../infrastructure/network/retry.js";

export const modelClientProvider: ResourceProvider = {
  type: "model.client", version: "1", apiVersion: 1, capabilities: ["application.invoke/v1"], sharing: "shared",
  resources: { network: { capability: "network.access/v1" } },
  validateConfig(value) {
    const outer = workflowObject(value);
    if (Object.hasOwn(outer, "settings")) rejectUnknown(outer, ["settings"], "model.client");
    const config = Object.hasOwn(outer, "settings") ? workflowObject(outer.settings) : outer;
    rejectUnknown(config, ["model", "endpoint", "apiKeyEnv", "maxTokens", "temperature", "maxAttempts"], "model.client");
    expectNonEmptyString(config.model, "model.client.model");
    const url = new URL(expectNonEmptyString(config.endpoint, "model.client.endpoint"));
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new TypeError("Model endpoint must use HTTP(S)");
    if (url.username || url.password) throw new TypeError("Credentials must use apiKeyEnv");
    if (config.apiKeyEnv !== undefined) expectNonEmptyString(config.apiKeyEnv, "model.client.apiKeyEnv");
    if (config.maxTokens !== undefined && (typeof config.maxTokens !== "number" || !Number.isSafeInteger(config.maxTokens) || config.maxTokens <= 0)) throw new TypeError("maxTokens must be a positive integer");
    if (config.temperature !== undefined && (typeof config.temperature !== "number" || !Number.isFinite(config.temperature) || config.temperature < 0 || config.temperature > 2)) throw new TypeError("temperature must be between 0 and 2");
    if (config.maxAttempts !== undefined && (typeof config.maxAttempts !== "number" || !Number.isSafeInteger(config.maxAttempts) || config.maxAttempts <= 0)) throw new TypeError("maxAttempts must be a positive integer");
    return config;
  },
  credentials: config => typeof config.apiKeyEnv === "string" ? [config.apiKeyEnv] : [],
  async create(config, context) {
    const credential = typeof config.apiKeyEnv === "string" ? await context.runtime.credential(config.apiKeyEnv) : undefined;
    if (config.apiKeyEnv !== undefined && !credential) throw new TypeError(`Missing credential environment variable ${config.apiKeyEnv}`);
    const closed = new AbortController();
    const network = requireNetwork(context.resource("network"));
    const client: WorkflowApplication = {
      async invoke(request, signal) {
        const messages = request.messages ?? [{ role: "user", content: expectNonEmptyString(request.prompt ?? request.question, "request.prompt") }];
        if (!Array.isArray(messages)) throw new TypeError("request.messages must be an array");
        const body: WorkflowObject = { model: config.model ?? "", messages,
          ...(config.maxTokens === undefined ? {} : { max_tokens: config.maxTokens }),
          ...(config.temperature === undefined ? {} : { temperature: config.temperature }) };
        const started = performance.now();
        const response = await fetchNetworkResponse(`${String(config.endpoint).replace(/\/$/, "")}/chat/completions`, {
          method: "POST", headers: { "content-type": "application/json", ...(credential ? { authorization: `Bearer ${credential}` } : {}) },
          body: JSON.stringify(body), signal: AbortSignal.any([closed.signal, signal]),
        }, { network, context: { phase: "solve", component: "model", operation: "workflow model request" },
          maxAttempts: typeof config.maxAttempts === "number" ? config.maxAttempts : 4 });
        if (!response.ok) { await response.body?.cancel(); throw new Error(`Model request failed with HTTP ${response.status}`); }
        const data = workflowObject(await response.json(), "model response");
        const choice = Array.isArray(data.choices) ? workflowObject(data.choices[0], "model choice") : null;
        const message = choice ? workflowObject(choice.message, "model message") : null;
        if (!message || typeof message.content !== "string") throw new TypeError("Model response has no text content");
        return { text: message.content, usage: data.usage ?? null, model: config.model ?? null,
          durationMs: performance.now() - started, finishReason: choice?.finish_reason ?? null };
      },
    };
    return { value: client, identity: { model: config.model ?? null }, async dispose() {
      closed.abort(new Error("Model client closed"));
    } };
  },
  async recover() {},
};

export function registerModelResource(ctx: Context): void { ctx.evaluator.registerResource(modelClientProvider); }
