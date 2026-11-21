# Terminal-Bench Science Evaluation

> English | [中文](./terminalbench-science.zh-CN.md)

Select the built-in profile with `benchmark.name: terminalbench-science`. The default version is `0.1`, also selectable as `0.1.0`, pinned to the official v0.1.0 task package.

[Benchmarks](README.md) · [Playbook](../../../playbook/terminalbench-science/terminalbench-science-simpleagent.yaml)

## Versions and Configurations

| Version | Configuration and requirements |
| --- | --- |
| 0.1 (0.1.0) | [SimpleAgent example](../../../playbook/terminalbench-science/terminalbench-science-simpleagent.yaml), official GitHub source at commit `f81afac`, Docker, shell verifiers |

The v0.1.0 package contains 70 tasks; this does not mean all have been executed or passed. Task declarations allow 28800 seconds of agent time, and the profile sets an outer task budget of 86400 seconds. See the [profile](../../../src/plugins/benchmarks/agent-harness/profiles/terminalbench-science.yaml) for the exact source revision and defaults.

## Dataset and Task Layout

Tasks are nested as `tasks/<domain>/<field>/<task>/`, grouped into 20 domain/field directories across five domains. The profile materializes the repository `tasks/` directory as the source snapshot and scans it with:

```yaml
tasks:
  root: .
  id: task.name
  depth: 3
  expectedCount: 70
```

Task IDs are the names declared in `task.toml`, such as `terminal-bench-science/ambient-rna-correction`; record keys keep the three-level relative path, so IDs stay stable and unique as long as the upstream package does not rename a task. `depth: 3` is the number of directory levels searched below `tasks.root`; directories without `task.toml` are descended into until that limit, and directories containing `task.toml` are treated as tasks. Missing the expected count fails the source lock instead of silently dropping tasks.

The GitHub source is pinned to commit `f81afac4f11048e77a15dfc8fb1dbfb897fea0ce` (tag `v0.1.0`), so enumeration, resume, and audit use the same snapshot. Changing version or source requires a new run.

## Environments and Support

Tasks build from their own `environment/Dockerfile` and declare separate shell verification with `tests/Dockerfile`, pinned resources, and a `no-network` verifier. The framework follows the shared [Harbor execution and verification rules](harbor.md#execution-and-verification-boundaries): image selection, preparation budgets, artifacts declared under paths such as `/root/results` or `/app`, and host-side collection. Resources are declared per task, up to 12 GB memory and storage; insufficient resources produce `ENV_RESOURCE_REQUIREMENTS_UNMET` rather than partial runs.

No task ships a prebuilt image, so the first run builds images and downloads their base layers; configure network access accordingly. ARM64 nodes need QEMU/binfmt only for tasks whose base images are amd64; see [Docker platforms](../deployment/docker-platform.md). Removing failing tasks does not produce full-dataset results.

Results go to the experiment output directory and use native verifier rewards. Start a new run after changing version or source; do not bypass source locks to resume an old experiment.
