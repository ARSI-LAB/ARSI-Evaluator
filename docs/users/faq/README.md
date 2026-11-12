# Frequently Asked Questions

> English | [中文](./README.zh-CN.md)

Choose the entry matching your issue. Dedicated guides define full configuration, execution policies, and scoring.

[User documentation](../README.md) · [Download FAQ](downloads.md) · [Docker FAQ](docker.md) · [Network diagnosis](network.md)

## Installation and Configuration

### Why does installing SimpleAgent also install AgentBundle?

Evaluator imports the AgentBundle SDK with its built-in plugins, so pnpm fetches and builds it even when you select SimpleAgent. `AGENT_BUNDLE_PATH` points to the bundle you want to evaluate. [Installation guide](../installation.md#install-from-source)

### Why is the command or configuration missing after changing directories?

[Register the global CLI](../installation.md#register-the-global-cli) and run in the same Linux, WSL, or Windows environment. Use an absolute YAML path. Internal relative paths use the YAML directory; `--patch` uses the current directory. See [running elsewhere](../installation.md#run-from-any-directory).

### Why can execution fail after doctor passes?

`doctor` checks selected downloads and Docker builds without model requests. `not-checked` means a check is incomplete. After checks pass, warm up and run a small task sample; see the [quick start](../quick-start.md#4-check-then-run).

## Downloads, Containers, and Resources

### What should I do about HF, GitHub, pip, or image download failures?

Identify whether logs concern data sources, task images, solver runtimes, or judge images; their download sources may differ. See [download FAQ](downloads.md) for access, proxies, mirrors, and caches. Tasks with explicit network evidence can use [network recovery](../network-retry.md).

### Why is preparation taking so long before any task starts?

Batch mode prepares images/runtimes for selected tasks before attempts. First downloads and cold builds may be slow. Inspect `[prepare]` logs and preparation rounds rather than simply extending the agent deadline. See [concurrency and preparation](../concurrency.md).

### Will restarting after interruption download or build every image again?

See [Docker FAQ](docker.md#will-restarting-redownload-or-rebuild-every-image) for reuse conditions, rebuild causes, and ordinary runs versus `--resume`.

### How can I distinguish solve, verify, and shared images for each task?

Shared image tags identify the `solve` or `verify` phase and image kind. See [Docker image names](docker.md#identify-and-inspect-task-images) for inspection commands and legacy tags.

### What about amd64 emulation crashes, CPU counts, or cleanup failures?

See [Docker FAQ](docker.md) for platform checks, Go/esbuild compatibility, public code cache warmup, CPU budgets, evidence permissions, and cleanup. Working emulation does not imply native performance.

## Agents and Models

### Truncated Model Replies (SOLVER_OUTPUT_LIMIT)

`stopReason=length` means length-limited output. Reasoning models may exhaust their budget before text or tools. For `provider-default`, check server output/context limits. For explicit `maxTokens`, consider increasing it within service limits.

With an explicit OpenAI Chat Completions `base_url` and omitted `maxTokens`, SimpleAgent and built-in judges send no client output cap. Ordinary truncation does not trigger context compaction. Other providers/harnesses have their own settings; see [model services](../solvers.md#model-services-and-independent-judges).

### Does a truncated DSH event mean the tool failed?

Not necessarily. DSH saves large tool output in full files while events contain previews. Follow `resultRef` and inspect status/manifests. See [DSH output](../usage.md#dsh-tool-output). This differs from model token truncation.

### Can Dify deliver Office or code files?

The AgentBundle Dify harness returns text without syncing workflow files to the environment. File tasks need SimpleAgent or a file-capable AgentBundle. See [Dify requirements](../solvers.md#dify).

## Benchmarks and Scoring

### Does WorkBuddy Office always require a judge?

No. Office defaults to rule scoring; model rubrics activate when a judge is bound. Web requires a judge; visual checks also require image input support. See [WorkBuddy](../benchmarks/workbuddy.md#upstream-workbuddy-compositeverifier) for scenarios and disabling judges.

### Why should Security not be extracted on Windows paths?

Security tasks include security samples. Store YAML, caches, and output on native Linux filesystems under Linux/WSL, avoiding `/mnt/c` and `/mnt/d`. See [Security](../benchmarks/workbuddy.md#sec-on-windows--wsl).

### Why is AgentX replay not a formal score?

Replay completes finite traces, including startup, waits, and drain. Its sampling differs from standard's one-hour measurement window, so it is not a standard result. AgentX produces no quality score. See [AgentX](../benchmarks/agentx.md) for comparability.

### How do success, zero score, invalid results, and cleanup failures differ?

Successful exit means the process completed, not that answers were correct. Inspect `executionStatus`, `scoreStatus`, and `cleanupStatus`, rather than only text or exit codes. See [scoring](../reference/scoring.md) and [error codes](../reference/errors.md) for valid zeros, agent timeouts, infrastructure failures, and missing scores.

### Why can I not resume after changing configuration?

Resume requires matching sources, selection, model settings, external plugins, candidate bundles, and harness versions. Evaluator code may be updated and rebuilt before resuming; valid saved results remain, and other tasks use the new code. Start a new run after task count, concurrency, preparation, or model changes. Old results still support offline reports. See [resume](../usage.md#resume-and-rebuild-reports).

## Debug Logs

Errors show phase, task, cause, and suggested action. Full attempt diagnostics are in `result.json`; preparation diagnostics are in `manifest.json`. For extra detail, run from the repository root:

```bash
EVALUATOR_DEBUG=1 ember-evaluator run playbook/gsm8k/gsm8k-simpleagent.yaml
```

`1`/`true` enables debug; unset or `0`/`false` disables it. PowerShell: `$env:EVALUATOR_DEBUG="1"`. Progress/errors use stderr; final result paths use stdout. See [error codes](../reference/errors.md) for classification and recovery.
