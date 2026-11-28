import { randomUUID } from "node:crypto";
export const inject = ["evaluator"];
const object = value => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Expected object");
  return value;
};
async function remove(identity, signal, runtime) {
  const response = await fetch(`${identity.endpoint}/${identity.id}`, { method: "DELETE", signal,
    headers: { authorization: `Bearer ${await runtime.credential(identity.apiKeyEnv)}` } });
  if (!response.ok) throw new Error("Fixture namespace cleanup failed");
}
export function apply(ctx) {
  ctx.evaluator.registerStep({ type: "fixture.ray-guard", apiVersion: 1, version: "1", effects: "isolated-write",
    resources: { connection: { capability: "ray.connection/v1" } }, inputs: {}, outputs: {}, validateConfig: object,
    async execute(_inputs, _config, context) {
      const connection = context.resource("connection");
      const versions = Object.fromEntries(Object.entries(context.plan.sources).filter(([name]) => !name.startsWith("template:")));
      await connection.client.guardImages({ environment: { name: "local", config: {} }, pluginVersions: versions,
        packageDigest: versions["arsi-evaluator:package"] }, context.signal);
      return {};
    },
  });
  ctx.evaluator.registerResource({ type: "fixture.namespace", apiVersion: 1, version: "1", capabilities: ["fixture.namespace"], resources: {},
    validateConfig: object, credentials: config => [config.apiKeyEnv], async create(config, context) {
      const identity = { endpoint: config.endpoint, apiKeyEnv: config.apiKeyEnv, id: randomUUID() };
      await context.checkpoint(identity);
      const response = await fetch(`${identity.endpoint}/${identity.id}`, { method: "POST", signal: context.signal,
        headers: { authorization: `Bearer ${await context.runtime.credential(config.apiKeyEnv)}` } });
      if (!response.ok) throw new Error("Fixture allocation failed");
      return { value: {}, identity, dispose: signal => remove(identity, signal, context.runtime) };
    }, recover: (identity, context) => remove(identity, context.signal, context.runtime),
  });
  ctx.evaluator.registerStep({ type: "fixture.large-artifact", apiVersion: 1, version: "1", effects: "isolated-write", resources: { state: { capability: "fixture.namespace" } },
    inputs: {}, outputs: { artifact: { protocol: "arsi.json/v1", validate: object } }, validateConfig: object,
    async execute(_inputs, config, context) {
      if (config.wait) await new Promise((done, reject) => {
        const timer = setTimeout(done, 60_000);
        context.signal.addEventListener("abort", () => { clearTimeout(timer); reject(context.signal.reason); }, { once: true });
      });
      return { artifact: await context.artifacts.write("binary.bin", new Uint8Array(1_100_000).fill(123),
        { mediaType: "application/octet-stream", protocol: "fixture.binary/v1" }) };
    },
  });
}
