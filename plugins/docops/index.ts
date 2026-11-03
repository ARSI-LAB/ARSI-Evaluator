import { bindSolverService } from "ember-evaluator";
import type { Context } from "@deepseek-ai/cordis";
import { DocOpsBenchmark, parseDocOpsConfig } from "./benchmark.js";
import { DocOpsDockerEnvironment, parseDocOpsDockerConfig } from "./docker-environment.js";

export { DocOpsBenchmark, parseDocOpsConfig } from "./benchmark.js";
export type { DocOpsConfig, DocOpsTransport } from "./benchmark.js";
export {
  DocOpsDockerEnvironment,
  DocOpsImageProvider,
  parseDocOpsDockerConfig,
} from "./docker-environment.js";
export type {
  DocOpsDockerConfig,
  DocOpsImageProfile,
  DocOpsImageTransport,
} from "./docker-environment.js";

export const inject = ["evaluator"];

export function apply(ctx: Context): void {
  ctx.evaluator.register(
    "benchmark",
    "docops",
    parseDocOpsConfig,
    (config, runtime) => new DocOpsBenchmark({ ...config, cacheDir: runtime.resolvePath(config.cacheDir) }),
    { nodeLocal: { cacheDir: "cache" } },
  );
  ctx.evaluator.register(
    "environment",
    "docops-docker",
    parseDocOpsDockerConfig,
    (config, runtime) => new DocOpsDockerEnvironment({
      ...config,
      cacheDir: runtime.resolvePath(config.cacheDir),
    }, undefined, undefined, { modelEndpoint: bindSolverService(runtime).model.endpoint,
      ...(runtime.onWarning === undefined ? {} : { onWarning: runtime.onWarning }) }),
    { nodeLocal: { cacheDir: "cache", dockerExecutable: "docker" } },
  );
}
