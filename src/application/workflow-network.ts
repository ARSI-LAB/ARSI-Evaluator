import type { JsonValue } from "../core/contracts/task.js";
import type { WorkflowBlock, WorkflowCatalog, WorkflowDocument } from "../core/contracts/workflow.js";
import { loadNetworkTemplate } from "../config/network.js";
import { validateNetworkSnapshot } from "../config/network-schema.js";

/** Default bindings are explicit in the compiled plan; user-supplied bindings take precedence. */
export async function bindWorkflowNetwork(document: WorkflowDocument, catalog: WorkflowCatalog,
  options: { networkConfigPath?: string; env: NodeJS.ProcessEnv }): Promise<Record<string, string>> {
  const origins: Record<string, string> = {};
  const names = new Set<string>();
  const blocks: WorkflowBlock[] = [];
  const collect = (block: WorkflowBlock) => {
    blocks.push(block); Object.keys(block.resources).forEach(name => names.add(name));
    for (const node of block.steps) if (node.kind !== "step") collect(node.body);
  };
  collect(document.workflow);
  let template: JsonValue | undefined;
  let origin: string | undefined;
  const defaults = new Map<"run" | "worker", string>();
  const binding = async (scope: "run" | "worker") => {
    const existing = defaults.get(scope); if (existing) return existing;
    if (template === undefined) {
      const loaded = await loadNetworkTemplate(options.networkConfigPath, options.env);
      template = loaded.template; origin = loaded.origin;
      validateNetworkSnapshot({ benchmarkName: "workflow", template });
    }
    let name = scope === "run" ? "coordinatorNetwork" : "workerNetwork";
    for (let index = 1; names.has(name); index++) name = `${scope}Network${index}`;
    names.add(name); defaults.set(scope, name);
    if (origin) origins[name] = origin;
    document.workflow.resources[name] = { use: "network.runtime", scope, config: { template: { value: template } }, resources: {} };
    return name;
  };
  for (const block of blocks) {
    for (const resource of Object.values(block.resources)) {
      const provider = catalog.resource(resource.use);
      for (const [port, requirement] of Object.entries(provider.resources))
        if (requirement.capability === "network.access/v1" && resource.resources[port] === undefined)
          resource.resources[port] = await binding(resource.scope === "run" ? "run" : "worker");
    }
    for (const node of block.steps) if (node.kind === "step") {
      for (const [port, requirement] of Object.entries(catalog.step(node.use).resources))
        if (requirement.capability === "network.access/v1" && node.resources[port] === undefined) node.resources[port] = await binding("worker");
    }
  }
  return origins;
}
