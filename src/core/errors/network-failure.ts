export type NetworkStage = "docker-pull" | "docker-build" | "model-api" | "dataset" | "verifier" | "scheduler";
export type NetworkEvidence = {
  networkStage: NetworkStage;
  networkReason: string;
  networkEvidence: string;
  httpStatus?: number;
  retryAfterMs?: number;
};

function own(value: unknown, key: string): unknown {
  return value !== null && typeof value === "object" ? Object.getOwnPropertyDescriptor(value, key)?.value : undefined;
}

/** Called only at a failed operation boundary, never against prompts or successful tool output. */
export function identifyNetworkFailure(values: readonly unknown[], context: {
  phase: string; component?: string; operation?: string;
}): NetworkEvidence | null {
  if (["cleanup", "collect", "store", "transfer"].includes(context.phase)) return null;
  const details = values.map(value => own(value, "details"));
  const codes = values.map(value => own(value, "code")).filter((value): value is string => typeof value === "string");
  const names = values.map(value => own(value, "name")).filter((value): value is string => typeof value === "string");
  const messages = values.map(value => own(value, "message")).filter((value): value is string => typeof value === "string");
  const diagnostic = messages.join("\n").split("\n")
    .filter(line => !/^\s*(?:#\d+\s+(?:\d+(?:\.\d+)?\s+)?)?(?:RUN|CMD|COPY)\b/u.test(line) && !/^\s*(?:>>>|\$) /u.test(line) && !/^\s*\d+\s*\|/u.test(line) && !/did not complete successfully|failed to solve: process/u.test(line)).join("\n");
  if (codes.some(code => ["ENV_PREPARATION_TIMEOUT", "VERIFY_TIMEOUT", "SOLVER_AGENT_TIMEOUT", "RUN_CANCELLED", "SOURCE_CHANGED", "RAY_HEARTBEAT_TIMEOUT",
    "ENV_ARCH_UNSUPPORTED", "ENV_RESOURCE_REQUIREMENTS_UNMET", "STORE_WRITE_FAILED", "RAY_PROTOCOL_INVALID", "CLEANUP_FAILED", "CONFIG_INVALID", "SOLVER_OUTPUT_LIMIT", "MODEL_CONTEXT_LIMIT", "MODEL_REQUEST_INVALID", "MODEL_QUOTA_EXHAUSTED", "MODEL_AUTH_FAILED", "SOLVER_PROCESS_CRASHED", "SOLVER_PROTOCOL_INVALID"].includes(code))) return null;
  const permanentDiagnostic = [...codes, ...names, diagnostic].join("\n");
  if (/quota|insufficient_credit|billing|unauthorized|forbidden|authentication|PermissionDeniedError|BadRequestError|invalid.?api.?key|CONTEXT_WINDOW_EXCEEDED|SOLVER_OUTPUT_LIMIT|no matching manifest|exec format error|manifest unknown|not found|ResolutionImpossible|dependency conflict|no space left on device|cannot allocate memory|context[_ ]length[_ ]exceeded|invalid model parameter/iu.test(permanentDiagnostic)) return null;
  const status = [...values, ...details].map(value => own(value, "status") ?? own(value, "statusCode") ?? own(value, "httpStatus"))
    .find((value): value is number => typeof value === "number") ?? Number(/(?:HTTP(?: Error)?\s*|status(?: code)?[=: ]+|returned error:\s*)([45]\d\d)\b/iu.exec(diagnostic)?.[1]);
  if ([400, 401, 403, 404, 410, 413, 422, 501, 505].includes(status)) return null;
  const declaredStage = details.map(value => own(value, "networkStage")).find(value => typeof value === "string");
  const operation = context.operation ?? details.map(value => own(value, "operation")).find(value => typeof value === "string");
  let stage = declaredStage ?? null;
  if (stage === null) {
    if (["source", "task-source"].includes(context.component ?? "")) stage = "dataset";
    else if (context.component === "scheduler") stage = "scheduler";
    else if (operation === "pull") stage = "docker-pull";
    else if (operation === "build" || context.phase === "install") stage = "docker-build";
    else if (context.phase === "verify") stage = "verifier";
    else if (context.phase === "solve" || context.component === "model") stage = "model-api";
  }
  if (!["docker-pull", "docker-build", "model-api", "dataset", "verifier", "scheduler"].includes(String(stage))) return null;
  if (stage === "verifier" && !declaredStage && context.component !== "model") {
    if (/localhost|127\.0\.0\.1|\[::1\]/iu.test(diagnostic) ||
        !/\bpip\b|\bapt(?:-get)?\b|\bnpm\b|git clone|https?:\/\//iu.test(diagnostic)) return null;
  }
  if (stage === "verifier" && /AssertionError|(?:^|\n)\s*(?:assert |FAILED )/mu.test(diagnostic)) return null;
  if (/SyntaxError|ModuleNotFoundError|undefined reference|fatal error:|make:.*Error|npm (?:ERR!|error) (?:code )?ERESOLVE/iu.test(diagnostic)) return null;
  const evidence = [...codes, ...names, diagnostic,
    ...details.map(value => own(value, "networkEvidence")).filter(value => typeof value === "string")].join("\n");
  let reason: string | undefined;
  if (/\b(?:EAI_AGAIN|ENOTFOUND|NameResolutionError)\b|Could not resolve|Temporary failure in name resolution/iu.test(evidence)) reason = "dns";
  else if (/\b(?:ECONNRESET|EPIPE|UND_ERR_SOCKET|UND_ERR_RES_CONTENT_LENGTH_MISMATCH|ServerDisconnectedError|TransferEncodingError)\b|connection reset|socket hang up|Response payload is not completed|unexpected EOF|APIConnectionError/iu.test(evidence)) reason = "connection-interrupted";
  else if (/\b(?:ECONNREFUSED|ENETUNREACH|EHOSTUNREACH)\b|Failed to establish a new connection|Failed to connect to .* port/iu.test(evidence)) reason = "connection-failed";
  else if (/\b(?:ETIMEDOUT|ESOCKETTIMEDOUT|UND_ERR_CONNECT_TIMEOUT|UND_ERR_HEADERS_TIMEOUT|UND_ERR_BODY_TIMEOUT|ReadTimeout|ConnectTimeout|APITimeoutError|APIConnectionTimeoutError)\b|Read timed out|TLS handshake timeout|dial tcp.*i\/o timeout|curl: \(28\)|(?:pi-ai stream|dataset stream) idle timeout|Client\.Timeout exceeded|(?:Get|Head) "https?:[^\n]+context deadline exceeded|lookup [^\n]+i\/o timeout|Connection timed out \[IP:/iu.test(evidence)) reason = "transport-timeout";
  else if ([408, 500, 502, 503, 504].includes(status)) reason = "http-transient";
  else if (status === 429 || (stage === "model-api" && /\bRateLimitError\b/iu.test(evidence))) reason = "rate-limit";
  if (!reason) return null;
  const retryAfter = [...values, ...details].map(value => own(value, "retryAfterMs")).find((value): value is number =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 86_400_000);
  // Store the recognized signal, not arbitrary command output or credential-bearing URLs.
  const marker = reason === "http-transient" || reason === "rate-limit" ? (Number.isInteger(status) ? `HTTP ${status}` : "RateLimitError")
    : evidence.match(/\b(?:EAI_AGAIN|ENOTFOUND|NameResolutionError|ECONNRESET|EPIPE|UND_ERR_SOCKET|UND_ERR_RES_CONTENT_LENGTH_MISMATCH|ServerDisconnectedError|TransferEncodingError|ECONNREFUSED|ENETUNREACH|EHOSTUNREACH|APIConnectionError|ETIMEDOUT|ESOCKETTIMEDOUT|UND_ERR_\w+|ReadTimeout|ConnectTimeout|APITimeoutError|APIConnectionTimeoutError)\b/iu)?.[0]
      ?? diagnostic.split("\n").find(line => /Could not resolve|Temporary failure|connection reset|socket hang up|Read timed out|TLS handshake timeout|dial tcp|curl: \(28\)|(?:pi-ai stream|dataset stream) idle timeout|Client\.Timeout exceeded|context deadline exceeded|i\/o timeout|Connection timed out|unexpected EOF|Failed to connect|Failed to establish/iu.test(line))?.slice(0, 512);
  if (!marker) return null;
  return { networkStage: stage as NetworkStage, networkReason: reason, networkEvidence: marker,
    ...(Number.isInteger(status) && status > 0 ? { httpStatus: status } : {}),
    ...(retryAfter === undefined ? {} : { retryAfterMs: retryAfter }) };
}
