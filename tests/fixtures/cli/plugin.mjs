import { writeFile } from "node:fs/promises";
import { join } from "node:path";

export const inject = ["evaluator"];
export function apply(ctx) {
  const config = value => value;
  ctx.evaluator.register("benchmark", "cli-fixture", config, options => ({
    async resolveSource() {
      if (options.mode === "python-file-error") throw new Error("FileNotFoundError: [Errno 2] No such file or directory: reward.json");
      if (options.mode === "source-error") throw new TypeError("fetch failed", {
        cause: Object.assign(new Error("connect ECONNRESET"), { code: "ECONNRESET" }),
      });
      return { source: "cli-fixture", revision: "fixed", files: [], metadata: {} };
    },
    async *enumerate() {
      const tasks = Array.isArray(options.tasks) ? options.tasks : ["task"];
      for (const [recordKey, id] of tasks.entries()) yield { id, recordKey };
    },
    async prepare(task) {
      globalThis.__cliOnPrepare?.();
      return { input: { id: task.id, prompt: "Question" }, verification: null,
        solveEnv: { workdir: ".", image: options.mode === "unsupported" ? "fixture:image" : null, initialFiles: [], runtime: [] },
        verifyEnv: null, transfer: null };
    },
    async verify(_task, result) { const passed = result.finalText === "42"; return { score: Number(passed), passed, details: {} }; },
  }));
  ctx.evaluator.register("solver", "cli-fixture", config, (options, runtime) => {
    globalThis.__cliOnSolverFactory?.();
    const attempts = new Map();
    return {
      requirements() { return []; },
      async solve(_input, _session, context) {
        globalThis.__cliOnSolve?.();
        const event = (seq, type) => JSON.stringify({ schemaVersion: 1, key: context.key, seq, type, at: new Date().toISOString(), data: null }) + "\n";
        await writeFile(join(context.paths.agent, "trajectory.jsonl"), event(1, "start"));
        await writeFile(join(context.paths.agent, "session.jsonl"), '{"fixture":true}\n');
        const count = (attempts.get(_input.id) ?? 0) + 1;
        attempts.set(_input.id, count);
        if (options.mode === "transient" && count === 1) throw Object.assign(
          new Error("INVALID_REQUEST: litellm.APIConnectionError: Response payload is not completed: <TransferEncodingError: 400>"),
          { code: "SOLVER_RESULT_INCOMPLETE" },
        );
        if (options.mode === "error") throw new Error(`fixture failure ${runtime.services[runtime.solverService].auth.value}`);
        if (options.mode === "nested-error") throw new TypeError("fetch failed", {
          cause: Object.assign(new Error(`connect failed ${runtime.services[runtime.solverService].auth.value}\n    at INTERNAL_STACK_FRAME (fixture.mjs:1:1)`), { code: "ECONNREFUSED" }),
        });
        if (options.mode === "cancel" && !globalThis.__cliResumeContinue) {
          globalThis.__cliEntered?.();
          await new Promise((_resolve, reject) => {
            if (context.signal.aborted) reject(context.signal.reason);
            else context.signal.addEventListener("abort", () => reject(context.signal.reason), { once: true });
          });
        }
        await writeFile(join(context.paths.agent, "trajectory.jsonl"), event(1, "start") + event(2, "end"));
        return { finalText: options.mode === "wrong" ? "0" : "42", usage: { inputTokens: null, outputTokens: null, totalTokens: null } };
      },
    };
  });
  ctx.evaluator.register("reporter", "cli-error", config, () => ({
    async render() { globalThis.__cliReportCalls = (globalThis.__cliReportCalls ?? 0) + 1; throw new Error("fixture report failure"); },
  }));
}
