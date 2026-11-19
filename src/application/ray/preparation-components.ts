import { nativeResourceTransport, prepareNativeResource } from "../../plugins/workflows/benchmark/component-resource.js";
import { NetworkRuntime } from "../../infrastructure/network/runtime.js";
import { resolve } from "node:path";

import { assertServiceBindings } from "../../core/policies/service-bindings.js";
import { type ExecutionConfig } from "../../core/contracts/config.js";
import type { Benchmark } from "../../core/contracts/benchmark.js";
import type { RunComponents } from "../../core/contracts/components.js";
import type { PluginRegistry } from "../plugins/open-registry.js";
import type { PluginFactoryContext } from "../../core/contracts/plugin.js";
import { fingerprintImageConfig } from "../../core/policies/image-config.js";
import type { ConfigTransportLookup } from "../../core/contracts/config-transport.js";

function createPluginRuntime(config: ExecutionConfig, experimentDir: string, pluginPatchPath?: string, onWarning?: (message: string) => void, configTransport?: ConfigTransportLookup, network = new NetworkRuntime(config.network)) {
  assertServiceBindings(config);
  const configDirectory = resolve(experimentDir);
  const services = Object.fromEntries(
    Object.entries(config.auths).map(([name, auth]) => {
      const model = config.experiment.services[name];
      if (!model) throw new TypeError(`missing model for service ${name}`);
      return [name, { model, auth }];
    }),
  );
  return {
    network,
    benchmarkName: config.benchmarkName ?? config.experiment.benchmark.name,
    hardware: config.experiment.hardware ?? "npu",
    phaseTimeouts: {
      ...(config.experiment.run.solveTimeoutSeconds === undefined ? {} : { solveTimeoutSeconds: config.experiment.run.solveTimeoutSeconds }),
      ...(config.experiment.run.verifyTimeoutSeconds === undefined ? {} : { verifyTimeoutSeconds: config.experiment.run.verifyTimeoutSeconds }),
    },
    imageConfigFingerprint: fingerprintImageConfig(config.experiment as unknown as import("../../core/contracts/task.js").JsonValue, configTransport),
    services,
    solverService: config.experiment.solver.service,
    environmentName: config.experiment.environment.name,
    configDirectory,
    ...(pluginPatchPath === undefined ? {} : { pluginPatchPath }),
    ...(onWarning === undefined ? {} : { onWarning }),
    resolvePath: (path: string) => resolve(configDirectory, path),
  };
}

async function instantiateBenchmark(
  registry: PluginRegistry,
  config: ExecutionConfig,
  runtime: PluginFactoryContext,
): Promise<Benchmark> {
  const createBenchmark = prepareNativeResource(registry.ctx, "benchmark", config.experiment.benchmark);
  const createVerifier = config.experiment.verifier ? prepareNativeResource(registry.ctx, "verifier", config.experiment.verifier) : undefined;
  const route = config.experiment.verifier?.service;
  const boundVerifier = route === undefined ? undefined : runtime.services[route];
  if (route !== undefined && !boundVerifier) throw new TypeError(`Verifier service ${route} is unavailable`);
  const verifier = createVerifier ? await createVerifier({ ...runtime,
    ...(route === undefined ? {} : { verifierService: route }) }) : undefined;
  const benchmark = await createBenchmark({ ...runtime, ...(verifier ? { verifier } : {}) });
  benchmark.validateRun?.(structuredClone(config.experiment));
  return benchmark;
}

/** Node preparation creates only the components needed to describe and materialize a task. */
export async function createPreparationComponents(
  registry: PluginRegistry, config: ExecutionConfig, experimentDir: string,
  onWarning: (message: string) => void, imageConfigFingerprint?: string,
): Promise<Pick<RunComponents, "benchmark" | "environment" | "solver" | "pluginVersions">> {
  const createEnvironment = prepareNativeResource(registry.ctx, "environment", config.experiment.environment);
  const createSolver = prepareNativeResource(registry.ctx, "solver", config.experiment.solver);
  const runtime = { ...createPluginRuntime(config, experimentDir, registry.patch.patchPath ?? undefined, onWarning,
    (role, name) => nativeResourceTransport(registry.ctx.evaluator.workflows, role, name)), ...(imageConfigFingerprint ? { imageConfigFingerprint } : {}) };
  registry.ctx.effect(() => () => runtime.network.dispose(), "Preparation network lifecycle");
  return {
    benchmark: await instantiateBenchmark(registry, config, runtime),
    environment: await createEnvironment(runtime), solver: await createSolver(runtime),
    pluginVersions: registry.pluginVersions,
  };
}
