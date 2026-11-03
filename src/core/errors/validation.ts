import { ERROR_CODES, isErrorCode } from "./registry.js";

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
/** Current writes and remote messages always require the complete error contract. */
export function validFailureMetadata(value: Record<string, unknown>): boolean {
  const metadata = ["schemaVersion", "category", "scope", "severity", "retryable", "action", "hint", "details", "causes"];
  if (value.schemaVersion !== 1 || !isErrorCode(value.code)) return false;
  if (Object.keys(value).some(key => !["phase", "code", "message", ...metadata].includes(key)) ||
    typeof value.message !== "string" || value.message.length > 2048) return false;
  const definition = ERROR_CODES[value.code];
  if (value.category !== definition.category || value.scope !== definition.scope || value.action !== definition.action || value.retryable !== false ||
    !["info", "warning", "error"].includes(String(value.severity)) || typeof value.hint !== "string" || !object(value.details) ||
    !Array.isArray(value.causes) || value.causes.length > 15) return false;
  for (const [key, field] of Object.entries(value.details)) {
    if (["component", "operation", "originalCode", "originalName", "signal", "service", "containerId", "logPath", "assetPath", "cpusetCpus", "networkStage", "networkReason", "networkEvidence"].includes(key)) {
      if (typeof field !== "string" || field.length > 2048) return false;
    } else if (["exitCode", "httpStatus", "retryAfterMs"].includes(key)) {
      if (typeof field !== "number" || !Number.isSafeInteger(field) ||
        (key !== "exitCode" && (field < 0 || field > (key === "httpStatus" ? 599 : 86_400_000)))) return false;
    } else if (["requestedCpus", "availableCpus"].includes(key)) {
      if (typeof field !== "number" || !Number.isFinite(field) || field < 0 || field > 65_536 ||
        (key === "availableCpus" && !Number.isSafeInteger(field))) return false;
    } else return false;
  }
  return value.causes.every(cause => object(cause) && typeof cause.message === "string" && cause.message.length <= 2048 &&
    Object.entries(cause).every(([key, field]) => ["code", "name", "message"].includes(key) && typeof field === "string" && field.length <= 2048));
}
