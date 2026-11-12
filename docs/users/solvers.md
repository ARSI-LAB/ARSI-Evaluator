# Choosing Solvers and Model Services

> English | [中文](./solvers.zh-CN.md)

Benchmarks define tasks and scoring; solvers define model requests and agent execution. Start ordinary agent tasks with default SimpleAgent. MMLU and AgentX have dedicated defaults. Check configuration and start a new run after changes.

## Choose a Solver

| Solver | Purpose | Prerequisites |
| --- | --- | --- |
| `simpleagent` | Built-in Pi Agent for quality tasks and tool/file operations | Model API with tool calling; optional Pi Bundle |
| `agentbundle` | Packaged DSH, deepagents, Hermes, Jiuwenswarm, pi, or Dify agents | Readable, valid bundle and harness requirements |
| `codex` | Codex CLI for text, images, PDF pages, commands, and workspace files | Model service with streaming Responses API and tool calling |
| `claudecode` | Claude Code for text, images, PDFs, and Bash in local and Docker runs | Model service with streaming Anthropic Messages API and tool calling |
| `zcode` | ZCode CLI for text, images, PDFs, and Bash in local and Docker runs | Model service with streaming Chat Completions, Responses, or Messages and tool calling |
| `trae` | TRAE CLI 2.0 for text, images, PDF pages, and shell commands | Model service with streaming Responses and tool calling |
| `codebuddy` | CodeBuddy Code for text, images, PDF pages, and shell commands | Model service with streaming Chat Completions or Responses and tool calling |
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

## Codex

`codex` runs Codex CLI in the task working directory on the local machine or in Docker. Evaluator installs CLI version `0.167.0` during environment preparation and authenticates with the selected model service. Save the following experiment YAML and set `CODEX_MODEL`, `CODEX_ENDPOINT`, and `CODEX_API_KEY` before running it.

```yaml
services:
  codex:
    model: ${CODEX_MODEL}
    base_url: ${CODEX_ENDPOINT}
    api: openai-responses
    api_key: ${CODEX_API_KEY}
benchmark:
  name: gsm8k
  solver:
    name: codex
    service: codex
environment: local
run:
  maxTasks: 1
output:
  directory: ./results/codex
```

- Set `base_url` to the API base, for example `https://api.openai.com/v1`. Codex sends requests to `/responses` under that base. `contextWindow` sets the automatic compaction threshold. The solver rejects the `maxTokens` and `retry` service fields.
- Local runs use the Codex `workspace-write` sandbox. If the Windows sandbox blocks task commands, use Docker or WSL for evaluations that write files. Select `environment: docker` for container-based benchmarks such as TerminalBench.
- For images and PDF attachments in `pages` mode, set `inputModalities: [text, image]` on the service. Codex passes both as images. Task skills directories and task MCP configuration are unsupported. Each attempt saves Codex events, the Evaluator trajectory, and stderr under `agent/`. See [image and PDF evaluations](multimodal.md).

## Claude Code

Evaluator installs Claude Code `2.1.322` for local and Docker tasks. Save this experiment YAML and set `CLAUDE_MODEL`, `CLAUDE_ENDPOINT`, and `CLAUDE_API_KEY` before running it.

```yaml
services:
  claude:
    model: ${CLAUDE_MODEL}
    base_url: ${CLAUDE_ENDPOINT}
    api: anthropic-messages
    api_key: ${CLAUDE_API_KEY}
benchmark:
  name: gsm8k
  solver:
    name: claudecode
    service: claude
environment: local
run:
  maxTasks: 1
output:
  directory: ./results/claudecode
```

- Set `base_url` to the API base. Claude Code sends requests to `/v1/messages` under that base and authenticates via `x-api-key`. Use `https://api.anthropic.com` for Anthropic or `https://api.deepseek.com/anthropic` for DeepSeek's compatible API.
- The built-in file tools are limited to the task workspace. The restricted CLI may use `Edit` to create files. Bash is available locally and in Docker, and it runs with the permissions of the host or container process. On Windows, install Git for Windows and set `CLAUDE_CODE_GIT_BASH_PATH` to its `bash.exe` if Claude Code cannot find it.
- On Linux, the runtime sends model requests through an attempt-local relay and clears its temporary credentials from Bash's environment.
- For images and PDF pages, declare `image` in the service's `inputModalities`. For native PDFs, declare `pdf` and use a Messages endpoint that accepts document content blocks. Task skills directories and task MCP configuration are unsupported. See [image and PDF evaluations](multimodal.md).
- `maxTokens` sets Claude Code's output token setting, and `contextWindow` sets the auto-compaction window between 100000 and 1000000 tokens. The solver rejects `retry`. Each attempt saves events, the trajectory, and stderr under `agent/`.

## ZCode

Evaluator builds ZCode CLI `0.17.1` from a pinned source archive during runtime preparation. The first run or `warmup` needs access to GitHub and the npm registry. Later runs reuse the build. Warmup requires no model credentials. See [network configuration](network.md) for mirror settings.

```yaml
services:
  zcode:
    model: ${ZCODE_MODEL}
    base_url: ${ZCODE_ENDPOINT}
    api: openai-completions
    api_key: ${ZCODE_API_KEY}
benchmark:
  name: gsm8k
  solver:
    name: zcode
    service: zcode
environment: local
run:
  maxTasks: 1
  preparation:
    environmentTimeoutSeconds: 1800
    roundTimeoutSeconds: 1800
output:
  directory: ./results/zcode
```

The preparation timeouts allow up to 30 minutes for the initial build and can be adjusted for your network.

Use the API base URL. Chat Completions and Responses usually use a URL ending in `/v1`. The solver also accepts `api: openai-responses` and `api: anthropic-messages`. Omit `maxTokens`, `contextWindow`, and `retry`.

ZCode enables Bash in local and Docker runs. Use local mode for trusted tasks since Bash runs with the host process's permissions. Install Git Bash for Bash tools on Windows. Use Docker for tasks that need container isolation.

For images and PDF pages, declare `image` in the service's `inputModalities`. For native PDFs, declare `pdf` and use an endpoint that accepts PDF input. Task skills and task MCP configuration are unsupported. Each attempt saves redacted session events, the Evaluator trajectory, and stderr under `agent/`. See [image and PDF evaluations](multimodal.md).

## TRAE CLI

Evaluator downloads and caches the official `traecli` version `0.214.1` on x64 Windows, WSL, and Linux Docker. The first run or `warmup` needs access to the TRAE release CDN. Warmup requires no model key. Download proxies use the [network configuration](network.md).

Set `TRAE_MODEL`, `TRAE_ENDPOINT`, and `TRAE_API_KEY` before running this experiment.

```yaml
services:
  trae:
    model: ${TRAE_MODEL}
    base_url: ${TRAE_ENDPOINT}
    api: openai-responses
    api_key: ${TRAE_API_KEY}
benchmark:
  name: gsm8k
  solver:
    name: trae
    service: trae
environment: local
run:
  maxTasks: 1
  preparation:
    environmentTimeoutSeconds: 900
    roundTimeoutSeconds: 900
output:
  directory: ./results/trae
```

- Set `base_url` to the API base, such as `https://api.openai.com/v1`. TRAE sends requests to `/responses` under that base. Omit `solver.config` or use `{}`, and omit the service fields `maxTokens`, `contextWindow`, and `retry`.
- WSL uses Bash and native Windows uses PowerShell. Both run in the `workspace-write` sandbox. Native Windows may need [TRAE sandbox initialization](https://docs.trae.cn/cli_get-started-with-trae-cli-2?lang=zh). Use WSL or Docker for tasks that require Bash. Docker runs Bash within the task container.
- Set `inputModalities: [text, image]` for images and PDF `pages` attachments. Native PDFs, task skills, and task MCP configuration are unsupported. Each attempt saves redacted session events, the Evaluator trajectory, and stderr under `agent/`. See [image and PDF evaluations](multimodal.md).

## CodeBuddy Code

Evaluator installs and caches the standalone `@tencent-ai/codebuddy-code` version `2.183.0` on x64 Windows, WSL, and Linux Docker. The first `warmup` or run uses the configured npm registry. Warmup requires no model key. Set `CODEBUDDY_MODEL`, `CODEBUDDY_ENDPOINT`, and `CODEBUDDY_API_KEY` to run this example.

```yaml
services:
  codebuddy:
    model: ${CODEBUDDY_MODEL}
    base_url: ${CODEBUDDY_ENDPOINT}
    api: openai-completions
    api_key: ${CODEBUDDY_API_KEY}
benchmark:
  name: gsm8k
  solver:
    name: codebuddy
    service: codebuddy
environment: local
run:
  maxTasks: 1
  preparation:
    environmentTimeoutSeconds: 900
    roundTimeoutSeconds: 900
output:
  directory: ./results/codebuddy
```

- Set `base_url` to the API base, such as `https://api.openai.com/v1`. You can also select `api: openai-responses`. The solver uses `maxTokens` as the model output limit. Omit `contextWindow` and `retry`, and omit `solver.config` or use `{}`.
- Native Windows exposes PowerShell. WSL and Docker expose Bash. Local commands run with the host process's permissions, so use local mode for trusted tasks. Docker commands run in the task container.
- A workspace `.codebuddy/models.json` can override the selected endpoint. The solver reports an error before starting CodeBuddy when the file is present. For images and PDF `pages` attachments, declare `inputModalities: [text, image]`. Native PDF, task skills, and task MCP configuration are unsupported. Each attempt saves redacted events, trajectory, and stderr under `agent/`. See [image and PDF evaluations](multimodal.md).

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
