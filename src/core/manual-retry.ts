import type { AttemptRecord } from "./contracts/result.js";
import { identifyNetworkFailure } from "./errors/network-failure.js";
import { isEvaluationComplete, hasUnconfirmedCleanup } from "./evaluation-outcome.js";

/** Only an explicit retry request may rerun an eligible network failure. */
export function isManualRetryEligible(record: AttemptRecord): boolean {
  return record.verdict === null && !isEvaluationComplete(record) && !hasUnconfirmedCleanup(record) &&
    record.executionStatus !== "cancelled" && record.errors.some(failure => failure.code === "NETWORK_FAILURE" &&
      identifyNetworkFailure([{ code: failure.code, message: failure.message, details: failure.details }, ...(failure.causes ?? [])], { phase: failure.phase }) !== null) &&
    record.errors.every(failure => failure.code === "NETWORK_FAILURE");
}
