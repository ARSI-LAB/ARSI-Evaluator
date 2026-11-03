const fixtureState = () => globalThis.__t02FixtureState ??= {
  created: [], disposed: [], factoryInputs: [],
};

export const inject = ["evaluator"];

export function apply(ctx) {
  ctx.effect(() => () => fixtureState().disposed.push("factory-failing"));
  const register = (role, name, factory) =>
    ctx.evaluator.register(role, name, config => config, factory);
  register("benchmark", "fixture-benchmark", () => {
    fixtureState().created.push("benchmark");
    return {};
  });
  register("environment", "fixture-environment", () => {
    throw new Error("fixture environment factory failed");
  });
  register("solver", "fixture-solver", () => ({}));
  register("metrics", "fixture-metrics", () => ({ name: "fixture-metrics", async compute() { return null; } }));
  register("reporter", "fixture-reporter", () => ({ async render() { return "fixture"; } }));
  register("store", "fixture-store", () => ({}));
  register("scheduler", "fixture-scheduler", () => ({}));
}
