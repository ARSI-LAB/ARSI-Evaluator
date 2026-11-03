import type { JsonValue } from "../core/contracts/task.js";

const SECRET_KEY = /(?:api[-_]?key|authorization|password|secret|token)/i;

function redactPullProxy(value: JsonValue): JsonValue {
  if (typeof value !== "string") return "[redacted]";
  try {
    const url = new URL(value);
    return url.username || url.password ? "[redacted]" : value;
  } catch { return "[redacted]"; }
}

export function redactSecrets(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (value === null || typeof value !== "object") return value;

  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, key === "pullProxy" ? redactPullProxy(item) : SECRET_KEY.test(key) ? "[redacted]" : redactSecrets(item)]),
  );
}

/** Configuration budgets and environment-variable names are public, never credential values. */
export function redactConfig(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(redactConfig);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    const publicField = key === "maxTokens" && typeof item === "number" ||
      /Env$/u.test(key) && typeof item === "string" && /^[A-Za-z_]\w*$/u.test(item);
    if (publicField) return [key, item];
    if (key === "pullProxy") return [key, redactPullProxy(item)];
    if (SECRET_KEY.test(key)) return [key, "[redacted]"];
    return [key, redactConfig(item)];
  }));
}
