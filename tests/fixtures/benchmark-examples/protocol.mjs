import { questionSource, sourceConfig } from "./source.mjs";

export const inject = ["evaluator"];
export function apply(ctx) {
  ctx.evaluator.registerProfile({ id: "example-protocol", role: "benchmark",
    plugin: { name: "example-protocol", config: { path: "./questions.json" } }, defaults: { environment: "local" } });
  ctx.evaluator.register("benchmark", "example-protocol", sourceConfig, (config, runtime) => {
    const source = questionSource(runtime.resolvePath(config.path));
    return {
      validateSourceOnCompletedResume: true,
      resolveSource: source.resolve,
      async *enumerate(lock, signal) {
        let index = 0;
        for await (const _row of source.rows(lock, "test", signal)) yield { id: `question:${index}`, recordKey: index++ };
      },
      async prepare(ref, lock, signal) {
        if (!Number.isSafeInteger(ref.recordKey) || ref.recordKey < 0 || ref.id !== `question:${ref.recordKey}`)
          throw new TypeError("Invalid example task reference");
        let index = 0;
        for await (const row of source.rows(lock, "test", signal)) {
          if (index++ === ref.recordKey) return {
            input: { id: ref.id, prompt: row.question }, verification: { expected: row.answer },
            solveEnv: { workdir: ".", image: null, initialFiles: [], runtime: [] }, verifyEnv: null, transfer: null,
          };
        }
        throw new RangeError("Example task reference is out of range");
      },
      async verify(task, result, _session, signal) {
        signal.throwIfAborted();
        const passed = result.finalText.trim() === task.verification.expected;
        return { passed, score: Number(passed), details: { protocol: "example-protocol-v1" } };
      },
    };
  });
}
