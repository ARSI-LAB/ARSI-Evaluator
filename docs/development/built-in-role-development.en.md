# Developing a Built-in Component Role

> English | [中文](./built-in-role-development.md)

This example adds `runGuard` alongside roles such as `environment` and `scheduler`. An experiment can select a guard. The built-in `task-limit` checks the configured `run.maxTasks` and rejects a run if the limit is missing or exceeds its policy. Experiments that omit `runGuard` follow the existing execution path.

## 1. Define the role and contract

Create `src/core/contracts/run-guard.ts`. The caller passes only the data the guard needs.

```ts
export interface RunGuard {
  assertAllowed(maxTasks: number | null): void;
}
```

Import `RunGuard` in [plugin.ts](../../src/core/contracts/plugin.ts). Add `"runGuard"` to `PluginRole` and `runGuard: RunGuard` to `RoleImplementations`. The factory uses the existing `PluginFactoryContext`. The [registry](../../src/application/plugins/registry.ts) already looks up components by role and name, so the example uses its existing `register()` and `prepare()`.

## 2. Register a built-in implementation

Create `src/plugins/run-guards/index.ts`. The validator checks plugin configuration. The factory creates the component, and `assertAllowed()` performs the run check.

```ts
import type { Context } from "@deepseek-ai/cordis";
import type { RunGuard } from "../../core/contracts/run-guard.js";
import { expectPositiveInteger, expectRecord, rejectUnknown } from "../../core/validation/input.js";

export function apply(ctx: Context): void {
  ctx.evaluator.register("runGuard", "task-limit", (value: unknown) => {
    const config = expectRecord(value, "task-limit");
    rejectUnknown(config, ["maxTasks"], "task-limit");
    return { maxTasks: expectPositiveInteger(config.maxTasks, "task-limit.maxTasks") };
  }, (config): RunGuard => ({
    assertAllowed(maxTasks) {
      if (maxTasks === null || maxTasks > config.maxTasks) {
        throw new Error(`run.maxTasks must be at most ${config.maxTasks}`);
      }
    },
  }));
}
```

In [src/plugins/index.ts](../../src/plugins/index.ts), import `apply as runGuards` and call `runGuards(ctx)` from the existing `apply(ctx)`.

## 3. Accept a selection in experiment configuration

| File | Change |
| --- | --- |
| [user-schema.ts](../../src/config/user-schema.ts) | Add `runGuard?: string \| PluginSelection` to `UserConfig`. Allow `runGuard` as a top-level field. If `record.runGuard !== undefined`, set `result.runGuard` to `normalizeSelection(record.runGuard, "runGuard")`. |
| [config.ts](../../src/core/contracts/config.ts) | Add `runGuard?: Selection` to `EffectiveConfig`. |
| [effective.ts](../../src/config/effective.ts) | In the object returned by `parseEffectiveConfig()`, add `runGuard: parseSelection(source.runGuard, "runGuard")` when the input contains the field. Omit the property when the selection is absent. |
| [load.ts](../../src/config/load.ts) | Add `if (experiment.runGuard) registry.validate("runGuard", experiment.runGuard);` inside the plugin validation block so `inspect` checks the registered name and private configuration. |

The example uses an explicit YAML selection. The existing [resolve.ts](../../src/config/resolve.ts) merge carries the selection through. To support Benchmark Profile defaults, also allow the field in [profile-schema.ts](../../src/config/profile-schema.ts) and check how defaults and user selections merge.

## 4. Create and invoke the component

In [components.ts](../../src/core/contracts/components.ts), import the contract and add `runGuard?: RunGuard` to `RunComponents`. In `createRunComponents()` in [create-components.ts](../../src/application/plugins/create-components.ts), prepare the factory alongside the other roles.

```ts
const guardSelection = config.experiment.runGuard;
const createRunGuard = guardSelection === undefined
  ? undefined
  : ctx.evaluator.prepare("runGuard", guardSelection);
```

After factory validation, create the instance with the existing `runtime`.

```ts
const runGuard = await createRunGuard?.(runtime);
```

Add `...(runGuard === undefined ? {} : { runGuard })` to the returned object. In `executeEngine()` in [engine.ts](../../src/core/execution/engine.ts), call the guard after the existing `signal.throwIfAborted()`, before opening a saved run or preparing tasks.

```ts
components.runGuard?.assertAllowed(config.experiment.run.maxTasks);
```

The guard runs on each entry to the Engine, including resumes and retries that start another Engine execution. It checks run configuration once, so online retries within the same run do not trigger it per task. `inspect` validates the selection and plugin options. The Engine performs the runtime check.

## 5. Verify behavior and choose the scope

- Run `pnpm check:dependencies`, `pnpm typecheck`, and `pnpm build`, then follow the [minimal example](add-built-in-plugin.en.md#minimal-example). Try an unknown implementation or invalid `maxTasks` to verify that `inspect` rejects it. Run a controlled evaluation with an allowed limit to verify that the Engine proceeds.
- Cover existing YAML and saved configurations when adding optional fields. Check that a run and resume still work with the field omitted. If a role owns processes or connections, register cleanup in its Cordis plugin scope with `ctx.effect()` and verify success, failure, and cancellation.
- The example verifies local execution. Before adding Ray support, decide whether the role runs on the coordinator or worker, then check configuration transport, version checks, and credential redaction. Export the new contract from the [package root](../../src/index.ts) if independent TypeScript plugins will implement it.
