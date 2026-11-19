import type { AttemptKey } from "../../core/contracts/result.js";
import { expectNonEmptyString, expectPositiveNumber, expectRecord, rejectUnknown } from "../../core/validation/input.js";
import { transferId } from "../transfer/protocol.js";

/** Ray receives routing metadata only. The authenticated collector supplies the assignment. */
export type WorkflowRemoteJob = {
  schemaVersion: 3;
  kind: "workflow";
  action: "execute" | "recover";
  job: AttemptKey;
  nodeId: string;
  uploadEndpoint: string;
  safeConfig: { timeoutSeconds: number };
};
export function parseWorkflowRemoteJob(value: unknown): WorkflowRemoteJob {
  const row = expectRecord(value, "workflow Ray job");
  rejectUnknown(row, ["schemaVersion", "kind", "action", "job", "nodeId", "uploadEndpoint", "safeConfig"], "workflow Ray job");
  if (row.schemaVersion !== 3 || row.kind !== "workflow" || row.action !== "execute" && row.action !== "recover") throw new TypeError("Invalid workflow Ray action");
  const key = expectRecord(row.job, "workflow Ray identity");
  rejectUnknown(key, ["runId", "taskId", "attemptId"], "workflow Ray identity");
  const endpoint = new URL(expectNonEmptyString(row.uploadEndpoint, "workflow collector"));
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== "/")
    throw new TypeError("Workflow collector must be an HTTPS origin without credentials");
  const config = expectRecord(row.safeConfig, "workflow Ray limits");
  rejectUnknown(config, ["timeoutSeconds"], "workflow Ray limits");
  return { schemaVersion: 3, kind: "workflow", action: row.action,
    job: { runId: transferId(key.runId), attemptId: transferId(key.attemptId), taskId: expectNonEmptyString(key.taskId, "case ID") },
    nodeId: expectNonEmptyString(row.nodeId, "workflow Ray node"), uploadEndpoint: endpoint.origin,
    safeConfig: { timeoutSeconds: expectPositiveNumber(config.timeoutSeconds, "workflow Ray timeout") } };
}
