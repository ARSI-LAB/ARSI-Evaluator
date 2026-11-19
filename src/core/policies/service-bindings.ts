import type { EffectiveConfig, ExecutionConfig, ModelConfig, RuntimeAuth } from "../contracts/config.js";
import { expectNonEmptyString } from "../validation/input.js";

/** Pure references check, shared by configuration loading and standalone assembly. */
export function assertServiceReferences(experiment: EffectiveConfig): void {
  const routes = [
    ["solver.service", experiment.solver.service],
    ["verifier.service", experiment.verifier?.service],
    ["benchmark.config.judgeService", experiment.benchmark.config.judgeService],
  ] as const;
  for (const [field, value] of routes) {
    if (value === undefined) continue;
    const name = expectNonEmptyString(value, field);
    if (!Object.hasOwn(experiment.services, name)) throw new TypeError(`${field} references unknown service ${name}`);
  }
}

export function referencedServiceNames(experiment: EffectiveConfig): string[] {
  return [...new Set([experiment.solver.service, experiment.verifier?.service, experiment.benchmark.config.judgeService]
    .filter((name): name is string => typeof name === "string"))];
}

export function assertServiceBindings(config: ExecutionConfig): void {
  assertServiceReferences(config.experiment);
  for (const name of referencedServiceNames(config.experiment)) {
    if (!Object.hasOwn(config.auths, name)) throw new TypeError(`service ${name} has no credentials`);
  }
}

/** Model and credential the solver selection names. */
export function solverBinding(config: ExecutionConfig): { service: string; model: ModelConfig; auth: RuntimeAuth } {
  const service = config.experiment.solver.service;
  const model = config.experiment.services[service];
  const auth = config.auths[service];
  if (!model || !auth) throw new TypeError(`solver references unknown service ${service}`);
  return { service, model, auth };
}
