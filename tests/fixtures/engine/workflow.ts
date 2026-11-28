import { Context } from "@deepseek-ai/cordis";
import { basename, dirname, join } from "node:path";
import type { ExecutionConfig } from "../../../src/core/contracts/config.js";
import type { RunComponents } from "../../../src/core/contracts/components.js";
import type { ProgressListener } from "../../../src/core/progress/progress.js";
import { apply as registryPlugin } from "../../../src/application/plugins/registry.js";
import type { PluginRegistry } from "../../../src/application/plugins/open-registry.js";
import { executeWorkflowRetry } from "../../../src/application/workflow-retry.js";
import { executeWorkflowPlan } from "../../../src/application/workflow-execution.js";
import { compileWorkflow } from "../../../src/core/workflow/compile.js";
import { parseWorkflowDocument } from "../../../src/config/workflow-schema.js";
import { workflowObject } from "../../../src/core/workflow/values.js";
import { registerBenchmarkWorkflow } from "../../../src/plugins/workflows/benchmark/workflow.js";
import { registerNativeResource } from "../../../src/plugins/workflows/benchmark/component-resource.js";
import { registerNetworkResource } from "../../../src/plugins/resources/network-runtime.js";
import { bindWorkflowNetwork } from "../../../src/application/workflow-network.js";
import { BUILTIN_RUNTIME_ID } from "../../../src/core/results/runtime-identity.js";
import { loadBuiltinRuntimeDigest } from "../../../src/infrastructure/provenance/builtin-runtime.js";

/** Inject controlled components into the real Benchmark workflow; no execution logic lives in this fixture. */
export async function runBenchmarkFixture(input: {
  components: RunComponents; config: ExecutionConfig; signal: AbortSignal; runId?: string;
  resumeDirectory?: string; onProgress?: ProgressListener; onEvent?: (event: import("../../../src/core/contracts/workflow.js").WorkflowEvent) => void; retryTaskIds?: string[]; retryRequestId?: string;
}) {
  const { components, config, signal } = input, experiment = config.experiment;
  const ctx = new Context();
  await ctx.plugin(registryPlugin);
  const registry: PluginRegistry = { ctx, patch: { entries: [], patchPath: null, patchDigest: null }, entries: [],
    pluginVersions: { ...components.pluginVersions, [BUILTIN_RUNTIME_ID]: await loadBuiltinRuntimeDigest() },
    loadPlugins: async () => {}, loadRecordedPlugins: async () => {}, prepareStoreDecorators: selections => ctx.evaluator.prepareStoreDecorators(selections),
    reportingProviders: {}, componentProviders: {}, dispose: () => ctx.fiber.dispose() };
  try {
    for (const role of ["benchmark", "environment", "solver", "store", "scheduler", "reporter"] as const)
      registerNativeResource(ctx, role, experiment[role].name, value => value, () => components[role]);
    for (const [index, selection] of experiment.metrics.entries()) {
      const metric = components.metrics[index];
      if (!metric) throw new Error(`Missing fixture metric ${selection.name}`);
      registerNativeResource(ctx, "metrics", selection.name, value => value, () => metric);
    }
    // Fixtures without score assertions still declare a valid, inert metric.
    if (!experiment.metrics.length) registerNativeResource(ctx, "metrics", "fixture-empty", value => value,
      () => ({ name: "fixture-empty", async compute() { return null; } }));
    registerNetworkResource(ctx);
    registerBenchmarkWorkflow(ctx);
    const env: Record<string, string | undefined> = {};
    const services = Object.fromEntries(Object.entries(experiment.services).map(([name, model], index) => {
      const reference = `FIXTURE_MODEL_${index}_KEY`;
      env[reference] = config.auths[name]?.value;
      return [name, { model: model.name, base_url: model.endpoint ?? "https://fixture.invalid", apiKeyEnv: reference,
        ...(model.provider === null ? {} : { provider: model.provider }), ...(model.api === null ? {} : { api: model.api }),
        ...(model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens }),
        ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }), ...(model.retry ? { retry: model.retry } : {}) }];
    }));
    const { solver: _solver, verifier: _verifier, ...parameters } = experiment;
    const template = ctx.evaluator.workflows.template("benchmark.evaluate");
    const document = parseWorkflowDocument(template.expand(workflowObject({ ...parameters, services,
      run: { ...experiment.run, onError: experiment.run.onError ?? "abort" },
      benchmark: { ...experiment.benchmark, solver: experiment.solver, ...(experiment.verifier ? { verifier: experiment.verifier } : {}) },
      metrics: experiment.metrics.length ? experiment.metrics : [{ name: "fixture-empty", config: {} }],
    })));
    document.output.directory = experiment.output.directory;
    document.pathBase = dirname(experiment.output.directory);
    await bindWorkflowNetwork(document, ctx.evaluator.workflows, { env: {} });
    const plan = compileWorkflow(document, ctx.evaluator.workflows, registry.pluginVersions);
    const events = input.onProgress || input.onEvent ? { onEvent: (event: import("../../../src/core/contracts/workflow.js").WorkflowEvent) => { if (event.progress) input.onProgress?.(event.progress); input.onEvent?.(event); } } : {};
    const result = input.retryTaskIds ? await executeWorkflowRetry(plan, registry, input.resumeDirectory ?? "", {
      signal, env, ...events, taskIds: input.retryTaskIds, ...(input.retryRequestId ? { requestId: input.retryRequestId } : {}),
    }) : await executeWorkflowPlan(plan, registry, { signal, env,
      ...(input.runId ? { runId: input.runId } : {}),
      ...(input.resumeDirectory ? { resume: basename(input.resumeDirectory) } : {}),
      ...events,
    });
    const nativeDirectory = join(result.directory, "benchmark-evidence", result.record.runId);
    await components.store.open(nativeDirectory);
    return { ...await components.store.snapshot(), workflow: result.record, directory: result.directory, nativeDirectory };
  } finally { await registry.dispose(); }
}
