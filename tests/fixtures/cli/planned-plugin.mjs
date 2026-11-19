import { apply as registerBase } from "./base.mjs";

export const inject = ["evaluator"];
export function apply(ctx) {
  registerBase(ctx);
  const benchmark = ctx.evaluator.workflows.resource("native.benchmark.cli-fixture");
  ctx.evaluator.registerResource({ ...benchmark, type: "native.benchmark.planned-fixture",
    async create(config, context) {
      const resource = await benchmark.create(config, context);
      const original = resource.value;
      resource.value = { ...original, validateSourceOnCompletedResume: true,
        async resolveSource(...args) {
          const source = await original.resolveSource(...args);
          return { ...source, revision: globalThis.__workflowSourceRevision ?? source.revision };
        }, async planRun(refs, source, signal) {
        const failures = globalThis.__workflowPlanningFailures ?? [];
        return { tasks: await Promise.all(refs.filter(ref => !failures.includes(ref.id)).map(ref => original.prepare(ref, source, signal))),
          preparationFailures: failures.map(taskId => ({ taskId, failure: { code: "TASK_METADATA_MISSING", category: "configuration", retryable: false, message: "Missing task metadata", phase: "prepare", component: "benchmark" } })),
          preparation: { defaultTimeoutSeconds: 10 }, policy: { version: "fixture", source: "test" } };
      } };
      return resource;
    },
  });
  const environment = ctx.evaluator.workflows.resource("native.environment.local");
  ctx.evaluator.registerResource({ ...environment, type: "native.environment.planned-fixture",
    async create(config, context) {
      const resource = await environment.create(config, context);
      const materialize = resource.value.materialize.bind(resource.value);
      resource.value.materialize = async (...args) => {
        await globalThis.__workflowMaterialize?.(args[4]?.taskId);
        return await materialize(...args);
      };
      return resource;
    },
  });
}
