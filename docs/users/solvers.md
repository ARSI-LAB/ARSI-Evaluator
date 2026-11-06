# Choosing Solvers and Model Services

> English | [中文](./solvers.zh-CN.md)

Benchmarks define tasks and scoring; solvers define model requests and agent execution. Start ordinary agent tasks with default SimpleAgent. MMLU and AgentX have dedicated defaults. Check configuration and start a new run after changes.

## Choose a Solver

| Solver | Purpose | Prerequisites |
| --- | --- | --- |
| `simpleagent` | Built-in Pi Agent for quality tasks and tool/file operations | Model API with tool calling; optional Pi Bundle |
| `agentbundle` | Packaged DSH, deepagents, Hermes, Jiuwenswarm, pi, or Dify agents | Readable, valid bundle and harness requirements |
| `agentx-replay` | Trace-driven model requests for service performance | Streaming API, long context, tokenizer, and Python or Docker |
| `choice-logprobs` | Candidate probabilities at one output position for MMLU | local environment; actual logprobs/top_logprobs support; disable thinking when needed |

`simpleagent` is the framework default. AgentX profiles select `agentx-replay`; MMLU profiles select `choice-logprobs`. MMLU cannot be scored solely from an agent's final letter. See [scoring](reference/scoring.md#mmlu-probability-scoring-and-service-requirements) for service requirements, missing candidates, and Chat adaptation differences.

Select one solving path per configuration. EnvironmentSession represents execution interfaces and process boundaries; it does not move all solver plugin code into containers. Harness adapters read output and construct `SolveResult`. Benchmarks still score tasks. See [AgentX](benchmarks/agentx.md) for performance replay.

## Model Services and Independent Judges

This complete two-task example declares both the evaluated model and a judge:

```yaml
services:
  default:
    model: ${MODEL_NAME}
    base_url: ${MODEL_ENDPOINT}
    api_key: ${MODEL_API_KEY}
  judge:
    model: ${JUDGE_NAME}
    base_url: ${JUDGE_ENDPOINT}
    api_key: ${JUDGE_API_KEY}
benchmark:
  name: simpleqa
  config:
    judgeService: judge
environment: local
run:
  maxTasks: 2
output:
  directory: ./results/simpleqa
```

Set all six environment variables as shown in [quick start](quick-start.md#3-set-model-variables), then `run` `doctor` and `run`. Replace `simpleqa` with `healthbench` to use its profile.

- `benchmark.solver.service` selects the solving service. If omitted, it prefers `services.default`, otherwise the sole service. Multiple non-default services require explicit selection.
- **SimpleQA/HealthBench** select judges through `benchmark.config.judgeService`; the evaluated model is not automatically used as judge. `init` generates judge variables. Use `judgeService: default` to reuse the default service explicitly.
- **Harbor/WorkBuddy** model verifiers use `benchmark.verifier.service`. Web requires a judge; Office model scoring is optional. See [Harbor](benchmarks/harbor.md). This differs from record-based benchmarks' `judgeService` field.

`api` defaults to `openai-completions`. With an explicit Chat Completions `base_url`, Pi/SimpleAgent and built-in judges send no client output cap unless `services.<name>.maxTokens` is a positive integer. Other providers and external harnesses retain their protocol-specific rules.

Add `maxTokens: 8192` to a service to limit replies. Configure model request retries with `services.<name>.retry.maxAttempts`; exhaustion ends the current attempt without restarting the solution.

## SimpleAgent (Based on Pi)

`simpleagent` is Evaluator's built-in solver, using the Pi SDK for the agent loop, model requests and tool calls. Without a bundle, it runs with Evaluator's default instructions and tools. For example, `benchmark: gsm8k` selects default SimpleAgent and requires no Pi Bundle preparation.

### Optional: Load a Pi Bundle

Supply a Pi Bundle to customize instructions, skills, extensions or settings. Apply this fragment while keeping services, environment and other fields:

```yaml
benchmark:
  name: gsm8k
  solver:
    name: simpleagent
    config:
      bundle:
        path: ${PI_BUNDLE_PATH}
```

Point to a prepared Pi Bundle, rather than an arbitrary source directory. `bundle.settings` supplies serializable Pi settings applied to a staged copy, leaving the original bundle intact.

> Note: Extensions in a Pi Bundle load through Pi's officially supported Extensions (plugin) mechanism. The bundle packages those extensions and related resources.

### Tool Command Timeouts

Tool commands have separate timeouts. Increasing the task budget does not make shell commands unlimited. To adjust them:

```yaml
benchmark:
  name: gsm8k
  solver:
    config:
      toolPolicy:
        shellTimeoutSeconds: 180
        shellMaxTimeoutSeconds: 600
```

Provide both fields; the maximum must be at least the default. This fragment retains default `simpleagent`. Actual tool call timeouts cannot exceed the maximum.

## AgentBundle

Follow [source installation](installation.md#install-from-source) to prepare Evaluator. pnpm installs the AgentBundle SDK automatically, without a sibling source repository. `AGENT_BUNDLE_PATH` below points to a prepared **agent bundle directory**, supplied separately rather than the SDK installation path. See the [AgentBundle project](https://github.com/evolving-foundry/agentbundle) for concepts, CLI usage and examples, and its [bundle authoring guide](https://github.com/evolving-foundry/agentbundle/blob/master/docs/bundle-formats.md) for harness-specific layouts, manifests and validation.

```yaml
services:
  default:
    model: ${MODEL_NAME}
    base_url: ${MODEL_ENDPOINT}
    api_key: ${MODEL_API_KEY}
benchmark:
  name: gsm8k
  solver:
    name: agentbundle
    config:
      path: ${AGENT_BUNDLE_PATH}
environment: local
run:
  maxTasks: 2
  timeoutSeconds: 900
output:
  directory: ./results/gsm8k-agentbundle
```

Prefer an absolute `AGENT_BUNDLE_PATH`. Evaluator reads the declared harness and checks content identity before selecting an adapter; directory names are not used to guess. Local harnesses also check their pinned versions against the declared ranges; see below for remote Dify version limits. Start a new run after bundle changes.

| Harness declaration | Behavior |
| --- | --- |
| `dsh` | Prepare and run through DSH; see [DSH output](usage.md#dsh-tool-output) |
| `deepagents` **Beta** | `deepagents` / LangGraph adapter |
| `hermes` **Beta** | Hermes adapter |
| `jiuwenswarm` **Beta** | Jiuwenswarm adapter |
| `pi` **Beta** | pi with release artifact and settings digest validation |
| `dify` **Beta** | Install a remote application with the SDK, then execute its Workflow; see below |

Some harnesses require preinstalled local runtimes or dependency installation during Docker preparation. Local directories do not automatically become container/remote paths. Check bundle and harness deployment requirements before choosing a [Playbook](../../playbook/README.md) environment.

Specify existing installations with Solver settings such as `dshhome`, `dshprofile`, `hermeshome`, or `jiuwenswarmhome`. `jiuwenswarmTimeoutSeconds` applies only to that harness. Additional pi settings use `benchmark.solver.config.pi.settings`, unsupported by other harnesses.

For Docker, DSH uses the pinned default (0.2.2-rc.1) when it satisfies the Bundle’s `harness.version`. Otherwise the Solver selects the highest compatible release from the configured npm registry. Use an explicit prerelease comparator to allow a release candidate. Local environments check the installed DSH version against the same range.

Prefer `services.<name>.maxTokens` for output limits. AgentBundle also accepts Solver `maxTokens`, but setting both is an error. This page covers Evaluator configuration and execution; use the linked AgentBundle documentation for bundle creation, formats and installation.

## Docker Preparation and Networking

The solver selects agent behavior; the task environment selects an existing image or a Dockerfile build. Choosing `simpleagent` or `agentbundle` does not directly select an image download method. `warmup` makes no model calls, but prepares task images, Evaluator's shared Node runtime and installation dependencies required by the selected harness. Available caches are reused.

A single warmup may include both Dockerfile `FROM` pulls and explicit acquisition of existing images such as Node. The former uses Docker daemon/BuildKit networking; the latter uses the network file's `docker.mirrors` and `docker.pull`. Even with `docker.pull.method: docker`, Evaluator rewrites the image reference before asking Docker to download it. See [warmup downloads](deployment/network.md#image-and-dependency-downloads-during-warmup) for configuration boundaries across image acquisition, build-time dependency installation and runtime installation.

## Dify

Dify is an AgentBundle harness. Prepare a bundle declaring `harness.name: dify` and use this text-task configuration:

```yaml
services:
  default:
    model: dify-internal-binding
    base_url: http://127.0.0.1:9/v1
    api_key: ${MODEL_API_KEY}
benchmark:
  name: gsm8k
  solver:
    name: agentbundle
    config:
      path: ${DIFY_BUNDLE_PATH}
      dify:
        baseUrl: ${DIFY_BASE_URL}
        registryPath: ${DIFY_REGISTRY_PATH}  # optional
environment: local
run:
  maxTasks: 2
  timeoutSeconds: 900
output:
  directory: ./results/gsm8k-dify
```

`path` selects the Dify bundle. `dify.baseUrl` is the service address, such as `https://dify.example`, without `/v1`, `/workflows/run`, credentials, query parameters, or fragments. Installation and execution both use this address, overriding the SDK's `DIFY_BASE`. The Workflow accepts text input `task` and returns text `report` or `answer`; other output objects are saved as JSON text.

Configure Console credentials on the machine running the Evaluator process: `DIFY_ADMIN_API_KEY`, `DIFY_EMAIL` plus `DIFY_PASSWORD`, or previously saved SDK credentials. Missing credentials fail without an interactive login. The SDK installs and publishes the application and returns its app ID and Service API key. For Ray, preconfigure Console credentials on installation nodes; local environment variables are not automatically distributed.

services retains required framework metadata. In this example `MODEL_API_KEY` only satisfies service binding and no request goes to the placeholder address; model binding belongs to the Dify application. Service or Solver `maxTokens` does not change Workflow model parameters.

`dify.registryPath` selects the installation record file, relative to the YAML directory. By default it uses `dify/<service-address-digest>/installations.json` below the SDK's default registry directory. Concurrent attempts sharing a file on one machine use a file lock and create one application. Remote nodes have separate records; installation is not deduplicated across nodes. An explicit registry containing the same bundle for another service is rejected; choose another file. Registry files contain Service API keys and must not be committed. Run artifacts only contain credential-free installation evidence. Applications remain installed in persistent mode after evaluation.

Provenance records the bundle digest, Runner digest/version, and declared platform version range. The actual remote Dify version and external changes to the installed Workflow are not verified. The old `solver.name: dify`, `bundlePath`, `apiKeyEnv`, and `appId` settings are removed. Migrate to this bundle configuration and start a new run; existing results remain usable for offline reporting.

**The Dify harness does not sync generated files back to task environments.** Office and repository-editing tasks need SimpleAgent or another AgentBundle harness that writes through EnvironmentSession. The [Office Dify YAML](../../playbook/workbuddy/workbuddy-office-dify.yaml) only demonstrates configuration.

## AgentX Service Performance

No AgentBundle preparation is needed. `benchmark.name: agentx` selects a dedicated trace-request solver. The API must support streaming, `ignore_eos`, full context, and required output lengths.

- `replay`: explicitly set `traceCount` and complete a finite trace set, suitable for adaptation acceptance.
- `standard`: fixed `standard` measurement windows and load rules.

vLLM `/metrics` and Ascend sampling endpoints are optional; without them only model API performance is measured. `replay` is not a formally comparable score; standard must pass upstream and local validity checks. See [AgentX](benchmarks/agentx.md) for parameters, Python requirements, and NPU collection.

[User guide](README.md) · [Daily operations](usage.md) · [Configuration reference](config.md)
