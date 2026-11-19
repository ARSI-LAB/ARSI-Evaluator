import type {
  DataVisibility, ResourceBinding, ValueBinding, WorkflowBlock, WorkflowCatalog, WorkflowDocument,
  WorkflowPlan, WorkflowPort, WorkflowResourceRequirement,
} from "../contracts/workflow.js";
import { workflowDigest, workflowValue } from "./values.js";

type PortInfo = { protocol: string; visibility: DataVisibility; conditional: boolean; guard?: ValueBinding; repeated?: boolean };
type ResourceInfo = { definition: ResourceBinding; path: string; inUnit: boolean };

export function compileWorkflow(document: WorkflowDocument, catalog: WorkflowCatalog, sources: Record<string, string> = {}): WorkflowPlan {
  const implementations: Record<string, string> = {};
  const outputPorts: WorkflowPlan["outputs"] = {};
  const ports = new Map<string, PortInfo>();
  for (const key of Object.keys(document.inputs)) {
    const declaration = document.inputProtocols[key];
    ports.set(`inputs.${key}`, { protocol: declaration?.protocol ?? "arsi.json/v1", visibility: declaration?.visibility ?? "public", conditional: false });
  }

  function reference(binding: ValueBinding, available: Map<string, PortInfo>, path: string): PortInfo {
    if ("value" in binding) return { protocol: "arsi.json/v1", visibility: "public", conditional: false };
    const parts = binding.ref.split(".");
    for (let size = parts.length; size > 0; size--) {
      const found = available.get(parts.slice(0, size).join("."));
      if (found) return size === parts.length ? found : { ...found, protocol: "arsi.json/v1" };
    }
    throw new TypeError(`${path} references unavailable output ${binding.ref}; bind an earlier compatible output`);
  }

  function connect(binding: ValueBinding, port: WorkflowPort, available: Map<string, PortInfo>, path: string, guard?: ValueBinding) {
    const source = reference(binding, available, path);
    if ("value" in binding) port.validate(binding.value);
    else if (source.protocol !== port.protocol && port.protocol !== "arsi.json/v1" && source.protocol !== "arsi.json/v1")
      throw new TypeError(`${path}: ${source.protocol} cannot supply ${port.protocol}; add an explicit conversion`);
    if (source.visibility === "private" && port.visibility !== "private") throw new TypeError(`${path} cannot expose private material to a public input`);
    const sameGuard = source.guard !== undefined && guard !== undefined && workflowDigest(source.guard) === workflowDigest(guard);
    if (source.conditional && !port.optional && !sameGuard) throw new TypeError(`${path} must explicitly handle a skipped or failed producer`);
  }

  function checkResources(bindings: Record<string, string>, required: Record<string, WorkflowResourceRequirement>,
    available: Map<string, ResourceInfo>, values: Map<string, PortInfo>, path: string, inUnit: boolean, ancestors: string[] = [], remote = false) {
    for (const key of Object.keys(bindings)) if (!required[key]) throw new TypeError(`${path}: undeclared resource input ${key}`);
    for (const [key, requirement] of Object.entries(required)) {
      const name = bindings[key];
      if (name === undefined && requirement.optional) continue;
      const info = name === undefined ? undefined : available.get(name);
      if (!info) throw new TypeError(`${path}.resources.${key}: missing resource ${name ?? key}`);
      if (ancestors.includes(info.path)) throw new TypeError(`${path}: resource dependency cycle ${[...ancestors, info.path].join(" -> ")}`);
      if (remote && (info.definition.scope === "run" || info.definition.scope === "block" && !info.inUnit))
        throw new TypeError(`${info.path}: remote units cannot use coordinator-owned resources; declare worker or attempt scope`);
      const provider = catalog.resource(info.definition.use);
      if (inUnit && (info.definition.scope === "run" || info.definition.scope === "worker" || info.definition.scope === "block" && !info.inUnit) && provider.sharing !== "shared")
        throw new TypeError(`${info.path}: independent samples require an attempt-scoped resource; ${provider.type} does not declare safe sharing`);
      implementations[`resource:${provider.type}`] = provider.version;
      if (!provider.capabilities.includes(requirement.capability)) throw new TypeError(`${path}.resources.${key} requires ${requirement.capability}`);
      for (const [field, binding] of Object.entries(info.definition.config)) {
        const input = reference(binding, values, `${info.path}.config.${field}`);
        if (input.visibility === "private") throw new TypeError(`${info.path}: private inputs cannot be passed through resource configuration`);
        if ((info.definition.scope === "run" || info.definition.scope === "worker") && input.repeated) throw new TypeError(`${info.path}: ${info.definition.scope}-scoped configuration cannot vary between iterations`);
      }
      if (Object.values(info.definition.config).every(binding => "value" in binding)) {
        provider.validateConfig(Object.fromEntries(Object.entries(info.definition.config).map(([field, binding]) =>
          [field, "value" in binding ? binding.value : null])));
      }
      for (const dependency of Object.values(info.definition.resources)) {
        const target = available.get(dependency);
        if (target) {
          const lifetime = { run: 0, worker: 1, attempt: 2, block: 3, step: 4 };
          if (lifetime[target.definition.scope] > lifetime[info.definition.scope]) throw new TypeError(`${info.path}: resource cannot outlive dependency ${dependency}`);
        }
      }
      checkResources(info.definition.resources, provider.resources, available, values, info.path, inUnit, [...ancestors, info.path], remote);
    }
  }

  function visit(body: WorkflowBlock, inherited: Map<string, PortInfo>, inheritedResources: Map<string, ResourceInfo>, path: string,
    inUnit: boolean, repeated = false, remote = false): Map<string, PortInfo> {
    const available = new Map(inherited);
    const resources = new Map(inheritedResources);
    for (const [key, definition] of Object.entries(body.resources)) {
      if (inUnit && definition.scope === "worker") throw new TypeError(`${path}: declare worker resources outside independent units`);
      if (resources.has(key)) throw new TypeError(`${path}: resource ${key} shadows an enclosing resource`);
      resources.set(key, { definition, path: `${path}.resources.${key}`, inUnit });
      const provider = catalog.resource(definition.use);
      implementations[`resource:${provider.type}`] = provider.version;
      if (Object.values(definition.config).every(binding => "value" in binding))
        provider.validateConfig(Object.fromEntries(Object.entries(definition.config).map(([field, binding]) => [field, "value" in binding ? binding.value : null])));
    }
    const ids = new Set<string>();
    for (const node of body.steps) {
      if (ids.has(node.id) || ["inputs", "variant", "repetition", "unit"].includes(node.id)) throw new TypeError(`${path}: duplicate or reserved step id ${node.id}`);
      ids.add(node.id);
      const at = `${path}.${node.id}`;
      if (node.when) connect(node.when, { protocol: "arsi.boolean/v1", validate(value) {
        if (typeof value !== "boolean") throw new TypeError(`${at}.when must be boolean`);
        return value;
      } }, available, `${at}.when`);
      const conditional = node.when !== undefined || node.onError === "continue";
      if (node.kind === "step") {
        const step = catalog.step(node.use);
        implementations[`step:${step.type}`] = step.version;
        workflowValue(step.validateConfig(node.config), `${at}.config`);
        for (const key of Object.keys(node.inputs)) if (!step.inputs[key]) throw new TypeError(`${at}: undeclared input ${key}`);
        for (const [key, port] of Object.entries(step.inputs)) {
          const binding = node.inputs[key];
          if (!binding) { if (!port.optional) throw new TypeError(`${at}.inputs.${key} is required`); }
          else connect(binding, port, available, `${at}.inputs.${key}`, node.when);
        }
        checkResources(node.resources, step.resources, resources, available, at, inUnit, [], remote);
        for (const [key, port] of Object.entries(step.outputs)) available.set(`${node.id}.outputs.${key}`,
          { protocol: port.protocol, visibility: port.visibility ?? "public", conditional: conditional || port.optional === true, repeated,
            ...(node.when && node.onError !== "continue" && !port.optional ? { guard: node.when } : {}) });
      } else {
        const child = new Map(available);
        if (node.kind === "forEach") {
          if (node.executor) checkResources({ executor: node.executor }, { executor: { capability: "workflow.executor/v1" } }, resources, available, at, inUnit);
          if (node.retry) checkResources({ retry: node.retry.policy }, { retry: { capability: "workflow.retry/v1" } }, resources, available, at, inUnit);
          if (node.admission) checkResources({ admission: node.admission }, { admission: { capability: "workflow.admission/v1" } }, resources, available, at, inUnit);
          const collection = reference(node.items, available, `${at}.items`);
          if (inUnit && node.mode === "units") throw new TypeError(`${at}: independent units cannot be nested within an attempt`);
          if (["inputs", "variant", "repetition", "unit"].includes(node.as) || [...available.keys()].some(key => key === node.as || key.startsWith(node.as + ".")))
            throw new TypeError(`${at}: iteration name ${node.as} shadows an enclosing value`);
          child.set(node.as, { ...collection, protocol: "arsi.json/v1", repeated: true });
          if (node.mode === "units") {
            child.set("variant", { protocol: "arsi.json/v1", visibility: "public", conditional: false, repeated: true });
            child.set("repetition", { protocol: "arsi.number/v1", visibility: "public", conditional: false, repeated: true });
          }
        }
        const childOutputs = visit(node.body, child, resources, at, inUnit || node.kind === "forEach" && node.mode === "units", repeated || node.kind === "forEach", remote || node.kind === "forEach" && node.executor !== undefined);
        if (node.kind === "forEach") {
          if (node.stopWhen) reference(node.stopWhen, childOutputs, `${at}.stopWhen`);
          const privateOutput = [...childOutputs.values()].some(port => port.visibility === "private");
          available.set(`${node.id}.outputs.results`, { protocol: "arsi.execution-results/v1", visibility: privateOutput ? "private" : "public", conditional });
        } else for (const [key, value] of childOutputs) available.set(`${node.id}.outputs.${key}`, { ...value, conditional: conditional || value.conditional });
      }
    }
    const outputs = new Map<string, PortInfo>();
    for (const [key, binding] of Object.entries(body.outputs)) outputs.set(key, reference(binding, available, `${path}.outputs.${key}`));
    for (const name of body.required) if (!outputs.has(name)) throw new TypeError(`${path}: missing required output ${name}`);
    outputPorts[path] = Object.fromEntries([...outputs].map(([key, port]) => [key, { protocol: port.protocol, visibility: port.visibility }]));
    return outputs;
  }

  visit(document.workflow, ports, new Map(), "workflow", false);
  return { schemaVersion: 2, document: structuredClone(document), implementations, sources: { ...sources }, outputs: outputPorts,
    fingerprint: workflowDigest({ document, implementations, sources, outputs: outputPorts }) };
}
