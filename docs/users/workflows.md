# Custom evaluation workflows

> English | [中文](workflows.zh-CN.md)

Choose a template and fill in model, case and grading settings. Export the expanded YAML only when you need to change the steps. Both formats use the same `run` command.

```bash
arsi-evaluator workflow list
arsi-evaluator init --workflow application.evaluate --output evaluate.yaml
arsi-evaluator inspect evaluate.yaml
arsi-evaluator run evaluate.yaml
```

Edit the generated model name and endpoint first. `apiKeyEnv` names the environment variable containing the credential; do not put credentials in YAML. The built-in model resource uses OpenAI-compatible Chat Completions and takes proxy settings from `HTTP_PROXY`, `HTTPS_PROXY` and `NO_PROXY` in the process or SDK environment. Use `--network network.yaml` to select network settings. Benchmark templates retain `--model`, `--endpoint`, `--api-key-env` and `--task-ids-file`; templates interpret these overrides before environment expansion. A direct `--api-key` value stays in invocation memory. Expanded workflows must be edited in YAML.

`inspect` validates the plan without executing it. `run benchmark.yaml --dry-run` invokes the Benchmark resource preview, returning task IDs for each variant without creating a solver, execution environment or result directory. Model credentials are unnecessary. A task IDs file contains `{"taskIds":["case-a","case-b"]}` and overrides sampling, offset and task limits. Workflows without a preview operation direct the user to `inspect`.

## Cases and steps

`application.evaluate` accepts inline `cases`, or `casesFile: ./cases.jsonl`. Each JSONL row has this shape:

```json
{"id":"addition","request":{"question":"2 + 2?"},"reference":"4"}
```

Public requests are saved as a collection artifact. Reference answers are separate private grading inputs. Resume checks the original file digest and rejects changed data. Collections are file-backed JSONL, currently loaded into memory during execution. Relative paths resolve from the configuration file.

```bash
arsi-evaluator inspect evaluate.yaml --output custom.yaml
arsi-evaluator run custom.yaml
```

The expanded configuration declares resources, steps, named inputs and outputs. `use` selects a plugin. `{ref: previous.outputs.value}` connects an earlier output; `{value: ...}` supplies a constant. You may remove reporting, insert preprocessing or replace the grader. Update downstream references when removing a producer. `inspect` checks those connections without calling models.

Independent `forEach` units support concurrency, model variants and repetitions. Sequential loops support conversations and consecutive memory sessions. Use attempt-scoped resources for per-case memory. Sharing across independent cases requires the provider's explicit sharing declaration. Persistence and cleanup remain kernel responsibilities even when reporting or grading steps are removed. Required workflow outputs determine completion; a numeric score is optional.

## Templates

| Template | Purpose | Patch |
| --- | --- | --- |
| `application.evaluate` | Application calls and exact/model grading | Built in |
| `benchmark.evaluate` | Existing Benchmark, Solver, Environment and Verifier implementations | Built in |
| `results.rescore` | Grade saved public text outputs in a new run | Built in |
| `application.compare` | Separate target runs followed by pairwise grading | `plugins/workflow-compare/cordis.patch.yaml` |
| `memory.qa` | Memory writes across sessions, queries and grading | `plugins/workflow-memory/cordis.patch.yaml` |
| `pelican.svg` | SVG generation, Chromium PNG rendering and visual grading | `plugins/workflow-pelican/cordis.patch.yaml` |

Build external examples with `pnpm build`, then pass the same patch to discovery, initialization, inspection, running and retry:

```bash
arsi-evaluator workflow list --patch plugins/workflow-compare/cordis.patch.yaml
arsi-evaluator init --workflow application.compare --output compare.yaml --patch plugins/workflow-compare/cordis.patch.yaml
arsi-evaluator run compare.yaml --patch plugins/workflow-compare/cordis.patch.yaml
```

See the [example configurations](../../playbook/workflows/). Pelican evaluation requires a local Chromium/Chrome executable and an image-capable judge. It is an example workflow, not a reproduction of a particular published leaderboard.

## Resume, retry and reporting

```bash
arsi-evaluator run evaluate.yaml --resume <run-id>
arsi-evaluator retry --run results/<run-id> --task-id failed-case
arsi-evaluator report results/<run-id>
```

Resume validates the plan, plugin versions, pinned sources and artifact digests. Completed cases are reused. Failed cases start a fresh attempt. Cleanup-only failures do not repeat generation or grading. External writes require an explicit safe-replay guarantee. During a run, retry queues idle failed cases whose resources have been cleaned. Active cases continue. Requests without eligible cases are rejected. Reusing `--request-id` does not execute the same request twice. After the original process exits, retry runs the selected cases directly. Repeat `--task-id` to select cases, or omit it to retry all failed cases. Offline reporting reads saved metrics and artifacts without model credentials or requests.

`warmup` calls resource dependency preparation only. Resources that depend on earlier step outputs are reported as `deferred`; warmup does not execute those steps to obtain their values.

Completion and cancellation publish `report.md` in the run directory. Benchmark uses the selected Metrics/Reporter; other workflows can provide offline report hooks, with a generic summary as the default. Rebuilding requires only the relevant report plugins at their saved versions. Explicit resume preserves earlier reports under `reports/`; retry and `report` update the current report without overwriting earlier resume snapshots.

## Rescoring

Initialize `results.rescore`, set `with.source` to the original run directory, and configure `judge` and `rubric`. Running this YAML creates a new run, calls only the judge, preserves original model groups/repetitions and leaves the source unchanged. The template reads public execution-unit `response.text` outputs; use `with.output` for a different output name. Other evidence, including images or native verifier artifacts, requires suitable input and grading steps.

## Current scope

`benchmark.evaluate` supports local or Ray scheduling and native preparation, solving, verification, metrics and reporting. Ray preparation uses batch mode; pipeline preparation is local only. Each model variant and repetition has its own native result directory, metrics and report. Browser processes are closed on normal completion and cancellation; recovery after a process crash may still require manual confirmation. See [workflow plugin development](../development/workflow-plugins.md).
## Benchmark variants and repetitions

Set `variants` and `repetitions` under `benchmark.evaluate` parameters. Each variant inherits the base configuration and may override services or the Solver:

```yaml
variants:
  - id: model-a
    services:
      default:
        model: model-a
  - id: model-b
    services:
      default:
        model: model-b
repetitions: 2
```

All groups use the same selected cases. Results stay separate for each model and repetition.

## Network configuration

Workflows accept `--network network.yaml` and `EVALUATOR_NETWORK_CONFIG`. Without either, they read `.arsi-evaluator/network.yaml` in the user home directory:

```bash
arsi-evaluator inspect evaluate.yaml --network network.yaml --output expanded.yaml
arsi-evaluator run evaluate.yaml --network network.yaml
```

The application adds `network.runtime` dependencies for models and Benchmarks. Exported workflows retain the original network template, including references such as `${PROXY_URL}`. Inspection and export do not require those values. Proxy, source and mirror fields follow the [network configuration guide](config.md). Execution nodes prefer their own environment values and fetch missing declared values over the authenticated channel. Credential values are never written into plans.

An expanded workflow can declare multiple `network.runtime` resources and select one through `resources.network`. Explicit bindings take precedence over `--network`. Coordinator resources use a `run` network resource; remote model clients use a `worker` network resource.

Warmup creates network clients needed for dependency preparation without calling models, then releases them on success or failure. `retry` uses the saved network template rather than reloading the default file. `run --resume` checks the YAML and network template against the original plan. Changing credential values does not change the plan fingerprint.

## Ray execution

`application.evaluate` and `benchmark.evaluate` run locally by default. Add `with.scheduler` to dispatch independent samples through Ray:

```yaml
scheduler:
  name: ray
  config:
    endpoint: ray://ray-head:10001
    concurrency: 4
    collector:
      certFile: security/collector.crt
      keyFile: security/collector.key
      tokenEnv: EVALUATOR_TRANSFER_TOKEN
      host: 0.0.0.0
      port: 8443
      publicUrl: https://coordinator.example:8443
```

Install matching evaluator and plugin versions on each node. Set `workflowWorkerEntry` in its node configuration to the absolute path of `dist/application/ray/workflow-worker.js`. Model credentials can be set on the coordinator or the node. Node values take precedence; missing values are fetched through the authenticated HTTPS channel, limited to names declared by workflow resources. Credential values stay in memory and are excluded from plans, results and recovery journals. Nodes use `EVALUATOR_NODE_CONFIG`, `pluginPatchPath`, `configDirectory`, `outputRoot`, `caFile`, and `tokenEnv`; coordinator patch paths are never sent to nodes.

Templates create the `ray.connection` and executor resources automatically. Benchmark preparation and execution share that connection and dispatch samples to their prepared nodes. Expanded workflows select an `executor.ray` resource through `forEach.executor` and bind its `connection` dependency to `ray.connection`. Use `worker` for reusable clients and `attempt` for stateful sessions. Resuming a cleanup failure contacts the original node first; an unreachable node is not treated as cleaned. Control messages are limited to 2 MiB and individual artifacts to 256 MiB.


## Ray Jobs deployment

Set a top-level `deployment` to run the coordinator on a cluster. Keep only concurrency and node counts in `with.scheduler`; the cluster supplies its internal Ray address, certificates, and artifact channel.

```yaml
schemaVersion: 2
workflow: application.evaluate
deployment:
  kind: ray-jobs
  endpoint: https://gateway.example:9443
  caFile: security/cert.pem
  tokenEnv: EVALUATOR_JOBS_TOKEN
with:
  scheduler:
    name: ray
    config:
      concurrency: 4
  model:
    model: your-model
    endpoint: https://api.example.com/v1
    apiKeyEnv: MODEL_API_KEY
  cases:
    - id: addition
      request: {question: "2 + 2"}
      reference: "4"
```

Use the same `run`, `warmup`, and `retry` commands. `run experiment.yaml --resume <run-id>` uploads complete local evidence in verified chunks and reuses successful samples. The gateway holds model credentials only in memory; the coordinator retrieves them on demand. After a gateway restart, provide credentials again with the same resume command.

Top-level `output.directory` selects the local download directory. Relative resource paths refer to the deployed experiment directory. Local datasets and plugin source code are not uploaded; install matching data, plugins, and runtimes on the cluster. Exporting with `inspect --output` preserves the gateway connection and local output location.

`benchmark.evaluate` uses the same scheduling parameters and accepts its gateway configuration in `with.deployment`. Selecting `scheduler: {name: ray}` without a gateway uses the repository's managed local Ray Jobs environment.

## Local bundles and dataset credentials

`benchmark.evaluate` collects AgentBundle names from the solver variants that actually run. Managed local Ray Jobs mounts their directories automatically. Override nonstandard host locations at the top level:

```yaml
deployment:
  kind: ray-jobs
  managedLocal: true
  bundles:
    first: ./custom-bundles/first
    second: ../another-project/bundles/second
```

Names map to `./bundles/first` and `./bundles/second` on the nodes. Each directory must contain `bundle.yaml` and is mounted read-only. Host paths remain in local deployment metadata; exported configurations contain resolved absolute paths. Changing the map triggers a mount check; the launcher refuses to rebuild a cluster with active jobs. External clusters require preinstalled bundles instead of local mount mappings.

Use a credential reference for authenticated HF dataset access:

```yaml
with:
  benchmark:
    name: gsm8k
    config:
      hfToken: {credential: HF_TOKEN}
```

Set `HF_TOKEN` in the environment before running. Inspection and export retain the reference without expanding its value. Ray nodes use their local value first and otherwise request it from the submitter through the authenticated channel. Do not put literal tokens in YAML.

## Diagnostics and image cleanup

```bash
arsi-evaluator doctor experiment.yaml
arsi-evaluator cleanup images experiment.yaml
arsi-evaluator cleanup images experiment.yaml --execute
```

The second command only previews; the third removes images. The existing `--yes` flag also executes removal. Doctor invokes resource-declared checks for runtime prerequisites, credential availability and network access without requesting model responses. Image cleanup needs no model or dataset credentials. With Ray Jobs deployment, the same commands submit maintenance to the cluster.

Results are listed per resource. `failed`, `incomplete` and `deferred` produce a nonzero exit code. Deferred operations need outputs from evaluation steps and cannot run during maintenance. `not-required` means the resource declares no such operation; it does not certify its environment.

## Automatic retries

The Benchmark template retries an entire case after a truncated model response stream and confirmed cleanup, with at most three attempts. Ordinary business failures and negative scores do not trigger automatic retries. Each attempt retains its own evidence; completed cases remain reusable on resume.

In an expanded workflow, remove `forEach.retry` to disable automatic retries, or replace its policy resource and set `maxAttempts`. The limit includes the first attempt and is not reset by resume or manual retry. Cancellation or unconfirmed cleanup prevents automatic retry.

## Migrating from earlier versions

| Content | Current support |
| --- | --- |
| Existing Benchmark evaluations | Use `benchmark.evaluate` with the existing datasets, Solver, Environment, Verifier, metrics and reports |
| Old experiment YAML | Use `schemaVersion: 2`, move business parameters under `with`, and keep `output` and `deployment` at the top level; repository Playbooks are migrated |
| Model and dataset credentials | Models use `apiKeyEnv`; plugin secrets use `{credential: ENV_NAME}` instead of expanding secrets into configuration |
| Old plugin registration | Use `registerNativeResource`; steps, resources and templates have separate registration methods |
| Old SDK execution APIs | Use the package-root `Evaluator`, returning `kind: "workflow"`; see the [SDK guide](sdk.md) |
| Runs containing only an old `manifest.json` | Use the original evaluator version for reports or resume; the new entry does not convert or rewrite old results |
| New workflow resume | Plans, inputs and plugin/package implementation fingerprints must match; changed workflows require a new run |

Continue using `run`, `warmup`, `doctor`, `retry` and `report`. Old YAML and plugin registration are not automatically compatible inputs; migrate them first, then validate with `inspect`.
