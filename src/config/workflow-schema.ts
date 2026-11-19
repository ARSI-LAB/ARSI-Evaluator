import type {
  ResourceBinding, ValueBinding, WorkflowBindings, WorkflowBlock, WorkflowDocument, WorkflowNode, WorkflowObject,
} from "../core/contracts/workflow.js";
import { expectNonEmptyString, expectPositiveInteger, expectPositiveNumber, expectRecord, rejectUnknown } from "../core/validation/input.js";
import { workflowObject, workflowValue } from "../core/workflow/values.js";

function name(value: unknown, path: string): string {
  const result = expectNonEmptyString(value, path);
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(result)) throw new TypeError(`${path} must be a simple identifier`);
  return result;
}

export function parseWorkflowBinding(value: unknown, path: string): ValueBinding {
  const record = expectRecord(value, path);
  if (Object.hasOwn(record, "ref")) {
    rejectUnknown(record, ["ref"], path);
    const ref = expectNonEmptyString(record.ref, `${path}.ref`);
    if (!/^[A-Za-z][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)*$/.test(ref)) throw new TypeError(`${path}.ref is invalid`);
    if (ref.split(".").some(part => ["__proto__", "prototype", "constructor"].includes(part))) throw new TypeError(`${path}.ref is unsafe`);
    return { ref };
  }
  rejectUnknown(record, ["value"], path);
  return { value: workflowValue(record.value, `${path}.value`) };
}

function bindings(value: unknown, path: string): WorkflowBindings {
  return Object.fromEntries(Object.entries(expectRecord(value ?? {}, path)).map(([key, item]) =>
    [name(key, `${path} key`), parseWorkflowBinding(item, `${path}.${key}`)]));
}

function resources(value: unknown, path: string): Record<string, string> {
  return Object.fromEntries(Object.entries(expectRecord(value ?? {}, path)).map(([key, item]) =>
    [name(key, `${path} key`), name(item, `${path}.${key}`)]));
}

function resourceDefinitions(value: unknown, path: string): Record<string, ResourceBinding> {
  return Object.fromEntries(Object.entries(expectRecord(value ?? {}, path)).map(([key, item]) => {
    name(key, `${path} key`);
    const record = expectRecord(item, `${path}.${key}`);
    rejectUnknown(record, ["use", "scope", "config", "resources"], `${path}.${key}`);
    const scope = record.scope ?? "block";
    if (scope !== "run" && scope !== "worker" && scope !== "attempt" && scope !== "block" && scope !== "step") throw new TypeError(`${path}.${key}.scope is invalid`);
    const config = Object.fromEntries(Object.entries(expectRecord(record.config ?? {}, `${path}.${key}.config`)).map(([field, entry]) => {
      if (entry && typeof entry === "object" && !Array.isArray(entry) &&
          (Object.hasOwn(entry, "ref") || Object.hasOwn(entry, "value") && Object.keys(entry).length === 1))
        return [field, parseWorkflowBinding(entry, `${path}.${key}.config.${field}`)];
      return [field, { value: workflowValue(entry, `${path}.${key}.config.${field}`) }];
    }));
    return [key, { use: expectNonEmptyString(record.use, `${path}.${key}.use`), scope, config,
      resources: resources(record.resources, `${path}.${key}.resources`) }];
  }));
}

function block(value: unknown, path: string, outerResources?: unknown): WorkflowBlock {
  const record = expectRecord(value, path);
  rejectUnknown(record, ["steps", "resources", "outputs", "required"], path);
  if (!Array.isArray(record.steps)) throw new TypeError(`${path}.steps must be an array`);
  if (outerResources !== undefined && record.resources !== undefined) throw new TypeError("Declare root resources only once");
  const outputs = bindings(record.outputs, `${path}.outputs`);
  const required = record.required ?? Object.keys(outputs);
  if (!Array.isArray(required) || required.some(item => typeof item !== "string" || !Object.hasOwn(outputs, item)))
    throw new TypeError(`${path}.required must name declared outputs`);
  return {
    steps: record.steps.map((entry, index) => node(entry, `${path}.steps[${index}]`)),
    resources: resourceDefinitions(outerResources ?? record.resources, `${path}.resources`), outputs,
    required: required.map(item => expectNonEmptyString(item, `${path}.required`)),
  };
}

function node(value: unknown, path: string): WorkflowNode {
  const record = expectRecord(value, path);
  const base = {
    id: name(record.id, `${path}.id`),
    ...(record.when === undefined ? {} : { when: parseWorkflowBinding(record.when, `${path}.when`) }),
    ...(record.timeoutSeconds === undefined ? {} : { timeoutSeconds: expectPositiveNumber(record.timeoutSeconds, `${path}.timeoutSeconds`) }),
  };
  if (record.onError !== undefined && record.onError !== "stop" && record.onError !== "continue") throw new TypeError(`${path}.onError is invalid`);
  const policy: { onError?: "stop" | "continue" } = record.onError === undefined ? {} : { onError: record.onError };
  const common = ["id", "when", "timeoutSeconds", "onError"];
  if (record.use !== undefined) {
    rejectUnknown(record, [...common, "use", "config", "inputs", "resources"], path);
    return { ...base, ...policy, kind: "step", use: expectNonEmptyString(record.use, `${path}.use`),
      config: workflowObject(record.config ?? {}, `${path}.config`), inputs: bindings(record.inputs, `${path}.inputs`),
      resources: resources(record.resources, `${path}.resources`) };
  }
  rejectUnknown(record, [...common, "steps", "resources", "outputs", "required", "forEach"], path);
  const body = block(Object.fromEntries(["steps", "resources", "outputs", "required"].filter(key => record[key] !== undefined)
    .map(key => [key, record[key]])), path);
  if (record.forEach === undefined) return { ...base, ...policy, kind: "sequence", body };
  const each = expectRecord(record.forEach, `${path}.forEach`);
  rejectUnknown(each, ["items", "as", "mode", "concurrency", "matrix", "stopWhen", "admission", "executor", "retry"], `${path}.forEach`);
  const mode = each.mode ?? "sequence";
  if (mode !== "units" && mode !== "sequence") throw new TypeError(`${path}.forEach.mode is invalid`);
  const concurrency = expectPositiveInteger(each.concurrency ?? 1, `${path}.forEach.concurrency`);
  if (mode === "sequence" && concurrency !== 1) throw new TypeError(`${path}: stateful iterations must be sequential`);
  const retry = each.retry === undefined ? undefined : expectRecord(each.retry, `${path}.forEach.retry`);
  if (retry) rejectUnknown(retry, ["policy", "maxAttempts"], `${path}.forEach.retry`);
  if (mode === "sequence" && retry) throw new TypeError(`${path}: automatic retry requires independent units`);
  if (mode === "sequence" && each.executor !== undefined) throw new TypeError(`${path}: dispatch requires independent units`);
  if (mode === "sequence" && each.admission !== undefined) throw new TypeError(`${path}: readiness admission requires independent units`);
  if (mode === "units" && each.stopWhen !== undefined) throw new TypeError(`${path}: stopWhen requires sequential iteration`);
  const matrix = expectRecord(each.matrix ?? {}, `${path}.forEach.matrix`);
  rejectUnknown(matrix, ["variants", "repetitions"], `${path}.forEach.matrix`);
  const variants = matrix.variants ?? [{ id: "default" }];
  if (!Array.isArray(variants) || !variants.length) throw new TypeError(`${path}: variants must be a nonempty array`);
  const seen = new Set<string>();
  const parsedVariants: WorkflowObject[] = variants.map(entry => {
    const variant = workflowObject(entry, `${path}.variant`);
    const id = name(variant.id, `${path}.variant.id`);
    if (seen.has(id)) throw new TypeError(`${path}: duplicate variant ${id}`);
    seen.add(id);
    return variant;
  });
  if (mode === "sequence" && each.matrix !== undefined) throw new TypeError(`${path}: matrix requires independent units`);
  return { ...base, ...policy, kind: "forEach", body, mode, concurrency,
    ...(each.executor === undefined ? {} : { executor: name(each.executor, `${path}.forEach.executor`) }),
    ...(retry ? { retry: { policy: name(retry.policy, `${path}.forEach.retry.policy`), maxAttempts: expectPositiveInteger(retry.maxAttempts, `${path}.forEach.retry.maxAttempts`) } } : {}),
    ...(each.admission === undefined ? {} : { admission: name(each.admission, `${path}.forEach.admission`) }),
    items: parseWorkflowBinding(each.items, `${path}.forEach.items`), as: name(each.as ?? "item", `${path}.forEach.as`),
    matrix: { variants: parsedVariants, repetitions: expectPositiveInteger(matrix.repetitions ?? 1, `${path}.matrix.repetitions`) },
    ...(each.stopWhen === undefined ? {} : { stopWhen: parseWorkflowBinding(each.stopWhen, `${path}.stopWhen`) }) };
}

export function parseWorkflowDocument(value: unknown): WorkflowDocument {
  const record = expectRecord(value, "workflow configuration");
  rejectUnknown(record, ["schemaVersion", "pathBase", "inputs", "inputProtocols", "resources", "workflow", "output", "run"], "workflow configuration");
  if (record.schemaVersion !== 2) throw new TypeError("Workflow configuration requires schemaVersion: 2");
  const run = expectRecord(record.run ?? {}, "run");
  rejectUnknown(run, ["timeoutSeconds", "cleanupTimeoutSeconds", "onError"], "run");
  if (run.onError !== undefined && run.onError !== "stop" && run.onError !== "continue") throw new TypeError("run.onError is invalid");
  const output = expectRecord(record.output ?? {}, "output");
  rejectUnknown(output, ["directory"], "output");
  const inputProtocols: WorkflowDocument["inputProtocols"] = {};
  for (const [key, item] of Object.entries(expectRecord(record.inputProtocols ?? {}, "inputProtocols"))) {
    const port = expectRecord(item, `inputProtocols.${key}`);
    rejectUnknown(port, ["protocol", "visibility"], `inputProtocols.${key}`);
    if (port.visibility !== undefined && port.visibility !== "public" && port.visibility !== "private") throw new TypeError(`inputProtocols.${key}.visibility is invalid`);
    inputProtocols[name(key, "input protocol")] = { protocol: expectNonEmptyString(port.protocol, `inputProtocols.${key}.protocol`), visibility: port.visibility ?? "public" };
  }
  return { schemaVersion: 2, inputs: workflowObject(record.inputs ?? {}, "inputs"), inputProtocols,
    ...(record.pathBase === undefined ? {} : { pathBase: expectNonEmptyString(record.pathBase, "pathBase") }),
    workflow: block(record.workflow, "workflow", record.resources),
    output: { directory: expectNonEmptyString(output.directory ?? "results", "output.directory") },
    run: { timeoutSeconds: expectPositiveNumber(run.timeoutSeconds ?? 3600, "run.timeoutSeconds"),
      cleanupTimeoutSeconds: expectPositiveNumber(run.cleanupTimeoutSeconds ?? 60, "run.cleanupTimeoutSeconds"), onError: run.onError ?? "stop" } };
}

/** Export the expanded plan as editable input, without compiler-only kind/body fields. */
export function workflowConfiguration(document: WorkflowDocument): WorkflowObject {
  function writeBlock(value: WorkflowBlock): WorkflowObject {
    return { resources: workflowObject(value.resources), outputs: workflowObject(value.outputs), required: value.required,
      steps: value.steps.map(node => {
        const common = { id: node.id, ...(node.when ? { when: node.when } : {}), ...(node.onError ? { onError: node.onError } : {}),
          ...(node.timeoutSeconds === undefined ? {} : { timeoutSeconds: node.timeoutSeconds }) };
        if (node.kind === "step") return workflowObject({ ...common, use: node.use, inputs: node.inputs, config: node.config, resources: node.resources });
        const body = writeBlock(node.body);
        if (node.kind === "sequence") return { ...common, ...body };
        return workflowObject({ ...common, ...body, forEach: { items: node.items, as: node.as, mode: node.mode, concurrency: node.concurrency,
          ...(node.executor === undefined ? {} : { executor: node.executor }),
          ...(node.retry === undefined ? {} : { retry: node.retry }),
          ...(node.admission === undefined ? {} : { admission: node.admission }),
          ...(node.mode === "units" ? { matrix: node.matrix } : {}), ...(node.stopWhen ? { stopWhen: node.stopWhen } : {}) } });
      }) };
  }
  return { schemaVersion: 2, ...(document.pathBase === undefined ? {} : { pathBase: document.pathBase }), inputs: document.inputs, inputProtocols: workflowObject(document.inputProtocols),
    workflow: writeBlock(document.workflow), output: document.output, run: document.run };
}

/** Validate normalized persisted plans through the same field checks as editable YAML. */
export function parseCompiledWorkflowDocument(value: unknown): WorkflowDocument {
  const document = expectRecord(value, "compiled workflow document");
  function editableBlock(value: unknown): Record<string, unknown> {
    const block = expectRecord(value, "compiled block");
    if (!Array.isArray(block.steps)) throw new TypeError("Compiled block requires steps");
    return { ...block, steps: block.steps.map(value => {
      const node = expectRecord(value, "compiled node");
      const { kind, body, ...rest } = node;
      if (kind === "step") { if (body !== undefined) throw new TypeError("Step cannot have a body"); return rest; }
      if (kind === "sequence") return { ...rest, ...editableBlock(body) };
      if (kind !== "forEach") throw new TypeError("Unknown compiled node kind");
      const { items, as, mode, concurrency, matrix, stopWhen, admission, executor, retry, ...base } = rest;
      return { ...base, ...editableBlock(body), forEach: { items, as, mode, concurrency,
        ...(executor === undefined ? {} : { executor }),
        ...(retry === undefined ? {} : { retry }),
        ...(admission === undefined ? {} : { admission }),
        ...(mode === "units" ? { matrix } : {}), ...(stopWhen === undefined ? {} : { stopWhen }) } };
    }) };
  }
  return parseWorkflowDocument({ ...document, workflow: editableBlock(document.workflow) });
}
