import type { WorkflowMaintenanceOutcome, WorkflowMaintenanceRequest } from "../contracts/workflow.js";
import { expectNonEmptyString, expectRecord, rejectUnknown } from "../validation/input.js";
import { workflowObject } from "./values.js";

export type WorkflowMaintenanceResult = { path: string; provider: string } &
  (WorkflowMaintenanceOutcome | { status: "deferred" | "not-required" });

export function parseMaintenanceRequest(value: unknown): WorkflowMaintenanceRequest {
  const item = expectRecord(value, "maintenance request");
  rejectUnknown(item, ["operation", "options"], "maintenance request");
  const operation = expectNonEmptyString(item.operation, "maintenance operation");
  if (!/^[a-z][a-z0-9.-]*$/.test(operation)) throw new TypeError("Invalid maintenance operation");
  return { operation, options: workflowObject(item.options) };
}

export function parseMaintenanceOutcome(value: unknown): WorkflowMaintenanceOutcome {
  const item = expectRecord(value, "maintenance outcome");
  rejectUnknown(item, ["status", "output", "summary", "details"], "maintenance outcome");
  if (item.status !== "passed" && item.status !== "failed" && item.status !== "incomplete") throw new TypeError("Invalid maintenance status");
  if (item.summary !== undefined && typeof item.summary !== "string") throw new TypeError("Invalid maintenance summary");
  if (item.details !== undefined && (!Array.isArray(item.details) || item.details.some(line => typeof line !== "string")))
    throw new TypeError("Invalid maintenance details");
  return { status: item.status, output: workflowObject(item.output),
    ...(item.summary === undefined ? {} : { summary: item.summary }),
    ...(item.details === undefined ? {} : { details: item.details as string[] }) };
}

export function parseMaintenanceResults(value: unknown): WorkflowMaintenanceResult[] {
  if (!Array.isArray(value)) throw new TypeError("Invalid maintenance results");
  return value.map(value => {
    const item = expectRecord(value, "maintenance result");
    rejectUnknown(item, ["path", "provider", "status", "output", "summary", "details"], "maintenance result");
    const identity = { path: expectNonEmptyString(item.path, "maintenance path"), provider: expectNonEmptyString(item.provider, "maintenance provider") };
    if (item.status === "deferred" || item.status === "not-required") {
      if (item.output !== undefined || item.summary !== undefined || item.details !== undefined) throw new TypeError("Unexecuted maintenance cannot have output");
      return { ...identity, status: item.status };
    }
    return { ...identity, ...parseMaintenanceOutcome({ status: item.status, output: item.output,
      ...(item.summary === undefined ? {} : { summary: item.summary }), ...(item.details === undefined ? {} : { details: item.details }) }) };
  });
}
