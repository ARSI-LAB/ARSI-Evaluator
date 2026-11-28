import type { JsonValue } from "./task.js";
import type { ProgressEvent } from "../progress/progress.js";

export type WorkflowObject = { [key: string]: JsonValue };
export type ValueBinding = { ref: string } | { value: JsonValue };
export type WorkflowBindings = Record<string, ValueBinding>;
export type DataVisibility = "public" | "private";

export interface WorkflowPort {
  protocol: string;
  optional?: boolean;
  visibility?: DataVisibility;
  validate(value: unknown): JsonValue;
}

export type ResourceBinding = {
  use: string;
  scope: "run" | "worker" | "attempt" | "block" | "step";
  config: WorkflowBindings;
  resources: Record<string, string>;
};

export type WorkflowResourceRequirement = { capability: string; optional?: boolean };
export type WorkflowEffect = "pure" | "read" | "isolated-write" | "external-write";

export type WorkflowArtifact = {
  id: string;
  path: string;
  mediaType: string;
  protocol: string;
  sha256: string;
  size: number;
  visibility: DataVisibility;
  producer: string;
  complete: boolean;
};

export interface WorkflowArtifacts {
  write(name: string, content: string | Uint8Array, options: {
    mediaType: string; protocol: string; visibility?: DataVisibility; complete?: boolean;
  }): Promise<WorkflowArtifact>;
  read(artifact: WorkflowArtifact): Promise<Uint8Array>;
}

export type ExecutionUnitIdentity = { caseId: string; variantId: string; repetition: number };
/** Pull-based readiness: a slot requests the next identity only when it can start work. */
export interface WorkflowAdmission {
  /** A background prerequisite failed. Abort active units and report a block failure, not user cancellation. */
  failureSignal?: AbortSignal;
  /** Stable business inputs for reuse; exclude transient preparation receipts and placement. */
  reuseInputs?(unit: ExecutionUnitIdentity): Promise<WorkflowObject>;
  /** Recover committed results after cleanup, before repeating an interrupted unit. */
  reconcile?(unit: Readonly<WorkflowUnitRecord>, block: Readonly<WorkflowBlock>,
    context: Pick<WorkflowContext, "signal" | "artifacts" | "log">): Promise<WorkflowObject | undefined>;
  order(units: readonly ExecutionUnitIdentity[], signal: AbortSignal): AsyncIterable<ExecutionUnitIdentity>;
}
export interface WorkflowRetryPolicy {
  shouldRetry(attempt: ExecutionUnitIdentity & { attemptId: string; ordinal: number; errors: readonly WorkflowFailure[] }, signal: AbortSignal): Promise<boolean>;
}
export interface WorkflowUnitExecutor {
  /** Refresh transient dispatch inputs before validation and the durable recovery receipt. */
  prepare?(request: WorkflowUnitRequest, context: Pick<WorkflowContext, "signal" | "artifacts" | "log">): Promise<Pick<WorkflowUnitRequest, "bindings" | "nodeId"> | void>;
  /** Credential-free recovery receipt, persisted before dispatch starts. */
  recoveryIdentity(request: WorkflowUnitRequest): WorkflowObject;
  execute(request: WorkflowUnitRequest, host: {
    signal: AbortSignal;
    store: WorkflowStore;
    log(message: string, progress?: ProgressEvent): void;
  }): Promise<WorkflowRunRecord>;
}
/** Local diagnostic metadata. Never part of a portable plan or worker request. */
export type WorkflowConfigurationOrigins = {
  configurationFile: string;
  patchFile?: string;
  resourceFiles: Readonly<Record<string, string>>;
};

export type WorkflowContext = {
  /** Locked implementation metadata; null only for standalone component factories. */
  plan: { readonly fingerprint: string; readonly sources: Readonly<Record<string, string>>;
    readonly implementations: Readonly<Record<string, string>> } | null;
  workerId: string;
  runId: string;
  attemptId: string;
  path: string;
  signal: AbortSignal;
  unit: ExecutionUnitIdentity | null;
  artifacts: WorkflowArtifacts;
  runtime: {
    /** Local workspace for this execution placement; never persist as an output reference. */
    directory: string;
    origins?: WorkflowConfigurationOrigins;
    resolvePath(path: string): string;
    credential(name: string): Promise<string | undefined>;
  };
  resource(name: string): unknown;
  log(message: string, progress?: ProgressEvent): void;
};

export interface StepDefinition {
  type: string;
  version: string;
  apiVersion: 1;
  inputs: Record<string, WorkflowPort>;
  outputs: Record<string, WorkflowPort>;
  resources: Record<string, WorkflowResourceRequirement>;
  effects: WorkflowEffect;
  /** External writes are never replayed unless the plugin guarantees idempotency. */
  replay?: "safe" | "manual";
  validateConfig(value: unknown): WorkflowObject;
  execute(inputs: Readonly<WorkflowObject>, config: Readonly<WorkflowObject>, context: WorkflowContext): Promise<WorkflowObject>;
  /** Read-only source checks, including completed resumes. Cannot allocate resources or publish artifacts. */
  validateResume?(outputs: Readonly<WorkflowObject>, config: Readonly<WorkflowObject>,
    context: Pick<WorkflowContext, "runId" | "path" | "signal" | "runtime">): Promise<void>;
  /** Offline rendering only. No runtime resources, credential resolver, or evaluation execution. */
  report?: {
    dependencies?(config: Readonly<WorkflowObject>): readonly string[];
    rebuild(config: Readonly<WorkflowObject>, context: WorkflowReportContext): Promise<string | WorkflowReportDocument>;
  };
}

/** UTF-8 report attachments; paths are relative references used by the Markdown. */
export type WorkflowReportDocument = { markdown: string; files: Record<string, string> };

export type WorkflowReportContext = {
  record: Readonly<WorkflowRunRecord>;
  directory: string;
  configDirectory: string;
  path: string;
  signal: AbortSignal;
  /** A successful in-workflow render may be read directly during automatic finalization. */
  reuse: boolean;
  artifacts: Pick<WorkflowArtifacts, "read">;
  log(message: string, progress?: ProgressEvent): void;
};

export type WorkflowCollection = { kind: "collection"; artifact: WorkflowArtifact; count: number };

export interface WorkflowResource {
  value: unknown;
  /** Serializable, credential-free identity used for interrupted-run cleanup. */
  identity: WorkflowObject;
  dispose?(signal: AbortSignal): Promise<void>;
}

export type WorkflowResourceContext = WorkflowContext & {
  /** Binding name in this process; absent when a provider is invoked directly. */
  binding?: string;
  /** Persist credential-free ownership before making an external allocation. */
  checkpoint(identity: WorkflowObject): Promise<void>;
};

export type WorkflowMaintenanceRequest = { operation: string; options: WorkflowObject };
export type WorkflowMaintenanceOutcome = {
  status: "passed" | "failed" | "incomplete";
  output: WorkflowObject;
  summary?: string;
  details?: string[];
};
export interface WorkflowMaintenanceOperation {
  /** Resource ports needed by this operation; omit evaluation-only dependencies. */
  resources: readonly string[];
  credentials?(config: Readonly<WorkflowObject>): readonly string[];
  validateRequest(value: unknown): WorkflowObject;
  execute(config: Readonly<WorkflowObject>, request: Readonly<WorkflowObject>, context: WorkflowContext): Promise<WorkflowMaintenanceOutcome>;
}

export interface ResourceProvider {
  type: string;
  version: string;
  apiVersion: 1;
  capabilities: readonly string[];
  /** Names only; evaluated from locked configuration before remote dispatch. */
  credentials?(config: Readonly<WorkflowObject>): readonly string[];
  /** Explicitly permit independent samples to use one instance without sharing evaluation state. */
  sharing?: "shared";
  /** Allows dependency clients, never evaluation state, to be opened by warmup or maintenance. */
  availableDuringMaintenance?: boolean;
  maintenance?: Readonly<Record<string, WorkflowMaintenanceOperation>>;
  /** Rules for resolving resource configuration on another execution host. */
  configTransport?: import("./config-transport.js").PluginConfigTransport;
  resources: Record<string, WorkflowResourceRequirement>;
  validateConfig(value: unknown): WorkflowObject;
  create(config: Readonly<WorkflowObject>, context: WorkflowResourceContext): Promise<WorkflowResource>;
  recover?(identity: Readonly<WorkflowObject>, context: WorkflowContext): Promise<void>;
  /** Check pinned source/runtime identities without starting a new evaluation attempt. */
  validateResume?(identity: Readonly<WorkflowObject>, context: WorkflowContext): Promise<void>;
  /** Dependency materialization only: no evaluation state or model calls. */
  warmup?(config: Readonly<WorkflowObject>, context: WorkflowContext): Promise<WorkflowMaintenanceOutcome | void>;
}

type WorkflowNodeBase = { id: string; when?: ValueBinding; onError?: "stop" | "continue"; timeoutSeconds?: number };
export type WorkflowStep = WorkflowNodeBase & {
  kind: "step"; use: string; config: WorkflowObject; inputs: WorkflowBindings; resources: Record<string, string>;
};
export type WorkflowSequence = WorkflowNodeBase & { kind: "sequence"; body: WorkflowBlock };
export type WorkflowForEach = WorkflowNodeBase & {
  kind: "forEach";
  items: ValueBinding;
  as: string;
  mode: "units" | "sequence";
  concurrency: number;
  admission?: string;
  executor?: string;
  retry?: { policy: string; maxAttempts: number };
  matrix: { variants: WorkflowObject[]; repetitions: number };
  stopWhen?: ValueBinding;
  body: WorkflowBlock;
};
export type WorkflowNode = WorkflowStep | WorkflowSequence | WorkflowForEach;
export type WorkflowBlock = {
  resources: Record<string, ResourceBinding>;
  steps: WorkflowNode[];
  outputs: WorkflowBindings;
  /** Required named outputs, not an implicit requirement for a numeric score. */
  required: string[];
};

export type WorkflowDocument = {
  schemaVersion: 2;
  pathBase?: string;
  inputs: WorkflowObject;
  inputProtocols: Record<string, { protocol: string; visibility: DataVisibility }>;
  workflow: WorkflowBlock;
  output: { directory: string };
  run: { timeoutSeconds: number; cleanupTimeoutSeconds: number; onError: "stop" | "continue" };
};

export interface WorkflowTemplate {
  type: string;
  version: string;
  apiVersion: 1;
  example?: WorkflowObject;
  /** Optional shortcuts interpreted by the template, before expansion. Never receives credential values. */
  overrideParameters?(parameters: Readonly<WorkflowObject>, overrides: Readonly<WorkflowObject>): WorkflowObject;
  expand(parameters: Readonly<WorkflowObject>): unknown;
}

export interface WorkflowCatalog {
  step(type: string): StepDefinition;
  resource(type: string): ResourceProvider;
  template(type: string): WorkflowTemplate;
}

export type WorkflowPlan = {
  schemaVersion: 2;
  document: WorkflowDocument;
  implementations: Record<string, string>;
  sources: Record<string, string>;
  outputs: Record<string, Record<string, { protocol: string; visibility: DataVisibility }>>;
  fingerprint: string;
};

/** JSON-only dispatch. Resource instances and credentials stay on their execution host. */
export type WorkflowUnitRequest = {
  /** Optional execution placement selected by a preparation plugin. */
  nodeId?: string;
  /** Check all transmitted bindings independently from the business-input reuse identity. */
  dispatchFingerprint: string;
  plan: WorkflowPlan;
  runId: string;
  blockPath: string;
  path: string;
  bindings: WorkflowObject;
  unit: WorkflowUnitRecord;
};

export type WorkflowFailure = { path: string; code: string; message: string };
export type WorkflowNodeStatus = "running" | "completed" | "failed" | "cancelled" | "blocked" | "skipped";
export type WorkflowEvent = { path: string; status: WorkflowNodeStatus; message: string; progress?: ProgressEvent };
export type StepRunRecord = {
  path: string; attemptId: string; plugin: string; status: WorkflowNodeStatus;
  startedAt: string; finishedAt: string | null; outputs: WorkflowObject; errors: WorkflowFailure[];
};
export type WorkflowResourceRecord = {
  key: string; binding: string; provider: string; attemptId: string;
  dependencies: string[];
  /** Remote allocations are reclaimed through this persisted dispatch owner. */
  owner?: string;
  identity: WorkflowObject; state: "pending" | "creating" | "active" | "released" | "unconfirmed";
};
export type WorkflowUnitRecord = ExecutionUnitIdentity & {
  key: string; inputFingerprint: string; attemptId: string; ordinal: number; status: "running" | "completed" | "failed" | "cancelled";
  cleanupStatus: "cleaned" | "unconfirmed"; outputs: WorkflowObject; errors: WorkflowFailure[];
};
export type WorkflowRunRecord = {
  schemaVersion: 2; runId: string; fingerprint: string; implementations: Record<string, string>;
  startedAt: string; finishedAt: string | null; status: "running" | "completed" | "failed" | "cancelled";
  businessComplete: boolean;
  outputs: WorkflowObject; units: WorkflowUnitRecord[]; steps: StepRunRecord[];
  resources: WorkflowResourceRecord[]; artifacts: WorkflowArtifact[]; errors: WorkflowFailure[];
};

/** Persistence is a kernel capability; user steps cannot remove it. */
export interface WorkflowStore {
  save(record: WorkflowRunRecord): Promise<void>;
  artifacts(producer: string): WorkflowArtifacts;
}

export type WorkflowExecutorOptions = {
  signal: AbortSignal;
  store: WorkflowStore;
  previous?: WorkflowRunRecord;
  /** Retry only selected failed units; unselected failures remain visible in results. */
  retryUnitKeys?: readonly string[];
  retryController?: import("./retry-control.js").RetryController;
  runId?: string;
  secrets?: readonly string[];
  runtime?: WorkflowContext["runtime"];
  onEvent?: (event: WorkflowEvent) => void;
};
