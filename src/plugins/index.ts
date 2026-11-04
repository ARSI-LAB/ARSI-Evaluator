import type { Context } from "@deepseek-ai/cordis";
import { LocalRunStore } from "./stores/local.js";
import { DefinedBenchmark, DEFINED_BENCHMARKS, HarborBenchmark, parseHarborConfig, AgentXBenchmark, parseAgentXConfig } from "./benchmarks/index.js";
import { HuggingFaceFilesSource } from "../adapters/datasets/sources/huggingface/files-source.js";
import { HttpZipJsonSource } from "../adapters/datasets/sources/http/zip-json-source.js";
import { dropDefinition } from "./benchmarks/definitions/drop.js";
import { LocalEnvironment } from "./environments/local.js";
import { DockerEnvironment, parseDockerContainerEnv, parseDockerImageOverrides } from "./environments/docker.js";
import { parseBuildPipConstraints } from "../adapters/containers/pip-constraints.js";
import { parseDockerPlatform, parseDockerEmulation } from "./environments/docker-platform.js";
import { PINNED_NODE_IMAGE } from "./environments/docker-runtime.js";
import { LocalScheduler } from "./schedulers/local.js";
import { RayScheduler } from "./schedulers/ray.js";
import { parseRayConfig } from "./schedulers/ray-config.js";
import { SimpleAgentSolver, parseSimpleAgentConfig } from "./solvers/simpleagent.js";
import { ChoiceLogprobsSolver, parseChoiceLogprobsConfig } from "./solvers/choice-logprobs.js";
import { AgentBundleSolver, agentBundleModel, parseAgentBundleConfig } from "./solvers/agentbundle.js";
import { DEFAULT_LOCAL_CONCURRENCY, expectRecord, rejectUnknown, expectPositiveInteger, expectNonEmptyString } from "../config/schema.js";
import { type PluginFactoryContext, bindSolverService } from "../core/registry.js";
import { apply as registerReporting } from "./reporting.js";
import { HarborShellVerifier, parseShellVerifierConfig } from "./verifiers/shell.js";
import { HarborPythonVerifier, parsePythonVerifierConfig } from "./verifiers/python.js";
import { readProfileDirectory } from "../config/profiles.js";
import { AgentXReplaySolver, parseAgentXReplayConfig } from "./solvers/agentx-replay.js";
import { harborConfigTransport } from "./benchmarks/protocols/harbor/config-transport.js";
import { OfficeQAProV2Benchmark, parseOfficeQAProV2Config } from "./benchmarks/definitions/officeqa-pro-v2/index.js";
import { KernelBenchmark, parseKernelConfig } from "./benchmarks/protocols/kernel/index.js";
import { KernelReplaySolver } from "./solvers/kernel-replay.js";


export const inject = ["evaluator"];

// Concrete built-ins register here as their owning tasks land. This is a real
// Cordis entrypoint so bootstrap never needs placeholders for future roles.
export async function apply(ctx: Context): Promise<void> {
  for (const profile of await readProfileDirectory(new URL("./benchmarks/profiles/", import.meta.url))) ctx.evaluator.registerProfile(profile);
  registerReporting(ctx);
  ctx.evaluator.register("solver", "choice-logprobs", parseChoiceLogprobsConfig, (config, runtime) => {
    const { model, auth } = bindSolverService(runtime);
    return new ChoiceLogprobsSolver(config, model, auth, runtime.environmentName);
  });
  ctx.evaluator.register("benchmark", "officeqa-pro-v2", parseOfficeQAProV2Config, (config, runtime) =>
    new OfficeQAProV2Benchmark({ ...config, cacheDir: runtime.resolvePath(config.cacheDir) }, undefined, undefined, runtime.network),
    { nodeLocal: { cacheDir: "cache", dockerExecutable: "docker" }, secretFields: ["hfToken"] });
  ctx.evaluator.register("benchmark", "kernel", parseKernelConfig, (config, runtime) =>
    new KernelBenchmark({ ...config, manifest: runtime.resolvePath(config.manifest),
      profiling: { ...config.profiling, ...(config.profiling.cacheDir === undefined ? {} : { cacheDir: runtime.resolvePath(config.profiling.cacheDir) }) },
      ...(config.kernelRoot === undefined ? {} : { kernelRoot: runtime.resolvePath(config.kernelRoot) }) }, runtime.hardware));
  ctx.evaluator.register("solver", "kernel-replay", (value: unknown) => {
    const config = expectRecord(value, "kernel-replay");
    rejectUnknown(config, [], "kernel-replay");
    return {};
  }, () => new KernelReplaySolver());
  ctx.evaluator.register("benchmark", "agentx", parseAgentXConfig, (config, runtime) =>
    new AgentXBenchmark({ ...config, cacheDir: runtime.resolvePath(config.cacheDir) }, runtime.environmentName ?? "local", undefined, runtime.network),
    { nodeLocal: { cacheDir: "cache" }, secretFields: ["hfToken"] });
  ctx.evaluator.register("benchmark", "drop", value => {
    const config = expectRecord(value, "drop");
    rejectUnknown(config, ["cacheDir"], "drop");
    return { cacheDir: expectNonEmptyString(config.cacheDir ?? ".cache/drop", "drop.cacheDir") };
  }, (config, runtime) => new DefinedBenchmark(dropDefinition, new HttpZipJsonSource(runtime.resolvePath(config.cacheDir), {
    url: "https://s3-us-west-2.amazonaws.com/allennlp/datasets/drop/drop_dataset.zip",
    sha256: "39d2278a29fd729de301b111a45f434c24834f40df8f4ff116d864589e3249d6",
    selections: { train: "drop_dataset/drop_dataset_train.json", test: "drop_dataset/drop_dataset_dev.json" },
  }), { dockerExecutable: "docker" }), { nodeLocal: { cacheDir: "cache" } });
  ctx.evaluator.register("solver", "agentx-replay", parseAgentXReplayConfig, (config, runtime) => new AgentXReplaySolver(config, runtime));
  ctx.evaluator.register("verifier", "harbor-shell", parseShellVerifierConfig, () => new HarborShellVerifier());
  ctx.evaluator.register("verifier", "harbor-python", parsePythonVerifierConfig, (config, runtime) => new HarborPythonVerifier(config, runtime),
    { nodeLocal: { dockerExecutable: "docker" } });
  ctx.evaluator.register(
    "solver",
    "agentbundle",
    parseAgentBundleConfig,
    (config, runtime) => {
      const bound = bindSolverService(runtime);
      const model = agentBundleModel(bound.model, config.maxTokens, runtime.solverService);
      const solver = new AgentBundleSolver(runtime.resolvePath(config.path), model, bound.auth, undefined, {
        environmentName: runtime.environmentName ?? "local",
        ...(config.dshhome === undefined ? {} : { dshhome: runtime.resolvePath(config.dshhome) }),
        ...(config.dshprofile === undefined ? {} : { dshprofile: config.dshprofile }),
        ...(config.hermeshome === undefined ? {} : { hermeshome: runtime.resolvePath(config.hermeshome) }),
        ...(config.jiuwenswarmTimeoutSeconds === undefined ? {} : { jiuwenswarmTimeoutSeconds: config.jiuwenswarmTimeoutSeconds }),
        ...(config.pi === undefined ? {} : { pi: config.pi }),
        ...(config.dify === undefined ? {} : { dify: {
          ...config.dify,
          ...(config.dify.registryPath === undefined ? {} : { registryPath: runtime.resolvePath(config.dify.registryPath) }),
        } }),
      }, runtime.network);
      ctx.effect(() => () => solver.dispose(), "AgentBundle staging lifecycle");
      return solver;
    },
  );
  ctx.evaluator.register(
    "scheduler",
    "ray",
    parseRayConfig,
    (config, runtime) => {
      const scheduler = new RayScheduler(config, runtime, (role, name) => ctx.evaluator.configTransport(role, name));
      ctx.effect(() => () => scheduler.close(), "Ray scheduler lifecycle");
      return scheduler;
    },
  );
  ctx.evaluator.register(
    "benchmark",
    "harbor",
    parseHarborConfig,
    (config, runtime) => new HarborBenchmark({ ...config, cacheDir: runtime.resolvePath(config.cacheDir),
      ...(config.source?.kind === "local" ? { source: { ...config.source, path: runtime.resolvePath(config.source.path) } } : {}) }, undefined, runtime.verifier, runtime.phaseTimeouts, runtime.hardware, runtime.network),
    harborConfigTransport,
  );
  ctx.evaluator.register(
    "solver",
    "simpleagent",
    parseSimpleAgentConfig,
    (config, runtime) => {
      const bound = bindSolverService(runtime);
      const solver = new SimpleAgentSolver(
        bound.model,
        bound.auth,
        config.bundle === undefined
          ? undefined
          : {
              path: runtime.resolvePath(config.bundle.path),
              ...(config.bundle.settings === undefined ? {} : { settings: config.bundle.settings }),
            },
        config.toolPolicy,
      );
      ctx.effect(() => () => solver.dispose(), "simpleagent staging lifecycle");
      return solver;
    },
  );
  ctx.evaluator.register(
    "scheduler",
    "local",
    (value: unknown) => {
      const config = expectRecord(value, "local scheduler");
      rejectUnknown(config, ["concurrency"], "local scheduler");
      return { concurrency: expectPositiveInteger(config.concurrency ?? DEFAULT_LOCAL_CONCURRENCY, "concurrency") };
    },
    config => new LocalScheduler(config.concurrency),
  );
  ctx.evaluator.register(
    "environment",
    "local",
    (config: unknown) => {
      if (config === null || typeof config !== "object" || Array.isArray(config) || Object.keys(config).length !== 0) {
        throw new TypeError("local environment config must be empty");
      }
      return {};
    },
    (_config, runtime) => new LocalEnvironment(undefined, undefined, runtime.network),
  );
  ctx.evaluator.register(
    "environment",
    "docker",
    (value: unknown) => {
      const config = expectRecord(value, "docker environment");
      rejectUnknown(config, ["dockerExecutable", "nodeImage", "image", "platform", "allowEmulation", "containerEnv", "buildPipConstraints", "imageOverrides"], "docker environment");
      const nodeImage =
        config.nodeImage === undefined ? undefined : expectNonEmptyString(config.nodeImage, "nodeImage");
      if (nodeImage !== undefined && nodeImage !== PINNED_NODE_IMAGE)
        throw new TypeError(`docker nodeImage must equal the pinned runtime image ${PINNED_NODE_IMAGE}`);
      return {
        platform: parseDockerPlatform(config.platform),
        ...(config.allowEmulation === undefined ? {} : { allowEmulation: parseDockerEmulation(config.allowEmulation) }),
        ...(config.containerEnv === undefined ? {} : { containerEnv: parseDockerContainerEnv(config.containerEnv) }),
        ...(config.buildPipConstraints === undefined ? {} : { buildPipConstraints: parseBuildPipConstraints(config.buildPipConstraints) }),
        ...(config.imageOverrides === undefined ? {} : { imageOverrides: parseDockerImageOverrides(config.imageOverrides) }),
        ...(config.dockerExecutable === undefined
          ? {}
          : { dockerExecutable: expectNonEmptyString(config.dockerExecutable, "dockerExecutable") }),
        ...(nodeImage === undefined ? {} : { nodeImage }),
        // Base task image for benchmarks that do not ship container images
        // (e.g. HF datasets); solver runtimes are layered on top of it.
        ...(config.image === undefined ? {} : { image: expectNonEmptyString(config.image, "image") }),
      };
    },
    (config, runtime) => new DockerEnvironment({ ...config, network: runtime.network, benchmarkName: runtime.benchmarkName, ...(runtime.imageConfigFingerprint ? { imageConfigFingerprint: runtime.imageConfigFingerprint } : {}), modelEndpoint: runtime.services[runtime.solverService]?.model.endpoint ?? null,
      ...(runtime.onWarning === undefined ? {} : { onWarning: runtime.onWarning }) }),
    { nodeLocal: { dockerExecutable: "docker" } },
  );
  for (const { definition, source } of DEFINED_BENCHMARKS) {
    const name = definition.name;
    const requiresJudge = ["healthbench", "simpleqa", "math500"].includes(name);
    ctx.evaluator.register(
      "benchmark",
      name,
      (value: unknown) => {
        const config = expectRecord(value, name);
        rejectUnknown(config, ["cacheDir", "hfToken", "dockerExecutable", ...(requiresJudge ? ["judgeService"] : [])], name);
        const cacheDir = expectNonEmptyString(config.cacheDir ?? ".cache/huggingface", `${name}.cacheDir`);
        const dockerExecutable = expectNonEmptyString(config.dockerExecutable ?? "docker", `${name}.dockerExecutable`);
        return { cacheDir, dockerExecutable,
          ...(config.hfToken === undefined ? {} : { hfToken: expectNonEmptyString(config.hfToken, `${name}.hfToken`) }),
          ...(requiresJudge ? { judgeService: expectNonEmptyString(config.judgeService, `${name}.judgeService`) } : {}) };
      },
      (config, runtime) =>
        new DefinedBenchmark(
          definition,
          new HuggingFaceFilesSource(runtime.resolvePath(config.cacheDir), name, source, config.hfToken ?? process.env.HF_TOKEN, undefined, runtime.network),
          { network: runtime.network, dockerExecutable: config.dockerExecutable,
            ...(config.judgeService === undefined ? {} : { judgeService: config.judgeService, judge: requireJudgeService(runtime, config.judgeService) }) },
        ),
      { nodeLocal: { cacheDir: "cache", dockerExecutable: "docker" }, secretFields: ["hfToken"] },
    );
  }
  ctx.evaluator.register(
    "store",
    "local",
    (config: unknown) => {
      if (config === null || typeof config !== "object" || Array.isArray(config) || Object.keys(config).length !== 0) {
        throw new TypeError("local store config must be empty; use output.directory for the root");
      }
      return {};
    },
    () => {
      const store = new LocalRunStore();
      ctx.effect(() => () => store.close(), "local store writer lock");
      return store;
    },
  );
}

function requireJudgeService(runtime: PluginFactoryContext, name: string) {
  const binding = runtime.services[name];
  if (!binding) throw new TypeError(`Judge service ${name} is unavailable; declare it in services and provide its credentials`);
  return binding;
}
