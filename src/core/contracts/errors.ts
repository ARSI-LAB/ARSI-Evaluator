export type ErrorCategory = "configuration" | "data" | "infrastructure" | "solver" | "model" | "verifier" | "scheduler" | "storage" | "cleanup" | "network";
export type ErrorScope = "request" | "attempt" | "node" | "run" | "resource";
/** retry_attempt describes historical records only; current errors never emit it. */
export type ErrorAction = "retry_attempt" | "abort_run" | "stop_dispatch" | "finalize";
export type ErrorDetails = {
  networkStage?: string;
  networkReason?: string;
  networkEvidence?: string;
  component?: string;
  operation?: string;
  originalCode?: string;
  originalName?: string;
  exitCode?: number;
  signal?: string;
  httpStatus?: number;
  retryAfterMs?: number;
  service?: string;
  containerId?: string;
  logPath?: string;
  assetPath?: string;
  requestedCpus?: number;
  availableCpus?: number;
  cpusetCpus?: string;
};
export type ErrorCause = { code?: string; name?: string; message: string };
export type ErrorMetadata = {
  schemaVersion: 1;
  category: ErrorCategory;
  scope: ErrorScope;
  severity: "error" | "warning" | "info";
  retryable: boolean;
  action: ErrorAction;
  hint: string;
  details: ErrorDetails;
  causes: ErrorCause[];
};
