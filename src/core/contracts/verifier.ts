import type { EnvironmentSession } from "./environment.js";
import type { JsonValue } from "./task.js";
import type { VerificationRuntime } from "./verification-runtime.js";

/** Private, node-local materials. Never passed to a Solver or serialized to Ray. */
export type VerificationTask = {
  id: string;
  taskDir: string;
  stepName?: string;
  datasetDir: string;
  workdir: string;
  /** Omitted means the caller's whole-attempt signal is the only time ceiling. */
  timeoutSeconds?: number;
  /** Task-declared upstream Python verifier, when the selected component supports it. */
  importPath?: string;
};

export type VerificationEvidence = {
  rewards: Record<string, number>;
  details: JsonValue;
};

export interface Verifier {
  readonly runtime?: VerificationRuntime<JsonValue, VerificationEvidence>;
  /** Inspect private materials without allocating execution resources. */
  prepare(task: VerificationTask, signal: AbortSignal): Promise<JsonValue>;
  verify(descriptor: JsonValue, session: EnvironmentSession, signal: AbortSignal): Promise<VerificationEvidence>;
}
