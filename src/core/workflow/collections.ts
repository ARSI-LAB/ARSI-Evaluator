import type { WorkflowArtifact, WorkflowArtifacts, WorkflowCollection, WorkflowPort } from "../contracts/workflow.js";
import type { JsonValue } from "../contracts/task.js";
import { workflowObject, workflowValue } from "./values.js";

export function workflowCollection(value: unknown): WorkflowCollection {
  const row = workflowObject(value, "collection");
  const file = workflowObject(row.artifact, "collection artifact");
  if (row.kind !== "collection" || typeof row.count !== "number" || !Number.isSafeInteger(row.count) || row.count < 0)
    throw new TypeError("Invalid collection count");
  if (file.protocol !== "arsi.collection-jsonl/v1" || file.mediaType !== "application/x-ndjson" || file.complete !== true ||
      typeof file.size !== "number" || !Number.isSafeInteger(file.size) || file.size < 0 ||
      file.visibility !== "public" && file.visibility !== "private") throw new TypeError("Invalid collection artifact metadata");
  for (const field of ["id", "path", "sha256", "producer"] as const)
    if (typeof file[field] !== "string" || !file[field]) throw new TypeError(`Invalid collection artifact ${field}`);
  return { kind: "collection", count: row.count, artifact: file as WorkflowArtifact };
}

export function collectionPort(): WorkflowPort {
  return { protocol: "arsi.collection/v1", validate: value => workflowValue(workflowCollection(value)) };
}

export async function readWorkflowCollection(value: JsonValue, artifacts: Pick<WorkflowArtifacts, "read">): Promise<JsonValue[]> {
  if (Array.isArray(value)) return value;
  const collection = workflowCollection(value);
  const content = new TextDecoder("utf-8", { fatal: true }).decode(await artifacts.read(collection.artifact));
  const rows = content.split(/\r?\n/).filter(line => line.trim()).map((line, index) => {
    try { return workflowValue(JSON.parse(line)); }
    catch (cause) { throw new TypeError(`Invalid collection row ${index + 1}`, { cause }); }
  });
  if (rows.length !== collection.count) throw new TypeError("Collection row count differs from its manifest");
  return rows;
}
