const fixtureState = () => globalThis.__t02FixtureState ??= {
  created: [], disposed: [], factoryInputs: [],
};

const validators = Object.fromEntries([
  "benchmark", "environment", "solver", "metrics", "reporter", "store", "scheduler",
].map(role => [role, config => {
  if (!config || config.marker !== role) {
    throw new TypeError(`${role} config marker must equal ${role}`);
  }
  return config;
}]));

function factory(role, value) {
  return (config, runtime) => {
    const state = fixtureState();
    state.created.push(role);
    state.factoryInputs.push({
      role,
      config,
      auth: runtime.services?.[runtime.solverService]?.auth.value ?? null,
      configDirectory: runtime.configDirectory ?? null,
      resolvedPath: role === "benchmark" && typeof runtime.resolvePath === "function"
        ? runtime.resolvePath(config.cacheDir)
        : null,
    });
    return value;
  };
}

export const inject = ["evaluator"];

export function apply(ctx) {
  ctx.effect(() => () => fixtureState().disposed.push("fixture-seven-roles"));
  ctx.evaluator.register("benchmark", "fixture-benchmark", validators.benchmark,
    factory("benchmark", {}));
  ctx.evaluator.register("environment", "fixture-environment", validators.environment,
    factory("environment", {}));
  ctx.evaluator.register("solver", "fixture-solver", validators.solver,
    factory("solver", {}));
  ctx.evaluator.register("metrics", "fixture-metrics", validators.metrics,
    factory("metrics", { name: "fixture-metrics", async compute() { return null; } }));
  ctx.evaluator.register("reporter", "fixture-reporter", validators.reporter,
    factory("reporter", { async render() { return "fixture"; } }));
  ctx.evaluator.register("store", "fixture-store", validators.store,
    factory("store", {}));
  ctx.evaluator.register("scheduler", "fixture-scheduler", validators.scheduler,
    factory("scheduler", {}));
}
