# Node.js SDK

> English | [中文](./sdk.zh-CN.md)

`Evaluator` provides a CLI and ESM SDK, requiring Node.js 24.22.1 or later 24.x. Import `Evaluator` from the package root to load configuration, execute, report, and release resources in one call. Execution uses declarative workflows; the old `loadConfig`, `bootstrap`, and `runEngine` APIs have been removed.

[User documentation](README.md) · [Installation](installation.md) · [Plugin development](../development/plugins.en.md)

## Install in Your Application

Follow [source installation](installation.md#install-from-source) to install and build Evaluator. pnpm downloads and builds the AgentBundle SDK automatically. Use ESM and pnpm in the application, then run these commands from its directory. Here, `pnpm` reads the application’s own `packageManager` configuration rather than Evaluator’s:

```bash
pnpm add 'arsi-evaluator@link:../arsi-evaluator'
```

Adjust the path for your layout. `link:` does not compile source automatically; rebuild after updating Evaluator. Keep the Evaluator directory and its installed dependencies accessible.

To install a fixed build, package from the Evaluator root and install it in the application:

```bash
pnpm pack --pack-destination .scratch/packages
```

```bash
pnpm add '/path/to/arsi-evaluator-0.1.0.tgz'
```

Evaluator uses `private: true` in its package manifest. The commands above install the SDK from a local link or tarball.

## Execution, Cancellation, and Results

YAML uses `schemaVersion: 2`; see [composable workflows](workflows.md) for templates and expanded step definitions.

```js
import { Evaluator, EvaluatorRunError } from "arsi-evaluator";

const evaluator = new Evaluator();
const controller = new AbortController();
try {
  const result = await evaluator.run({
    configPath: "/path/to/experiment.yaml",
    signal: controller.signal,
    onProgress(event) { console.log(event.phase, event.message); },
  });
  console.log(result.runId, result.record.status, result.exitCode);
  console.log(result.runDirectory, result.reportPath);
} catch (error) {
  if (!(error instanceof EvaluatorRunError)) throw error;
  console.error(error.phase, error.message, error.result?.runDirectory);
}
```

Local, direct Ray, and Ray Jobs runs all return `kind: "workflow"`. `record` contains step/unit states, resource cleanup, outputs, and errors. Native Benchmark evidence is stored below the run directory. Exit codes are 0 for completion, 1 for execution failure, and 130 for cancellation; configuration errors throw `EvaluatorRunError` with code 2. A zero business score does not itself fail execution.

Cancel with `controller.abort()`, then await `run()` so cleanup can finish. The SDK installs no process signal handlers. A synchronous progress callback failure cancels the operation. Error `result` is null or contains persisted partial results. No `dispose()` call is required.

## Options and Paths

| Option | Behavior |
| --- | --- |
| `configPath` | YAML path relative to the current directory |
| `patchPath` | Explicit additional plugin patch; modules resolve relative to the patch |
| `networkConfigPath` | Network file; otherwise uses EVALUATOR_NETWORK_CONFIG or the user default YAML |
| `parameterOverrides` | Template-supported fields such as model, endpoint, apiKeyEnv, taskIds; expanded workflows reject template overrides |
| `env` | Current variables and credentials; an explicit object is not merged with process.env |
| `signal` | Caller cancellation signal |
| `resume` | true selects the only saved run; a string selects a run ID |
| `onEvent` | Workflow events with optional structured progress |
| `onProgress` | Stage, task, and live output events |

YAML paths resolve against the configuration directory. The SDK changes neither the working directory nor process globals. Use `apiKeyEnv` for models and `{credential: "HF_TOKEN"}` for datasets. Merge `process.env` explicitly when needed. Each operation owns its registry and resources; concurrent writers cannot share a run directory.

## Inspect, Warmup, Maintenance, Retry, and Reports

```js
const plan = await evaluator.inspect({ configPath: "/path/to/experiment.yaml" });
const prepared = await evaluator.warmup({ configPath: "/path/to/experiment.yaml" });
const { checks: benchmarkChecks, network } = await evaluator.doctor({ configPath: "/path/to/experiment.yaml" });
const preview = await evaluator.cleanup({ configPath: "/path/to/experiment.yaml" });
const checks = await evaluator.maintain(
  { configPath: "/path/to/experiment.yaml" },
  { operation: "doctor", options: {} },
);
const resumed = await evaluator.run({ configPath: "/path/to/experiment.yaml", resume: "saved-run-id" });
const retried = await evaluator.retry("/path/to/results/saved-run-id", { taskIds: ["failed-case"] });
const report = await evaluator.report("/path/to/results/saved-run-id");
```

For a single Benchmark group, `doctor()` returns configuration checks and the network report. `cleanup()` previews image cleanup by default. Pass `execute: true` to apply it. Use `maintain()` for per-resource or multi-group results.

`inspect` creates no evaluation resources. Warmup and maintenance create only declared preparation dependencies. Resume validates plans, implementations, business inputs, sources, and saved evidence, recovering resources before reusing completed samples. Retry keeps the saved network template while resolving current environment variables and credentials; changing the template requires a new run.

`report` reads saved results and reporting plugins only, without model credentials or execution. Plugins must remain available with matching versions. The current report is `report.md`; resume history lives under `reports/`.

For direct workflow control, the package exports `inspectWorkflow`, `runWorkflow`, `retryWorkflow`, `warmupWorkflow`, `rebuildWorkflowReport`, `compileWorkflow`, and `executeWorkflow`. Plugins import public contracts from the package root rather than internal paths.
