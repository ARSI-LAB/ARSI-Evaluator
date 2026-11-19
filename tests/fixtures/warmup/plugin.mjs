import { registerNativeResource } from "arsi-evaluator";
export const inject = ["evaluator"];

const event = (name, value) => globalThis.__warmupEvent?.(name, value);
const forbidden = () => { throw new Error("Evaluation must not start during warmup"); };

export function apply(ctx) {
  const validate = value => value;
  ctx.effect(() => () => { event("dispose"); });
  registerNativeResource(ctx, "benchmark", "warmup-fixture", validate, () => {
    const benchmark = {
      async resolveSource() {
        event("source");
        return { source: "warmup-fixture", revision: "fixed", files: [], metadata: {} };
      },
      async *enumerate() {
        for (const id of ["a", "b", "c"]) yield { id, recordKey: id };
      },
      async prepare(ref) {
        return { input: { id: ref.id, prompt: "Question" }, verification: null,
          solveEnv: { workdir: "/workspace", image: null, runtime: [], initialFiles: [] },
          verifyEnv: null, transfer: null };
      },
      async planRun(refs, source, signal) {
        return { tasks: await Promise.all(refs.map(ref => benchmark.prepare(ref, source, signal))),
          preparation: { defaultTimeoutSeconds: 10 }, policy: { version: "fixture", source: "test" } };
      },
      verify: forbidden,
    };
    return benchmark;
  });
  registerNativeResource(ctx, "solver", "warmup-fixture", validate, () => ({
    requirements() { return []; },
    prepare: forbidden,
    solve: forbidden,
  }));
  registerNativeResource(ctx, "environment", "warmup-fixture", validate, options => ({
    supportsRuntimeInstallation: true,
    async materialize(spec, signal, _ready, _activity, context) {
      await event("materialize", context.taskId);
      signal.throwIfAborted();
      if (options.failTask === context.taskId) throw new Error(`Fixture preparation failed ${process.env.WARMUP_TEST_TOKEN ?? ""}`);
      return spec;
    },
    prepare: forbidden,
  }));
}
