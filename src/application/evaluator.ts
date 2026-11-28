import { cleanupBenchmark, doctorBenchmark, type CleanupOptions, type DoctorOptions } from "./benchmark-maintenance.js";
import { join, resolve } from "node:path";
import { formatError, redactDiagnostic } from "../core/errors/diagnostics.js";
import type { ProgressListener } from "../core/progress/progress.js";
import { inspectWorkflow, runWorkflow, retryWorkflow, WorkflowRunError, type WorkflowOptions, type WorkflowRunResult } from "./workflow.js";
import { rebuildWorkflowReport } from "./workflow-report.js";
import { warmupWorkflow } from "./workflow-warmup.js";
import { maintainWorkflow } from "./workflow-maintenance.js";
import { safeProgress } from "../core/progress/live-progress.js";
import type { WorkflowRunRecord, WorkflowMaintenanceRequest } from "../core/contracts/workflow.js";

export type EvaluatorRunOptions = WorkflowOptions & { onProgress?: ProgressListener };
export type EvaluationResult = { kind: "workflow"; exitCode: number; runId: string; record: WorkflowRunRecord;
  runDirectory: string; reportPath: string | null };

/** A failed application operation, possibly with a persisted partial run. */
export class EvaluatorRunError extends Error {
  constructor(message: string, readonly phase: string, readonly exitCode: number,
    readonly result: EvaluationResult | null, options: ErrorOptions) {
    super(message, options);
    this.name = "EvaluatorRunError";
  }
}

function evaluationResult(value: WorkflowRunResult): EvaluationResult {
  return { kind: "workflow", exitCode: value.record.status === "completed" ? 0 : value.record.status === "cancelled" ? 130 : 1,
    runId: value.record.runId, record: value.record, runDirectory: value.directory,
    reportPath: join(value.directory, "report.md") };
}

/** Each call owns its registry and resources; instances hold no process-wide state. */
export class Evaluator {
  async run(options: EvaluatorRunOptions): Promise<EvaluationResult> {
    const env = options.env ?? process.env;
    const secrets = Object.entries(env).flatMap(([name, value]) => /(?:KEY|TOKEN|PASSWORD|SECRET)$/i.test(name) && value ? [value] : []);
    if (options.signal?.aborted) {
      const message = formatError(options.signal.reason, secrets);
      throw new EvaluatorRunError("Evaluation cancelled before start", "config", 130, null, { cause: new Error(message) });
    }
    const controller = new AbortController();
    const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
    let result: EvaluationResult | null = null, observerError: unknown, observerFailed = false;
    try {
      const evaluated = await runWorkflow({ ...options, signal, onEvent(event) {
        if (observerFailed) return;
        try {
          const safe = { ...event, message: redactDiagnostic(event.message, secrets),
            ...(event.progress ? { progress: safeProgress(event.progress, secrets) } : {}) };
          options.onEvent?.(safe);
          options.onProgress?.(safe.progress ?? { phase: "execute", message: `${safe.path}: ${safe.message}` });
        } catch (error) {
          observerFailed = true; observerError = error; controller.abort(error); throw error;
        }
      } });
      result = evaluationResult(evaluated);
      if (observerFailed) throw observerError;
      return result;
    } catch (error) {
      if (error instanceof WorkflowRunError && error.result) result = evaluationResult(error.result);
      const message = formatError(error, secrets);
      const phase = error instanceof WorkflowRunError ? error.phase : result ? "execute" : "config";
      throw new EvaluatorRunError(message, phase, options.signal?.aborted ? 130 : phase !== "config" || observerFailed ? 1 : 2, result, { cause: new Error(message) });
    }
  }

  doctor(options: DoctorOptions) { return doctorBenchmark(options); }
  cleanup(options: CleanupOptions) { return cleanupBenchmark(options); }
  report(runDirectory: string): Promise<string> { return rebuildWorkflowReport(resolve(runDirectory)); }
  inspect(options: Pick<WorkflowOptions, "configPath" | "patchPath" | "env" | "networkConfigPath" | "parameterOverrides">) { return inspectWorkflow(options); }
  warmup(options: WorkflowOptions) { return warmupWorkflow(options); }
  maintain(options: WorkflowOptions, request: WorkflowMaintenanceRequest) { return maintainWorkflow(options, request); }
  retry(directory: string, options?: Parameters<typeof retryWorkflow>[1]) { return retryWorkflow(directory, options); }
}
