import type { JsonValue } from "../contracts/task.js";

/** Incomplete verification evidence, never a legal score or correctness judgment. */
export class VerificationError extends Error {
  constructor(message: string, readonly evidence: JsonValue, options?: ErrorOptions) {
    super(message, options);
    this.name = "VerificationError";
  }
}
