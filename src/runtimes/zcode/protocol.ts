import type { ProcessHandle } from "../../core/contracts/environment.js";
import type { SolveResult } from "../../core/contracts/result.js";
import type { AttemptContext } from "../../core/contracts/solver.js";
import { classifyError } from "../../core/errors/classify.js";
import { redactDiagnostic } from "../../core/errors/diagnostics.js";
import { EvaluatorError } from "../../core/errors/evaluator-error.js";
import { consumeCliJsonl, record, tokenCount, type CliEvent } from "../shared/cli-jsonl.js";

export function consumeZCode(handle: ProcessHandle, context: AttemptContext, secrets: readonly string[]): Promise<SolveResult> {
  let terminal: "success" | "failed" | undefined;
  let diagnostic = "";
  let result: CliEvent | undefined;
  return consumeCliJsonl(handle, context, secrets, {
    solver: "zcode",
    label: "ZCode",
    accept(event) {
      if (result !== undefined) throw new EvaluatorError("SOLVER_PROTOCOL_INVALID", "ZCode emitted an event after its result");
      if (event.type === "result") {
        result = event;
        return;
      }
      if (/^(?:turn|model|tool)\./u.test(event.type)) context.activity?.({});
      if (event.type === "turn.completed" || event.type === "turn.failed") {
        if (terminal !== undefined) throw new EvaluatorError("SOLVER_PROTOCOL_INVALID", "ZCode emitted multiple terminal turn events");
        const payload = record(event.payload);
        terminal = event.type === "turn.completed" && payload?.resultType === "success" ? "success" : "failed";
        const message = record(payload?.error)?.message ?? payload?.message;
        if (typeof message === "string") diagnostic = redactDiagnostic(message, secrets);
      }
    },
    finish(exit, stderr) {
      if (terminal === "failed" || exit.code !== 0 || exit.signal !== null) {
        const fallbackCode = terminal === "failed" ? "SOLVER_RESULT_INCOMPLETE" : "SOLVER_PROCESS_CRASHED";
        const failure = classifyError(new Error(diagnostic || stderr || "ZCode did not complete its turn"), {
          phase: "solve", component: "zcode", fallbackCode,
        });
        throw new EvaluatorError(failure.code, failure.message, failure.details);
      }
      if (terminal !== "success" || !result) {
        throw new EvaluatorError("SOLVER_RESULT_INCOMPLETE", "ZCode exited without a successful turn and result");
      }
      if (typeof result.response !== "string") {
        throw new EvaluatorError("SOLVER_PROTOCOL_INVALID", "ZCode result is missing its response");
      }
      const usage = record(result.usage);
      return { finalText: result.response, usage: {
        inputTokens: tokenCount(usage?.inputTokens), outputTokens: tokenCount(usage?.outputTokens),
        totalTokens: tokenCount(usage?.totalTokens),
      } };
    },
  });
}
