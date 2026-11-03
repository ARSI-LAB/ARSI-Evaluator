const fixtureState = () => globalThis.__t02FixtureState ??= {
  created: [], disposed: [], factoryInputs: [],
};

export const inject = ["evaluator"];

export function apply(ctx) {
  ctx.effect(() => () => fixtureState().disposed.push("failing"));
  ctx.evaluator.register("benchmark", "orphan", config => config, () => ({}));
  throw new Error("fixture apply failed");
}
