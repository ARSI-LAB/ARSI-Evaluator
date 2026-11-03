# Node.js SDK

> English | [中文](./sdk.zh-CN.md)

`Evaluator` provides a CLI and ESM SDK, requiring Node.js 24.22.1 or later 24.x. Import `Evaluator` from the package root to load configuration, execute, report, and release resources in one call. Low-level APIs such as `loadConfig`, `bootstrap`, and `runEngine` remain available.

[User documentation](README.md) · [Installation](installation.md) · [Plugin development](../development/plugins.en.md)

## Install in Your Application

Follow the [source installation order](installation.md#install-from-source): prepare sibling AgentBundle, build `agent-bundle-core`, then Evaluator. Use ESM in the application and run:

```bash
corepack pnpm@11.22.0 add 'ember-evaluator@link:../ember-evaluator'
```

Adjust the path for your layout. `link:` does not compile source automatically; rebuild after updating Evaluator. Keep Evaluator, AgentBundle, and their dependencies accessible.

To install a fixed build, package from the Evaluator root and install it in the application:

```bash
corepack pnpm@11.22.0 pack --pack-destination .scratch/packages
```

```bash
corepack pnpm@11.22.0 add '/path/to/ember-evaluator-0.1.0.tgz'
```

The package still depends on AgentBundle through Git. Installation requires repository read access or verified dependency packages supplied by deployment. Evaluator remains `private: true`; this guide does not imply public npm availability.

## Run a YAML Experiment

Set `"type": "module"` in the application's `package.json`. For example, create `evaluate.mjs`:

```js
import { Evaluator, EvaluatorRunError } from "ember-evaluator";

const evaluator = new Evaluator();
const controller = new AbortController();

try {
  const result = await evaluator.run({
    configPath: "/path/to/config.yaml",
    signal: controller.signal,
    onProgress(event) {
      console.log(event.phase, event.message);
    },
  });
  console.log(result.runId, result.exitCode, result.reportPath);
  if (result.kind === "local") {
    console.log(result.snapshot.run.status);
  } else {
    console.log(result.jobId, result.collectionError, result.reportError);
  }
} catch (error) {
  if (!(error instanceof EvaluatorRunError)) throw error;
  console.error(error.phase, error.message);
  console.error("Partial results: ", error.result?.runDirectory);
}
```

Set the YAML model variables in the current terminal as shown in [quick start](quick-start.md#3-set-model-variables). Configuration, benchmark, model, Docker, and task requirements match the CLI; SDK use retains authentication and preparation checks.

## Options and Paths

`EvaluatorRunOptions`, `ProgressEvent`, and `ProgressListener` are exported from the package root.

| Option | Meaning |
| --- | --- |
| `configPath` | Experiment YAML; relative to the working directory at call time |
| `patchPath` | Explicit plugin patch, relative to the current directory; no automatic scan beside configuration |
| `overrides` | CLI-equivalent `model` `overrides`: `model`, `endpoint`, `apiKey`, `apiKeyEnv` |
| `env` | YAML variable expansion and model authentication; defaults to `process.env`; an explicit object replaces it without merging |
| `signal` | Caller-provided `AbortSignal` |
| `resume` | `true` selects the sole existing run in the output directory; a string selects a run ID; omitted or `false` starts a new run |
| `onProgress` | Synchronous callback; task phases include task/attempt IDs; Ray Jobs logs use phase `deployment` |

YAML bundle/output paths remain relative to the YAML directory; patch module paths are relative to the patch file. The SDK does not call `process.chdir()` or modify `process.env`. One instance supports concurrent calls, each with separate registry/resources. Choose appropriate output paths and avoid concurrent resume calls on the same run.

`env` supplies configuration input only. Docker, proxy, and Ray gateway variables still come from the actual process or execution node. Ray Jobs tokens, for example, continue to use `tokenEnv` or secure files without changing process globals through `env`.

## Cancellation, Resume, and Reports

Call `controller.abort()` to cancel. The SDK registers no SIGINT/SIGTERM listeners; servers should convert HTTP disconnects, cancellation, or process signals into AbortSignal. Cleanup and partial evidence storage take time. Wait for `run()` before exiting; do not abandon a running evaluation after a `Promise.race` timeout.

```js
const result = await evaluator.run({
  configPath: "/path/to/config.yaml",
  resume: "saved-run-id",
});

const reportPath = await evaluator.report("/path/to/results/saved-run-id");
```

Resume requires identical configuration, sources, code, and plugin versions. Validation failure refuses execution without rewriting the original report. `report()` rebuilds offline without model calls or keys. Third-party reporting plugins must remain available; failures propagate `rebuildReport()` errors. Each `run()` releases its resources before returning or throwing; no `evaluator.dispose()` is required.

Progress callbacks should return quickly; applications may queue asynchronous messages. A synchronous callback exception aborts the run, releases resources, and throws `EvaluatorRunError` while retaining saved partial results.

## Results and Errors

`EvaluationResult` is a union discriminated by `kind`:

| Field | Meaning |
| --- | --- |
| `exitCode` | `0` completed, `1` runtime failure, `2` configuration/preparation entry error, `130` cancelled; wrong answers may still return `0` |
| `runId` | Local run ID or remote receipt ID; may be `null` before the remote receipt provides one |
| `runDirectory` / `reportPath` | Saved results/report paths; may be `null` before creation or after collection failure |
| `snapshot` for `kind: "local"` | Results coordinated by the current process, including task/run status; also applies to Docker and direct Ray Client scheduling |
| `jobId` for `kind: "ray-jobs"` | Ray Jobs ID; follows CLI receipt, follow, and cancellation behavior |
| `collectionError` / `reportError` | Redacted Ray Jobs download/report failures; missing results are not treated as success |

Wrong answers and Engine-saved task failures appear in returned results; inspect `exitCode`, snapshots, and reports. Configuration, assembly, entry execution, report, or disposal exceptions throw `EvaluatorRunError` with `phase`, `exitCode`, `result`, and a redacted `cause` chain. `result` may be `null`. Redacted diagnostics do not imply redacted task contents; inspect files before sharing trajectories.

## Ray Jobs and Package Requirements

SDK and CLI select the same `deployment` paths, including explicit Ray Jobs and managed local clusters triggered by Ray configuration. See [Ray and execution nodes](config.md#ray-and-execution-nodes). Remote text logs use `onProgress` phase `deployment`. A separate progress channel supplies transient task/attempt activity rather than reconstructing events from text.

`ProgressEvent.transient` marks presentation events that need not be saved. Optional `live` includes operation/parent IDs, sequence, start/update/completed/failed/cancelled states, elapsed and idle times, and up to 10 redacted preview lines. `live.preparation` marks steps that make environments ready. Optional `summary` reports task totals, prepared and completed counts; `connection` reports disconnected, recovered, or unsupported remote progress. Repeated snapshots are not new work: deduplicate by operation ID and sequence, and reject late updates to finished operations. The SDK draws no terminal UI and saves none of these events to stores or trajectories. See [live execution previews](usage.md#live-execution-previews).

Source resolution, enumeration, and batch planning also emit `live` operations. Built-in sources report download bytes, file verification, and processing counts; planning updates the current task and index. `message` may change with activity; `elapsedMs` accumulates from the start of a `live.id`. Planning counts do not increase `summary.prepared`.

Managed local clusters require repository `scripts/ray-smoke/`, Docker, and local deployment resources, fitting source `link:` installations. A `.tgz` alone excludes management scripts. Standalone packages connecting to deployed Ray Jobs must provide endpoint, CA, gateway authentication, and `managedLocal: false`. Node packages, plugins, and authentication requirements remain unchanged. An SDK installation alone does not supply Docker or Ray execution capability.
