import { DefinedBenchmark } from "ember-evaluator";
import { questionSource, sourceConfig } from "./source.mjs";

export const inject = ["evaluator"];
export function apply(ctx) {
  ctx.evaluator.registerProfile({ id: "example-definition", role: "benchmark",
    plugin: { name: "example-definition", config: { path: "./questions.json" } }, defaults: { environment: "local" } });
  ctx.evaluator.register("benchmark", "example-definition", sourceConfig, (config, runtime) => new DefinedBenchmark({
    name: "example-definition", selections: ["test"],
    prepare(id, { value }) {
      return { input: { id, prompt: value.question }, verification: value.answer };
    },
    verify(expected, response, _context, signal) {
      signal.throwIfAborted();
      const passed = response.trim() === expected;
      return { passed, score: Number(passed), details: { protocol: "example-exact-v1" } };
    },
  }, questionSource(runtime.resolvePath(config.path)), { dockerExecutable: "docker" }));
}
