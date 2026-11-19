import { createHash } from "node:crypto";
import type { JsonValue } from "../contracts/task.js";
import type { ValueBinding, WorkflowObject, WorkflowPort } from "../contracts/workflow.js";

/** Reject live handles, non-finite numbers and cycles before they reach persistence. */
export function workflowValue(value: unknown, path = "value", parents = new Set<object>()): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "object" || value === null) throw new TypeError(`${path} must be serializable JSON`);
  if (parents.has(value)) throw new TypeError(`${path} contains a cycle`);
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
    throw new TypeError(`${path} contains a live object`);
  parents.add(value);
  try {
    if (Array.isArray(value)) return value.map((item, index) => workflowValue(item, `${path}[${index}]`, parents));
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, workflowValue(item, `${path}.${key}`, parents)]));
  } finally { parents.delete(value); }
}

export function workflowObject(value: unknown, path = "value"): WorkflowObject {
  const parsed = workflowValue(value, path);
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") throw new TypeError(`${path} must be an object`);
  return parsed;
}

export function stableWorkflowJson(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(stableWorkflowJson).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableWorkflowJson(value[key] ?? null)}`).join(",")}}`;
  return JSON.stringify(value);
}

export function workflowDigest(value: unknown): string {
  return createHash("sha256").update(stableWorkflowJson(workflowValue(value))).digest("hex");
}

export class MissingWorkflowInput extends Error {
  readonly code = "WORKFLOW_INPUT_UNAVAILABLE";
}

export function resolveBinding(binding: ValueBinding, values: ReadonlyMap<string, JsonValue>): JsonValue {
  if ("value" in binding) return structuredClone(binding.value);
  const parts = binding.ref.split(".");
  // Longest prefix wins, permitting scoped names without a mutable global context.
  for (let size = parts.length; size > 0; size--) {
    const key = parts.slice(0, size).join(".");
    if (!values.has(key)) continue;
    let value = values.get(key);
    for (const field of parts.slice(size)) {
      if (value === null || typeof value !== "object" || !Object.hasOwn(value, field)) { value = undefined; break; }
      value = Array.isArray(value) ? value[Number(field)] : value[field];
    }
    if (value !== undefined) return structuredClone(value);
  }
  throw new MissingWorkflowInput(`Input reference ${binding.ref} has no committed value`);
}

export const jsonPort = (protocol = "arsi.json/v1"): WorkflowPort => ({ protocol, validate: workflowValue });
export const textPort = (protocol = "arsi.text/v1"): WorkflowPort => ({ protocol, validate(value) {
  if (typeof value !== "string") throw new TypeError("Expected a string");
  return value;
} });
export const booleanPort = (): WorkflowPort => ({ protocol: "arsi.boolean/v1", validate(value) {
  if (typeof value !== "boolean") throw new TypeError("Expected a boolean");
  return value;
} });
