export const inject = ["evaluator"];
export function apply(ctx) {
  ctx.evaluator.registerProfile({ id: "example-harbor", role: "benchmark", extends: "harbor", defaultVersion: "1",
    versions: { "1": { plugin: { name: "harbor", config: {
      dataset: "example-harbor@1", source: { kind: "local", path: "./harbor" },
      tasks: { expectedCount: 2, requireTestScript: true },
    } } } }, defaults: { environment: "docker", benchmark: { verifier: "harbor-shell" } } });
}
