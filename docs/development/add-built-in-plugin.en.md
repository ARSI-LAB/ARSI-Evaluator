# Add a Built-in Component Role

> English | [中文](./add-built-in-plugin.md)

This example adds `runGuard` alongside the eight existing component roles, such as Benchmark, Environment, and Solver. It checks the configured task limit before an evaluation starts to catch runs that exceed the intended budget.

Follow the guide to add the `runGuard` role and its `task-limit` implementation to the source. To add an implementation of an existing role, such as another metric, see [Add a built-in implementation for an existing role](plugins.en.md#add-a-built-in-implementation-for-an-existing-role).

## Minimal example

| Step | Change |
| --- | --- |
| Define the role | Create `src/core/contracts/run-guard.ts` and add `runGuard` to `PluginRole` and `RoleImplementations`. |
| Register the built-in implementation | Create `src/plugins/run-guards/index.ts` to register `task-limit`. Call that entry point from `src/plugins/index.ts`. |
| Read the configuration | Accept an optional `runGuard` field in experiment YAML. Parse the selection and validate the chosen implementation. |
| Call the component | Create the selected instance during component assembly and invoke it before the Engine starts task preparation. |

After following the [full implementation steps](built-in-role-development.en.md#1-define-the-role-and-contract), copy the [local GSM8K example](../../playbook/gsm8k/gsm8k-quick-start.yaml). Use Bash or WSL from the repository root.

```bash
mkdir -p .scratch/run-guard-example
cp playbook/gsm8k/gsm8k-quick-start.yaml .scratch/run-guard-example/experiment.yaml
```

The example's `run.maxTasks` is 2. Add `runGuard` at the same level as `run` in the copy.

```yaml
runGuard:
  name: task-limit
  config:
    maxTasks: 1
```

Build Evaluator, inspect the configuration, then run the evaluation.

```bash
export MODEL_NAME=unused-example MODEL_ENDPOINT=http://127.0.0.1:1/v1 MODEL_API_KEY=fixture-only
pnpm typecheck
pnpm build
node dist/cli.js inspect .scratch/run-guard-example/experiment.yaml
node dist/cli.js run .scratch/run-guard-example/experiment.yaml
```

`inspect` should show `task-limit` as `experiment.runGuard.name`. `run` should exit with a nonzero status and show `run.maxTasks must be at most 1`. Task preparation and model calls have yet to start. This checks both that the configuration selects the component and that the Engine invokes it.
