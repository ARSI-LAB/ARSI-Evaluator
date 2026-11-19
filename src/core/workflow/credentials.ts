import type { JsonValue } from "../contracts/task.js";
import type { ResourceBinding, WorkflowBlock, WorkflowCatalog, WorkflowPlan, WorkflowUnitRequest } from "../contracts/workflow.js";
import { resolveUnitRequest } from "./unit-request.js";
import { resolveBinding } from "./values.js";

function collectCredentials(block: WorkflowBlock, inherited: Record<string, ResourceBinding>, values: Map<string, JsonValue>,
  catalog: WorkflowCatalog, names: Set<string>, includeCoordinator: boolean, maintenance?: string): void {
  const available = { ...inherited, ...block.resources };
  const visited = new Map<ResourceBinding, Set<boolean>>();
  const visitResource = (name: string, operation = false) => {
    const binding = available[name];
    if (!binding) throw new TypeError(`Missing dispatched resource ${name}`);
    let modes = visited.get(binding);
    if (!modes) { modes = new Set(); visited.set(binding, modes); }
    if (modes.has(operation)) return;
    modes.add(operation);
    const provider = catalog.resource(binding.use);
    const hook = operation && maintenance !== "warmup" ? provider.maintenance?.[maintenance ?? ""] : undefined;
    const declared = operation && maintenance !== "warmup" ? hook?.credentials : provider.credentials;
    if (declared) {
      const config = provider.validateConfig(Object.fromEntries(Object.entries(binding.config).map(([key, value]) => {
        try { return [key, resolveBinding(value, values)]; }
        catch { throw new TypeError(`Credential configuration for ${name} must use literals, workflow inputs or matrix variants`); }
      })));
      for (const credential of declared(config)) {
        if (typeof credential !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(credential))
          throw new TypeError(`Invalid credential name declared by ${binding.use}`);
        names.add(credential);
      }
    }
    for (const [port, dependency] of Object.entries(binding.resources)) if (!hook || hook.resources.includes(port)) visitResource(dependency);
  };
  if (maintenance) for (const [name, binding] of Object.entries(block.resources)) {
    const provider = catalog.resource(binding.use);
    if (maintenance === "warmup" ? provider.warmup : provider.maintenance?.[maintenance]) visitResource(name, true);
  }
  for (const node of block.steps) {
    if (node.kind === "step") { if (!maintenance) for (const name of Object.values(node.resources)) visitResource(name); continue; }
    if (node.kind === "forEach" && node.mode === "units" && includeCoordinator) {
      if (!maintenance && node.admission) visitResource(node.admission);
      if (!maintenance && node.executor) visitResource(node.executor);
      if (!maintenance && node.retry) visitResource(node.retry.policy);
      for (const variant of node.matrix.variants) for (let repetition = 0; repetition < node.matrix.repetitions; repetition++) {
        const child = new Map(values); child.set("variant", variant); child.set("repetition", repetition);
        collectCredentials(node.body, available, child, catalog, names, includeCoordinator, maintenance);
      }
    } else collectCredentials(node.body, available, values, catalog, names, includeCoordinator, maintenance);
  }
}

/** Case data and computed outputs cannot grant access to coordinator credentials. */
export function workflowCredentialNames(request: WorkflowUnitRequest, catalog: WorkflowCatalog): string[] {
  const { node, resources } = resolveUnitRequest(request, catalog);
  const values = new Map<string, JsonValue>([["inputs", request.plan.document.inputs],
    ["variant", request.bindings.variant ?? null], ["repetition", request.unit.repetition]]);
  const names = new Set<string>();
  collectCredentials(node.body, resources, values, catalog, names, false);
  return [...names].sort();
}

/** Include coordinator services and all model variants, but never unused declarations. */
export function workflowPlanCredentialNames(plan: WorkflowPlan, catalog: WorkflowCatalog): string[] {
  const names = new Set<string>();
  collectCredentials(plan.document.workflow, {}, new Map([["inputs", plan.document.inputs]]), catalog, names, true);
  return [...names].sort();
}

/** Maintenance may use declared resources even when no evaluation step uses them. */
export function workflowMaintenanceCredentialNames(plan: WorkflowPlan, catalog: WorkflowCatalog, operation: string): string[] {
  const names = new Set<string>();
  collectCredentials(plan.document.workflow, {}, new Map([["inputs", plan.document.inputs]]), catalog, names, true, operation);
  return [...names].sort();
}
