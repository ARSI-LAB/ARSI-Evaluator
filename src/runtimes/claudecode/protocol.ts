import type { ProcessHandle } from "../../core/contracts/environment.js";
import type { SolveResult, Usage } from "../../core/contracts/result.js";
import type { AttemptContext } from "../../core/contracts/solver.js";
import type { JsonValue } from "../../core/contracts/task.js";
import { classifyError } from "../../core/errors/classify.js";
import { redactDiagnostic } from "../../core/errors/diagnostics.js";
import { EvaluatorError } from "../../core/errors/evaluator-error.js";
import { consumeCliJsonl, record, tokenCount, type CliEvent } from "../shared/cli-jsonl.js";

function usageFrom(value: JsonValue | undefined): Usage {
  const usage = record(value);
  const input = tokenCount(usage?.input_tokens);
  const cached = usage?.cache_read_input_tokens == null ? 0 : tokenCount(usage.cache_read_input_tokens);
  const written = usage?.cache_creation_input_tokens == null ? 0 : tokenCount(usage.cache_creation_input_tokens);
  const inputTokens = input === null || cached === null || written === null ? null : tokenCount(input + cached + written);
  const outputTokens = tokenCount(usage?.output_tokens);
  const totalTokens = inputTokens === null || outputTokens === null ? null : tokenCount(inputTokens + outputTokens);
  return { inputTokens, outputTokens, totalTokens };
}

export function consumeClaudeCode(handle: ProcessHandle, context: AttemptContext, secret: string): Promise<SolveResult> {
  let result: CliEvent | undefined;
  return consumeCliJsonl(handle, context, [secret], {
    solver: "claudecode",
    label: "Claude Code",
    accept(event) {
      if (event.type === "assistant" || event.type === "user") context.activity?.({});
      if (event.type !== "result") return;
      if (result) throw new EvaluatorError("SOLVER_PROTOCOL_INVALID", "Claude Code emitted multiple result events");
      result = event;
    },
    finish(exit, stderr) {
      if (exit.code !== 0 || exit.signal !== null || (result && (result.is_error !== false || result.subtype !== "success"))) {
        const errors = Array.isArray(result?.errors) ? result.errors.filter(item => typeof item === "string").join("\n") : "";
        const resultText = typeof result?.result === "string" ? result.result : "";
        const diagnostic = redactDiagnostic(errors || resultText || stderr || `Claude Code exited with code ${exit.code} and signal ${exit.signal}`, [secret]);
        const status = tokenCount(result?.api_error_status);
        const failure = classifyError(Object.assign(new Error(diagnostic), status === null ? {} : { status }), {
          phase: "solve", component: "claudecode", fallbackCode: result?.is_error ? "SOLVER_RESULT_INCOMPLETE" : "SOLVER_PROCESS_CRASHED",
        });
        throw new EvaluatorError(failure.code, failure.message, failure.details);
      }
      if (!result) throw new EvaluatorError("SOLVER_RESULT_INCOMPLETE", "Claude Code exited without a result event");
      if (typeof result.result !== "string") throw new EvaluatorError("SOLVER_PROTOCOL_INVALID", "Claude Code result is missing its final text");
      return { finalText: result.result, usage: usageFrom(result.usage) };
    },
  });
}
