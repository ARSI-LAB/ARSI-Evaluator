import type { ProcessHandle } from "../../core/contracts/environment.js";
import type { SolveResult, Usage } from "../../core/contracts/result.js";
import type { AttemptContext } from "../../core/contracts/solver.js";
import type { JsonValue } from "../../core/contracts/task.js";
import { classifyError } from "../../core/errors/classify.js";
import { redactDiagnostic } from "../../core/errors/diagnostics.js";
import { EvaluatorError } from "../../core/errors/evaluator-error.js";
import { consumeCliJsonl, record, tokenCount } from "../shared/cli-jsonl.js";

function usageFrom(value: JsonValue | undefined): Usage {
  const usage = record(value);
  const inputTokens = tokenCount(usage?.input_tokens);
  const outputTokens = tokenCount(usage?.output_tokens);
  const totalTokens = inputTokens === null || outputTokens === null ? null : tokenCount(inputTokens + outputTokens);
  return { inputTokens, outputTokens, totalTokens };
}

export function consumeTrae(handle: ProcessHandle, context: AttemptContext, secret: string): Promise<SolveResult> {
  let finalText: string | undefined;
  let terminal: "turn.completed" | "turn.failed" | undefined;
  let usage = usageFrom(undefined);
  let diagnostic = "";
  return consumeCliJsonl(handle, context, [secret], {
    solver: "trae",
    label: "TRAE CLI",
    accept(event) {
      const { type } = event;
      if (type === "turn.started" || type.startsWith("item.")) context.activity?.({});
      if (type === "item.completed" && terminal === undefined) {
        const item = record(event.item);
        if (item?.type === "agent_message" && typeof item.text === "string") finalText = item.text;
      }
      if (type === "error" || type === "turn.failed") {
        const message = record(event.error)?.message ?? event.message;
        if (typeof message === "string") diagnostic = redactDiagnostic(message, [secret]);
      }
      if (type === "turn.completed" || type === "turn.failed") {
        if (terminal !== undefined) throw new EvaluatorError("SOLVER_PROTOCOL_INVALID", "TRAE CLI emitted multiple terminal turn events");
        terminal = type;
        if (type === "turn.completed") usage = usageFrom(event.usage);
      }
    },
    finish(exit, stderr) {
      if (terminal === "turn.failed" || exit.code !== 0 || exit.signal !== null) {
        const message = diagnostic || stderr || `TRAE CLI exited with code ${exit.code} and signal ${exit.signal}`;
        const fallbackCode = terminal === "turn.failed" ? "SOLVER_RESULT_INCOMPLETE" : "SOLVER_PROCESS_CRASHED";
        const failure = classifyError(new Error(message), { phase: "solve", component: "trae", fallbackCode });
        throw new EvaluatorError(failure.code, failure.message, failure.details);
      }
      if (terminal !== "turn.completed" || finalText === undefined) {
        throw new EvaluatorError("SOLVER_RESULT_INCOMPLETE", "TRAE CLI exited without a completed turn and final message");
      }
      return { finalText, usage };
    },
  });
}
