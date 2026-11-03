# Terminal-Bench 4.0 Quick Start

> English | [中文](./terminalbench.zh-CN.md)

Run terminal tasks in Docker with the default SimpleAgent and inspect results from the task verifier. This page uses the repository's 4.0 configuration; `benchmark: terminalbench` alone defaults to 2.0.

[Project home](../../../README.md) · [User documentation](../README.md) · [All configurations](../../../playbook/README.md)

## 1. Install and Prepare Docker

Follow [source installation](../installation.md#install-from-source) to configure GitHub read access, then install and build Evaluator. The AgentBundle SDK downloads and builds automatically; no manual clone is required.

Run these commands from the Evaluator root with `node dist/cli.js`; global registration is unnecessary. The machine needs Docker Engine and access to the model API, task data, and images.

```bash
docker version
node dist/cli.js --help
```

Official 4.0 prebuilt images use `linux/amd64`, explicitly selected by the example. ARM64 nodes require QEMU/binfmt. See [Docker platform selection](../deployment/docker-platform.md).

## 2. Configure the Model and Check Configuration

Set `MODEL_NAME`, `MODEL_ENDPOINT`, and `MODEL_API_KEY` in the execution terminal using the [model variable instructions](../quick-start.md#3-set-model-variables). The service must support tool calling.

Use [terminalbench-4.0.yaml](../../../playbook/terminalbench/terminalbench-4.0.yaml) to inspect expanded configuration and prerequisites:

```bash
node dist/cli.js config explain playbook/terminalbench/terminalbench-4.0.yaml
node dist/cli.js doctor playbook/terminalbench/terminalbench-4.0.yaml
```

`doctor` does not call models, download tasks, or pull images. Confirm `not-checked` items through actual execution. The following preview may download task data:

```bash
node dist/cli.js run playbook/terminalbench/terminalbench-4.0.yaml --dry-run
```

## 3. Run Tasks

The example has no task limit and runs all supported tasks. For a first run, add the following to run two tasks. See [task selection and concurrency](../usage.md#task-selection-and-concurrency) for fixed IDs and sampling.

```yaml
run:
  maxTasks: 2
```

```bash
node dist/cli.js run playbook/terminalbench/terminalbench-4.0.yaml
```

Docker prepares the task environment; the agent operates inside the container, and the task verifier checks completion. Initial image pulls may be slow. See [Harbor execution and verification boundaries](../benchmarks/harbor.md#execution-and-verification-boundaries) for environments, networking, and verification materials. Once execution works, remove `run.maxTasks` and start a new full experiment.

## 4. Read Reports and Resume

The example writes to `results/terminalbench-4.0/<RUN_ID>/`. Open `report.md` for scores, duration, and failures; inspect `tasks/` for attempts, trajectories, and verification evidence.

With configuration, code, and plugin versions unchanged, resume unfinished tasks:

```bash
node dist/cli.js run playbook/terminalbench/terminalbench-4.0.yaml --resume
```

Switching from two tasks to the full dataset changes configuration and requires a new run. See [daily operations](../usage.md#resume-and-rebuild-reports) for resume and offline reports.

After [global CLI registration](../installation.md#register-the-global-cli), run from any directory:

```bash
ember-evaluator run '/path/to/ember-evaluator/playbook/terminalbench/terminalbench-4.0.yaml'
```

See [solvers and model services](../solvers.md) to change agents, or [Harbor](../benchmarks/harbor.md) for other Harbor tasks.
