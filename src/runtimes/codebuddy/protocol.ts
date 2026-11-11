import type { ProcessHandle } from "../../core/contracts/environment.js";
import type { SolveResult } from "../../core/contracts/result.js";
import type { AttemptContext } from "../../core/contracts/solver.js";
import { classifyError } from "../../core/errors/classify.js";
import { redactDiagnostic } from "../../core/errors/diagnostics.js";
import { EvaluatorError } from "../../core/errors/evaluator-error.js";
import { consumeCliJsonl, record, tokenCount, type CliEvent } from "../shared/cli-jsonl.js";

export function consumeCodeBuddy(handle: ProcessHandle, context: AttemptContext, secrets: readonly string[]): Promise<SolveResult> {
  let result: CliEvent | undefined;
  return consumeCliJsonl(handle, context, secrets, {
    solver: "codebuddy",
    label: "CodeBuddy Code",
    accept(event) {
      if (event.type === "evaluator.config_error" && typeof event.message === "string") {
        throw new EvaluatorError("BENCHMARK_UNSUPPORTED", redactDiagnostic(event.message, secrets));
      }
      if (event.type === "assistant" || event.type === "user" || event.type === "stream_event") context.activity?.({});
      if (event.type !== "result") return;
      if (result) throw new EvaluatorError("SOLVER_PROTOCOL_INVALID", "CodeBuddy emitted multiple result events");
      result = event;
    },
    finish(exit, stderr) {
      const failedResult = result !== undefined && (result.is_error !== false || result.subtype !== "success");
      if (exit.code !== 0 || exit.signal !== null || failedResult) {
        const errors = Array.isArray(result?.errors) ? result.errors.filter(item => typeof item === "string").join("\n") : "";
        const resultText = typeof result?.result === "string" ? result.result : "";
        const diagnostic = redactDiagnostic(errors || resultText || stderr || `CodeBuddy exited with code ${exit.code} and signal ${exit.signal}`, secrets);
        const status = tokenCount(result?.api_error_status);
        const failure = classifyError(Object.assign(new Error(diagnostic), status === null ? {} : { status }), {
          phase: "solve", component: "codebuddy", fallbackCode: failedResult ? "SOLVER_RESULT_INCOMPLETE" : "SOLVER_PROCESS_CRASHED",
        });
        throw new EvaluatorError(failure.code, failure.message, failure.details);
      }
      if (!result) throw new EvaluatorError("SOLVER_RESULT_INCOMPLETE", "CodeBuddy exited without a result event");
      if (typeof result.result !== "string") throw new EvaluatorError("SOLVER_PROTOCOL_INVALID", "CodeBuddy result is missing its final text");
      const usage = record(result.usage);
      const inputTokens = tokenCount(usage?.input_tokens);
      const outputTokens = tokenCount(usage?.output_tokens);
      // Both OpenAI protocols report cached input as a subset of the aggregate count.
      const totalTokens = inputTokens === null || outputTokens === null ? null : tokenCount(inputTokens + outputTokens);
      return { finalText: result.result, usage: { inputTokens, outputTokens, totalTokens } };
    },
  });
}
