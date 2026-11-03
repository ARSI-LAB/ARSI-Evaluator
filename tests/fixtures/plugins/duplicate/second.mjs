const fixtureState = () => globalThis.__t02FixtureState ??= {
  created: [], disposed: [], factoryInputs: [],
};

export const inject = ["evaluator"];

export function apply(ctx) {
  ctx.effect(() => () => fixtureState().disposed.push("duplicate-second"));
  ctx.evaluator.register("benchmark", "fixture-benchmark", config => config, () => ({}));
}
