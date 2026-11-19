import { workflowObject, workflowValue } from "arsi-evaluator";
import type { JsonValue, ResourceProvider, WorkflowContext, WorkflowObject } from "arsi-evaluator";

async function request(identity: Readonly<WorkflowObject>, runtime: WorkflowContext["runtime"], method: string, suffix: string, signal: AbortSignal, body?: unknown): Promise<JsonValue> {
  const credential = typeof identity.apiKeyEnv === "string" ? await runtime.credential(identity.apiKeyEnv) : undefined;
  if (identity.apiKeyEnv !== undefined && !credential) throw new TypeError(`Missing credential environment variable ${identity.apiKeyEnv}`);
  if (typeof identity.endpoint !== "string" || typeof identity.namespace !== "string") throw new TypeError("Missing memory namespace ownership receipt");
  const response = await fetch(`${identity.endpoint}/namespaces/${encodeURIComponent(identity.namespace)}${suffix}`, {
    method, signal, headers: { "content-type": "application/json", ...(credential ? { authorization: `Bearer ${credential}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (method === "DELETE" && response.status === 404 || response.status === 204) { await response.body?.cancel(); return null; }
  if (!response.ok) { await response.body?.cancel(); throw new Error(`Memory service returned HTTP ${response.status}`); }
  return workflowValue(await response.json());
}

/** Reference HTTP protocol: PUT namespace, POST /history, POST /query, DELETE namespace. */
export const httpMemoryProvider: ResourceProvider = {
  type: "example.memory-http", apiVersion: 1, version: "1", capabilities: ["example.memory/v1"], resources: {},
  validateConfig(value) {
    const config = workflowObject(value);
    if (Object.keys(config).some(key => !["endpoint", "apiKeyEnv"].includes(key))) throw new TypeError("Unknown HTTP memory configuration");
    if (typeof config.endpoint !== "string") throw new TypeError("Memory endpoint is required");
    const endpoint = new URL(config.endpoint);
    if (!["http:", "https:"].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash)
      throw new TypeError("Memory endpoint must be an HTTP(S) service root without credentials or query parameters");
    if (config.apiKeyEnv !== undefined && (typeof config.apiKeyEnv !== "string" || !config.apiKeyEnv.trim())) throw new TypeError("Invalid apiKeyEnv");
    return { ...config, endpoint: config.endpoint.replace(/\/$/, "") };
  },
  credentials: config => typeof config.apiKeyEnv === "string" ? [config.apiKeyEnv] : [],
  async create(config, context) {
    const identity = { ...config, namespace: `${context.runId}/${context.attemptId}` };
    // A lost HTTP response can follow a successful allocation. Persist its name first.
    await context.checkpoint(identity);
    await request(identity, context.runtime, "PUT", "", context.signal, {});
    return { identity, value: {
      async ingest(entries: JsonValue[], signal: AbortSignal) { await request(identity, context.runtime, "POST", "/history", signal, { entries }); },
      async query(key: string, signal: AbortSignal) { return request(identity, context.runtime, "POST", "/query", signal, { key }); },
    }, async dispose(signal) { await request(identity, context.runtime, "DELETE", "", signal); } };
  },
  async recover(identity, context) { await request(identity, context.runtime, "DELETE", "", context.signal); },
};
