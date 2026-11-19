import type { WorkflowArtifact, WorkflowRunRecord, WorkflowUnitRecord } from "../contracts/workflow.js";
import { workflowObject } from "./values.js";
import { expectNonEmptyString, expectPositiveInteger } from "../validation/input.js";
import { evidencePath } from "../artifacts/artifacts.js";

export function parseWorkflowRun(value: unknown): WorkflowRunRecord {
  const row = workflowObject(value);
  if (typeof row.startedAt !== "string" || (row.finishedAt !== null && typeof row.finishedAt !== "string") ||
      !["running", "completed", "failed", "cancelled"].includes(String(row.status))) throw new TypeError("Invalid workflow run status");
  if (row.schemaVersion !== 2 || typeof row.businessComplete !== "boolean") throw new TypeError("Invalid workflow record version or completion");
  const implementations = Object.fromEntries(Object.entries(workflowObject(row.implementations))
    .map(([key, version]) => [key, expectNonEmptyString(version, `implementations.${key}`)]));
  return {
    schemaVersion: 2, businessComplete: row.businessComplete,
    runId: expectNonEmptyString(row.runId, "runId"), fingerprint: expectNonEmptyString(row.fingerprint, "fingerprint"), implementations,
    startedAt: row.startedAt, finishedAt: row.finishedAt,
    status: enumValue(row.status, ["running", "completed", "failed", "cancelled"] as const),
    outputs: workflowObject(row.outputs), errors: array(row.errors).map(workflowFailure),
    artifacts: array(row.artifacts).map(artifactReference),
    units: array(row.units).map(parseWorkflowUnitRecord),
    steps: array(row.steps).map(value => {
      const item = workflowObject(value);
      if (item.finishedAt !== null && typeof item.finishedAt !== "string") throw new TypeError("Invalid step finishedAt");
      return { path: expectNonEmptyString(item.path, "step.path"), attemptId: expectNonEmptyString(item.attemptId, "step.attemptId"),
        plugin: expectNonEmptyString(item.plugin, "step.plugin"), status: enumValue(item.status, ["running", "completed", "failed", "cancelled", "blocked", "skipped"] as const),
        startedAt: expectNonEmptyString(item.startedAt, "step.startedAt"), finishedAt: item.finishedAt,
        outputs: workflowObject(item.outputs), errors: array(item.errors).map(workflowFailure) };
    }),
    resources: array(row.resources).map(value => {
      const item = workflowObject(value);
      return { key: expectNonEmptyString(item.key, "resource.key"), binding: expectNonEmptyString(item.binding, "resource.binding"),
        provider: expectNonEmptyString(item.provider, "resource.provider"), attemptId: expectNonEmptyString(item.attemptId, "resource.attemptId"),
        dependencies: array(item.dependencies).map(key => expectNonEmptyString(key, "resource dependency")),
        ...(item.owner === undefined ? {} : { owner: expectNonEmptyString(item.owner, "resource.owner") }),
        identity: workflowObject(item.identity), state: enumValue(item.state, ["pending", "creating", "active", "released", "unconfirmed"] as const) };
    }),
  };
}

function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new TypeError("Expected a record array");
  return value;
}

function enumValue<T extends string>(value: unknown, choices: readonly T[]): T {
  const result = choices.find(choice => choice === value);
  if (result === undefined) throw new TypeError(`Expected one of ${choices.join(", ")}`);
  return result;
}

export function artifactReference(value: unknown): WorkflowArtifact {
  const row = workflowObject(value, "artifact");
  for (const key of ["id", "path", "mediaType", "protocol", "sha256", "producer"])
    if (typeof row[key] !== "string") throw new TypeError(`artifact.${key} must be a string`);
  if (typeof row.size !== "number" || !Number.isSafeInteger(row.size) || row.size < 0 || typeof row.complete !== "boolean" ||
      row.visibility !== "public" && row.visibility !== "private") throw new TypeError("Invalid artifact metadata");
  if (typeof row.path !== "string" || !row.path.startsWith("artifacts/") || evidencePath(row.path) !== row.path ||
      typeof row.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(row.sha256)) throw new TypeError("Invalid artifact path or digest");
  return { id: expectNonEmptyString(row.id, "artifact.id"), path: expectNonEmptyString(row.path, "artifact.path"),
    mediaType: expectNonEmptyString(row.mediaType, "artifact.mediaType"), protocol: expectNonEmptyString(row.protocol, "artifact.protocol"),
    sha256: expectNonEmptyString(row.sha256, "artifact.sha256"), producer: expectNonEmptyString(row.producer, "artifact.producer"),
    size: row.size, complete: row.complete, visibility: row.visibility };
}

export function validateRecordConsistency(record: WorkflowRunRecord): void {
  if (!/^[a-f0-9]{64}$/.test(record.fingerprint)) throw new TypeError("Invalid workflow fingerprint");
  const unique = (values: string[], label: string) => { if (new Set(values).size !== values.length) throw new TypeError(`Duplicate ${label} in workflow record`); };
  unique(record.artifacts.map(artifact => artifact.id), "artifact ID");
  unique(record.artifacts.map(artifact => artifact.path), "artifact path");
  unique(record.units.map(unit => `${unit.key}:${unit.ordinal}`), "attempt ordinal");
  unique(record.units.map(unit => unit.attemptId), "unit attempt ID");
  unique(record.steps.map(step => `${step.attemptId}:${step.path}`), "step execution");
  unique(record.resources.map(resource => `${resource.attemptId}:${resource.key}`), "resource allocation");
  for (const date of [record.startedAt, record.finishedAt, ...record.steps.flatMap(step => [step.startedAt, step.finishedAt])])
    if (date !== null && !Number.isFinite(Date.parse(date))) throw new TypeError("Invalid workflow timestamp");
  const latest = new Map(record.units.map(unit => [unit.key, unit]));
  if (record.businessComplete && [...latest.values()].some(unit => unit.status !== "completed")) throw new TypeError("Committed workflow contains unfinished units");
  if (record.status === "completed" && (!record.businessComplete || record.resources.some(resource => resource.state !== "released")))
    throw new TypeError("Completed workflow has missing results or unreleased resources");
}

export function parseWorkflowUnitRecord(value: unknown): WorkflowUnitRecord {
  const item = workflowObject(value);
  if (typeof item.repetition !== "number" || !Number.isSafeInteger(item.repetition) || item.repetition < 0) throw new TypeError("Invalid repetition");
  return { caseId: expectNonEmptyString(item.caseId, "caseId"), variantId: expectNonEmptyString(item.variantId, "variantId"),
    repetition: item.repetition, key: expectNonEmptyString(item.key, "unit.key"), attemptId: expectNonEmptyString(item.attemptId, "unit.attemptId"),
    inputFingerprint: expectNonEmptyString(item.inputFingerprint, "unit.inputFingerprint"),
    ordinal: expectPositiveInteger(item.ordinal, "unit.ordinal"), status: enumValue(item.status, ["running", "completed", "failed", "cancelled"] as const),
    cleanupStatus: enumValue(item.cleanupStatus, ["cleaned", "unconfirmed"] as const), outputs: workflowObject(item.outputs), errors: array(item.errors).map(workflowFailure) };
}

function workflowFailure(value: unknown) {
  const item = workflowObject(value);
  return { path: expectNonEmptyString(item.path, "failure.path"), code: expectNonEmptyString(item.code, "failure.code"),
    message: typeof item.message === "string" ? item.message : expectNonEmptyString(item.message, "failure.message") };
}
