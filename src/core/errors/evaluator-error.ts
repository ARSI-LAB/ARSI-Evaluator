import type { ErrorDetails } from "../contracts/errors.js";
import type { ErrorCode } from "./registry.js";

/** Plugin-safe exception. Only whitelisted details are serialized at the boundary. */
export class EvaluatorError extends Error {
  constructor(readonly code: ErrorCode, message: string,
    readonly details: ErrorDetails = {}, options?: ErrorOptions) {
    super(message, options);
    this.name = "EvaluatorError";
  }
}
