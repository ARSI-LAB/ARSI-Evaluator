import { registerRayExecutor } from "./resources/ray-executor.js";
import type { Context } from "@deepseek-ai/cordis";
import { apply as benchmarks } from "./benchmarks/index.js";
import { apply as solvers } from "./solvers/index.js";
import { apply as schedulers } from "./schedulers/index.js";
import { apply as environments } from "./environments/index.js";
import { apply as verifiers } from "./verifiers/index.js";
import { apply as stores } from "./stores/index.js";
import { apply as metrics } from "./metrics/index.js";
import { apply as reporters } from "./reporters/index.js";
import { registerWorkflowSteps } from "./steps/workflow-builtins.js";
import { registerModelResource } from "./resources/model-client.js";
import { registerNetworkResource } from "./resources/network-runtime.js";
import { applicationEvaluationTemplate } from "./workflows/application-evaluate.js";
import { registerBenchmarkWorkflow } from "./workflows/benchmark/workflow.js";
import { resultsRescoreTemplate } from "./workflows/results-rescore.js";

export const inject = ["evaluator"];
export async function apply(ctx: Context): Promise<void> {
  registerRayExecutor(ctx);
  registerWorkflowSteps(ctx);
  registerModelResource(ctx);
  registerNetworkResource(ctx);
  ctx.evaluator.registerWorkflow(applicationEvaluationTemplate);
  ctx.evaluator.registerWorkflow(resultsRescoreTemplate);
  await benchmarks(ctx);
  solvers(ctx);
  schedulers(ctx);
  environments(ctx);
  verifiers(ctx);
  stores(ctx);
  metrics(ctx);
  reporters(ctx);
  registerBenchmarkWorkflow(ctx);
}
