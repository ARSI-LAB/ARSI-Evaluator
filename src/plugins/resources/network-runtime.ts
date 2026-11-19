import type { Context } from "@deepseek-ai/cordis";
import type { JsonValue } from "../../core/contracts/task.js";
import type { ResourceProvider, WorkflowContext } from "../../core/contracts/workflow.js";
import { workflowObject, workflowValue } from "../../core/workflow/values.js";
import { rejectUnknown } from "../../core/validation/input.js";
import { networkCredentialNames, networkDocument, validateNetworkSnapshot } from "../../config/network-schema.js";
import { NetworkRuntime } from "../../infrastructure/network/runtime.js";

export function requireNetwork(value: unknown): NetworkRuntime {
  if (!(value instanceof NetworkRuntime)) throw new TypeError("A network.runtime resource is required");
  return value;
}

export async function openWorkflowNetwork(template: JsonValue, context: Pick<WorkflowContext, "runtime">, origin?: string): Promise<NetworkRuntime> {
  validateNetworkSnapshot({ benchmarkName: "workflow", template });
  const env = Object.fromEntries(await Promise.all(networkCredentialNames(template).map(async name => [name, await context.runtime.credential(name)])));
  return new NetworkRuntime(networkDocument(template, env, origin));
}

/** Recovery cannot reuse a dead process's resource handle. The provider owns this temporary client. */
export async function withRecoveryNetwork<T>(template: JsonValue, context: WorkflowContext, work: (context: WorkflowContext) => Promise<T>): Promise<T> {
  const network = await openWorkflowNetwork(template, context);
  try { return await work({ ...context, resource: name => name === "network" ? network : context.resource(name) }); }
  finally { await network.dispose(); }
}

export const networkRuntimeProvider: ResourceProvider = {
  type: "network.runtime", version: "1", apiVersion: 1, capabilities: ["network.access/v1"], sharing: "shared",
  availableDuringMaintenance: true, resources: {},
  validateConfig(value) {
    const config = workflowObject(value);
    rejectUnknown(config, ["template"], "network.runtime");
    const template = workflowValue(config.template ?? {});
    validateNetworkSnapshot({ benchmarkName: "workflow", template });
    return { template };
  },
  credentials: config => networkCredentialNames(config.template ?? {}),
  async create(config, context) {
      const origin = context.binding ? context.runtime.origins?.resourceFiles[context.binding] : undefined;
      const network = await openWorkflowNetwork(config.template ?? {}, context, origin);
    return { value: network, identity: {}, dispose: () => network.dispose() };
  },
  async recover() {},
};

export function registerNetworkResource(ctx: Context): void { ctx.evaluator.registerResource(networkRuntimeProvider); }
