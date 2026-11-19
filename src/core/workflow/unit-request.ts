import type { ResourceBinding, WorkflowBlock, WorkflowCatalog, WorkflowForEach, WorkflowUnitRequest } from "../contracts/workflow.js";
import { workflowDigest, workflowObject } from "./values.js";

export function workflowDispatchFingerprint(request: Pick<WorkflowUnitRequest, "bindings" | "unit">): string {
  return workflowDigest({ bindings: request.bindings, inputFingerprint: request.unit.inputFingerprint });
}

/** Resolve a compiled body, never executable code supplied separately from the locked plan. */
export function resolveUnitRequest(request: WorkflowUnitRequest, catalog: WorkflowCatalog): {
  node: WorkflowForEach; resources: Record<string, ResourceBinding>;
} {
  workflowObject(request, "workflow unit request");
  const { plan, unit } = request;
  if (!/^[a-f0-9]{64}$/.test(unit.inputFingerprint) || request.dispatchFingerprint !== workflowDispatchFingerprint(request))
    throw new TypeError("Workflow dispatch input fingerprint changed");
  const parts = request.blockPath.split(".");
  if (parts.shift() !== "workflow" || !parts.length) throw new TypeError("Invalid workflow unit block path");
  let body = plan.document.workflow;
  const resources: Record<string, ResourceBinding> = { ...body.resources };
  let target: WorkflowForEach | undefined;
  for (const [index, id] of parts.entries()) {
    const node = body.steps.find(node => node.id === id);
    if (!node || node.kind === "step") throw new TypeError(`Missing workflow unit block ${request.blockPath}`);
    if (index === parts.length - 1) {
      if (node.kind !== "forEach" || node.mode !== "units") throw new TypeError("Dispatch requires an independent unit block");
      target = node;
    } else {
      if (node.kind === "forEach" && node.mode === "units") throw new TypeError("Independent units cannot be nested");
      body = node.body;
      Object.assign(resources, body.resources);
    }
  }
  if (!target) throw new TypeError("Missing workflow unit body");
  const identity = { caseId: unit.caseId, variantId: unit.variantId, repetition: unit.repetition };
  const digest = workflowDigest(identity);
  const prefix = request.path.slice(0, -(digest.slice(0, 16).length + 2));
  if (unit.status !== "running" || !unit.attemptId || !Number.isSafeInteger(unit.ordinal) || unit.ordinal < 1 ||
      request.path !== `${prefix}[${digest.slice(0, 16)}]` || prefix.replace(/\[[0-9a-f]{16}\]/g, "") !== request.blockPath ||
      unit.key !== `${prefix}:${digest}` || Object.keys(unit.outputs).length || unit.errors.length)
    throw new TypeError("Invalid workflow unit identity or initial state");
  const variant = workflowObject(request.bindings.variant, "unit variant");
  const item = workflowObject(request.bindings[target.as], "unit item");
  if (variant.id !== unit.variantId || item.id !== unit.caseId || request.bindings.repetition !== unit.repetition ||
      unit.repetition < 0 || unit.repetition >= target.matrix.repetitions ||
      !target.matrix.variants.some(value => workflowDigest(value) === workflowDigest(variant)))
    throw new TypeError("Workflow unit bindings do not match its execution identity");
  const inherited = { ...request.bindings };
  delete inherited[target.as]; delete inherited.variant; delete inherited.repetition;
  if (!target.admission && unit.inputFingerprint !== workflowDigest({ item, variant, repetition: unit.repetition, bindings: inherited }))
    throw new TypeError("Workflow unit input fingerprint changed");

  // Only explicitly worker-owned resources can cross the process boundary.
  // In particular, sharing: shared alone never authorizes copying a run owner.
  const checked = new Set<string>();
  const check = (name: string, available: Record<string, ResourceBinding>, local: Set<string>) => {
    if (checked.has(name)) return;
    const binding = available[name];
    if (!binding) throw new TypeError(`Missing dispatched resource ${name}`);
    checked.add(name);
    if (!local.has(name) && binding.scope !== "worker" && binding.scope !== "attempt" && binding.scope !== "step")
      throw new TypeError(`Remote unit cannot use coordinator-owned resource ${name}; declare worker or attempt scope`);
    for (const dependency of Object.values(binding.resources)) check(dependency, available, local);
    if (binding.scope === "worker" && catalog.resource(binding.use).sharing !== "shared")
      throw new TypeError(`Worker resource ${name} must explicitly permit sharing`);
  };
  const visit = (block: WorkflowBlock, inheritedResources: Record<string, ResourceBinding>, enclosing: Set<string>) => {
    const available = { ...inheritedResources, ...block.resources };
    const local = new Set([...enclosing, ...Object.keys(block.resources)]);
    for (const node of block.steps) {
      if (node.kind === "step") for (const name of Object.values(node.resources)) check(name, available, local);
      else visit(node.body, available, local);
    }
  };
  visit(target.body, resources, new Set());
  return { node: target, resources };
}
