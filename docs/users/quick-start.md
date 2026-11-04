# Quick Start: Run Two Questions

> English | [中文](./quick-start.zh-CN.md)

Use your model API to solve two GSM8K questions and produce an offline report. Run commands from the Evaluator repository root.

## 1. Install and Build

Complete the [installation guide](installation.md#install-from-source). This local example requires neither Docker nor Ray; the agent executes tools on your machine.

The following examples use the `ember-evaluator` command registered by the installation guide. Run them from the Evaluator repository root.

## 2. Choose a Benchmark and Generate Configuration

```bash
ember-evaluator benchmark list
ember-evaluator benchmark info gsm8k
ember-evaluator init --benchmark gsm8k --output first-run.yaml
```

`list` shows available names, `info` shows default components, and `init` generates configuration. `init` fails rather than overwriting an existing file.

Replace `first-run.yaml` with this complete configuration:

```yaml
services:
  default:
    model: ${MODEL_NAME}
    base_url: ${MODEL_ENDPOINT}
    api_key: ${MODEL_API_KEY}

benchmark: gsm8k
environment: local
scheduler:
  concurrency: 1
run:
  maxTasks: 2
  timeoutSeconds: 300
output:
  directory: ./results/first-run
```

This selects GSM8K, default SimpleAgent, local execution, one concurrent task, and two questions. `timeoutSeconds` is the total per-task budget. Initial runtime installation and data reads add overhead beyond model response time.

**Keep `environment: local` in this example.** The framework default is Docker; `init gsm8k` does not select local execution automatically.

## 3. Set Model Variables

Use a model service supporting OpenAI Chat Completions and tool calling. Set `MODEL_NAME` to an accepted model ID and `MODEL_ENDPOINT` to the API base URL, such as a URL ending in `/v1`, rather than a web chat page.

Bash on Linux, WSL, or macOS:

```bash
export MODEL_NAME="your-model-id"
export MODEL_ENDPOINT="https://your-model-service.example/v1"
read -rsp 'Model API key: ' MODEL_API_KEY
printf '\n'
export MODEL_API_KEY
```

Windows PowerShell：

```powershell
$env:MODEL_NAME = "your-model-id"
$env:MODEL_ENDPOINT = "https://your-model-service.example/v1"
$modelKey = Read-Host "Model API key" -AsSecureString
$env:MODEL_API_KEY = [System.Net.NetworkCredential]::new("", $modelKey).Password
```

Replace the example model and URL, then enter the key at the prompt. Keep `${MODEL_API_KEY}` in YAML rather than embedding a secret. Variables apply only to the current terminal and child processes; set them inside WSL when running there.

Without `maxTokens`, SimpleAgent using an explicit Chat Completions service sends no client output limit; the server decides. Server output or context limits may still truncate responses. See [model configuration](solvers.md#model-services-and-independent-judges).

## 4. Check, Then Run

```bash
ember-evaluator doctor first-run.yaml
ember-evaluator run first-run.yaml
```

`doctor` checks configuration, authentication references, and required tools for the selected path. It does not send model requests, download datasets, or build images. `not-checked` means untested, not passed. Actual execution verifies model and data access.

`run` reads data and calls the model. Logs show preparation, solving, verification, and reporting. It prints a directory like this; `<RUN_ID>` is generated for this `run`:

```text
results/first-run/<RUN_ID>
```

Remaining in preparation does not necessarily mean a hang: first use reads data and installs dependencies; Docker tasks may pull or build images. Inspect the latest phase and errors before retrying.

## 5. Open the Report

Open `report.md` in that directory. `metrics.json` contains the same statistics as JSON; `tasks/` holds attempts and evidence.

To regenerate the report later:

```bash
ember-evaluator report results/first-run/<RUN_ID>
```

Replace `<RUN_ID>` with the actual directory name. Offline reporting needs no model key and does not rerun questions. Keep the complete result directory, rather than copying only `result.json`.

Check completion, scores/correctness for both questions, and errors or missing evidence. **A successful exit does not mean both answers were correct.**

## 6. Resume After Interruption

Keep configuration, code, and plugin versions unchanged and use the same YAML:

```bash
ember-evaluator run first-run.yaml --resume
```

Use `--resume <RUN_ID>` to select a run explicitly. Resume skips valid saved results and creates new attempts for unfinished or invalid tasks; it does not continue at a conversation turn. Start a new run after changing models, tasks, concurrency, or similar settings. Keep fingerprint and version checks enabled.

## Next Steps

- [Daily operations](usage.md): task selection, concurrency, timeouts, result files, errors, and CLI commands.
- [Solvers and model services](solvers.md): AgentBundle, independent judges, Dify, and AgentX.
- [Terminal-Bench 4.0](quick-start/terminalbench.md): run Docker terminal tasks with existing YAML. See [Harbor](benchmarks/harbor.md) for Office, Code, Web, Security, and DeepSWE.
- [AgentX performance](quick-start/agentx.md): configure long-context services, tokenizer, and collection, then check configuration and run a formal measurement.
- [User guide](README.md): all capabilities and dedicated guides.
