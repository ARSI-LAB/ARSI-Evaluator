import { registerNativeResource } from "arsi-evaluator";
const fixtureState = () => globalThis.__t02FixtureState ??= {
  created: [], disposed: [], factoryInputs: [],
};

export const inject = ["evaluator"];

export function apply(ctx) {
  ctx.effect(() => () => fixtureState().disposed.push("failing"));
  registerNativeResource(ctx, "benchmark", "orphan", config => config, () => ({}));
  throw new Error("fixture apply failed");
}
