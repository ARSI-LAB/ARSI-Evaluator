# Docker and Cross-Architecture FAQ

> English | [中文](./docker.zh-CN.md)

[FAQ index](README.md) · [Docker platforms](../deployment/docker-platform.md)

Run shell commands from the Evaluator root and merge YAML fragments into actual experiments.

## Configure image sources and proxies

Pass a separate network YAML with `--network network.yaml`. `docker.pull.method` selects native Docker or Registry API downloads, `docker.mirrors` rewrites the registry for explicit acquisition, and `docker.benchmarks` can select ModelScope/Hugging Face image archives.

Registry API acquisition supports the built-in Node.js client and user-installed skopeo. Configure proxies under `proxy`, with separate `host`, `daemon`, `build`, and `runtime` overrides. See [proxy configuration](../reference/network.md) for credentials and node addresses, and [image downloads](../image-downloads.md) for archive paths.

`FROM` and external `COPY --from` use Docker's built-in builder and the daemon's active network settings. `doctor experiment.yaml` generates application guidance without changing files or restarting Docker. After an administrator applies it, use `doctor experiment.yaml` to check explicit acquisition, `FROM`, and `RUN` independently.

## Identify and Inspect Task Images

Local images use `ember-evaluator/<short-task>:<purpose>-<kind>-<hash>`. `solve` and `verify` identify solving and verification; the suffix distinguishes tasks and content. Use the task name or purpose to find images:

For `terminal-bench/atrx-vep-crispr`:

| Kind | Example |
| --- | --- |
| Pinned official solve image | `ember-evaluator/atrx-vep-crispr:solve-base-<hash>` |
| Solve runtime | `ember-evaluator/atrx-vep-crispr:solve-runtime-<hash>` |
| Final solve image with agent | `ember-evaluator/atrx-vep-crispr:solve-agent-<hash>` |
| Pinned official verify image | `ember-evaluator/atrx-vep-crispr:verify-base-<hash>` |
| Verify runtime | `ember-evaluator/atrx-vep-crispr:verify-runtime-<hash>` |
| Task Dockerfile, when needed | `ember-evaluator/atrx-vep-crispr:solve-task-<hash>` or `verify-task-<hash>` |
| Agent build runtime reference, when needed | `ember-evaluator/atrx-vep-crispr:solve-agent-base-<hash>` |
| Sidecars, when needed | `ember-evaluator/atrx-vep-crispr:verify-service-redis-base-<hash>`, plus `verify-service-redis-task-<hash>` for builds |
| Shared agent installation | `ember-evaluator/shared:solver-install-<hash>` |
| Internal gateway reference, when needed | `ember-evaluator/shared:gateway-base-<hash>` |

Fixed-digest official task images receive local Evaluator names. Original official tags may be removed, but image content and official sources in results stay unchanged. Agent images are created only when installation is needed, so not every task has every image kind.

Inspect one task, all verification images, or shared images:

```bash
docker image ls --filter 'reference=ember-evaluator/atrx-vep-crispr:*'
docker image ls --filter 'reference=ember-evaluator/*:verify-*'
docker image ls --filter 'reference=ember-evaluator/shared:*'
```

Images can be reused for the same task, purpose, and content. Multiple tags can share an IMAGE ID without duplicating the image, and different images can share layers. Use `docker system df` for disk usage rather than summing SIZE from `docker image ls`.

Alongside Docker images, Evaluator stores local records needed for reuse under `EVALUATOR_CACHE_DIR/docker-images/`, or the application cache directory when unset. Toolbox typically uses `/toolbox-home/.cache/ember-evaluator/docker-images/`. Copying images without these records may still require downloading again.

Preparation fails if local image tags were replaced or the platform does not match. Check Docker context, target platform, and cache directory first. To clean up and prepare again, follow [delete evaluation images](../usage.md#delete-evaluation-images), then run `warmup`.

If an upgrade changes image names, first preparation may rebuild, while Docker can still reuse existing layers. Old images and containers using them are not deleted automatically; renaming alone does not free disk space.

## Will Restarting Redownload or Rebuild Every Image?

Normally no. Completed images/tags on the same daemon are reused when identities, runtime code, installation files, and arguments match. Interruption does not delete completed images; incomplete builds are not reusable final images.

| Kind | Repeat behavior |
| --- | --- |
| Official task, service, and Node images | Reuse usable local content; download missing images |
| Task Dockerfile images | Reuse when build files, arguments, and platform are unchanged |
| Runtime images | Reuse when task/Node images, runtime code, and platform are unchanged |
| Agent installation and final solve images | Reuse when relevant base images, Agent files, installation commands, and arguments are unchanged |

Runs still check selected environments, so Preparing solve image and runtime environment/Task image ready logs repeat without proving downloads/builds. `source=explicit image reference` means configuration supplied an address, not whether it was cached/pulled. Runtime/Solver work may follow. See [preparation](../concurrency.md).

Solve/verify may use different official images and both need runtimes. Seeing solve ready does not prove verification/full-task readiness; later runs may download previously unprepared verify images.

Re-pulls/builds may occur when:

- Interruption preceded build completion.
- Images/tags were deleted or Docker context/daemon changed; local/Ray caches are not shared automatically.
- Task/Node images, platforms, runtime programs, Solver files/dependencies, or build args changed.
- Switching Docker backends makes previous images or build caches unavailable.
- Naming upgrades/task IDs/purpose changes select different tags.

Docker may still reuse build layers; its cache determines which steps rerun.

**Image reuse and task resume are separate.** Ordinary `run` creates a new evaluation, reuses images, and creates fresh containers/workspaces without skipping previous completed tasks:

```bash
ember-evaluator run playbook/terminalbench/terminalbench-4.0.yaml
```

To continue the previous evaluation, use identical configuration with `--resume`:

```bash
ember-evaluator run playbook/terminalbench/terminalbench-4.0.yaml --resume
```

Resume still checks/prepares environments, skips valid results, and reruns unfinished/invalid tasks. Evaluator code may be updated and rebuilt; configuration, sources, external plugins, candidate bundles, and harness versions must still match. See [resume](../usage.md#resume-and-rebuild-reports). New runs without resume also reuse images.

## Can ARM64 Nodes Run amd64 Images?

Existing QEMU/binfmt can run them. Passing probes establishes basic execution, not universal compatibility/native performance. Follow task-declared platforms; otherwise choose `linux/amd64` in YAML. Missing emulation/format incompatibility are infrastructure errors. See [platform checks/setup](../deployment/docker-platform.md).

## Go or esbuild Crashes Under amd64 Emulation

runtime: lfstack.push invalid packing/fatal error: lfstack.push indicates Go/x86 user-emulation incompatibility, potentially affecting Go-built esbuild. Longer verifier deadlines do not fix it.

Try this compatibility configuration only for affected experiments, checking one task first:

```yaml
environment:
  name: docker
  config:
    platform: linux/amd64
    containerEnv:
      GOGC: "off"
      GOMAXPROCS: "2"
```

`containerEnv` enters only this experiment's solve/verify containers, not other containers/host. It is unset by default; keep keys out. `GOGC=off` disables automatic GC and increases memory use; retain limits. `GOMAXPROCS` is Go parallelism, not evaluation concurrency.

These settings change no official tests/patches/scoring and do not establish native performance. Test one affected task or saved patch rather than rerunning all. Save evidence in new output directories, preserving originals.

## Constrain Python Dependencies in Older Tasks

`environment.config.buildPipConstraints` maps full task IDs to pip version constraints:

```yaml
environment:
  name: docker
  config:
    buildPipConstraints:
      workbuddy/bug_fix-medium-incorrect_linenos_on_fstring:
        - pytest<8
      workbuddy/feature-medium-add_support_for_dependencies:
        - pytest<8
        - anyio<4.15
```

These constraints apply to pip installation during task image builds and remain active in the resulting containers. Changing constraints rebuilds the relevant images without modifying original dataset files.

Only package/version comparisons are accepted, excluding URLs/options/extras/markers/multiline. `*` supplies defaults for unspecified main images; task lists override, empty disables. Sidecars exclude constraints. Omission preserves behavior; prebuilt images do not reinstall. Apply only confirmed incompatibilities, since some tasks need new pytest.

## Cold Go Builds Exhaust Verification Budgets

`GOGC=off` diagnoses compatibility but does not remove emulated compilation cost. `go build ./...` can exhaust native budgets. Avoid global `GOCACHE` overrides, which bypass existing warmed `/tmp/gocache` or similar. Choosing a cache directory alone does not remove initial builds.

Build public baseline caches separately and map exact images with imageOverrides. Warmup compiles public source only, verifies commit/clean workspace, uses offline2-CPU8-GiB containers, retains derived images, and removes temporary containers. Preserve declared `GOCACHE` or default `/root/.cache/go-build`, saved in derived env. Original tags remain. Initial compilation still costs time; later containers reuse caches.

```bash
bash scripts/prewarm-go-image.sh \
  'public-task-image-reference' \
  'ember-evaluator-prewarm:task-name' \
  'full-base_commit_hash-from-task.toml'
```

Argument4 selects public module paths such as `/app/backend`; later args limit public packages such as ./internal/services. Defaults run `go build ./...` in /app. Never point to hidden tests or solved workspaces.

```yaml
environment:
  name: docker
  config:
    platform: linux/amd64
    imageOverrides:
      "public-task-image-reference": "ember-evaluator-prewarm:task-name"
    containerEnv:
      GOGC: "off"
      GOMAXPROCS: "2"
```

Mappings default empty, match exactly once without recursion, and affect only task images, not fixed Node/gateway. Results save actual references/IDs; config retains mappings. Public build-context/content validation remains.

Use original public task images, not containers after solving/hidden tests. Each new task gets independent writable layers; verifier caches do not return to solvers. Do not alter tests/budgets to inflate scores. Validate warmed images with the same saved patch, logs, identities, and scores.

## Does a Large Visible CPU Count Mean That Budget Is Available?

Harbor TOML CPU budgets reach solve/verify. Docker constrains quotas and affinity: budget 2 makes `nproc` and Node `os.availableParallelism()` return 2. A Node preload also trims `os.cpus().length` for older Vitest/Jest across CJS/ESM/inheriting child processes.

Applied automatically per task without YAML hardcoding/image rebuilds. CPU sets choose permitted IDs across tasks but are not exclusive reservations; Scheduler still controls task concurrency. Fractional quotas stay exact, visible cores round up. No-budget environments retain behavior.

Existing `NODE_OPTIONS` remain. `result.json` `environments.solve/verify.resources.effective` adds cpusetCpus/availableCpus. Failed application/visibility checks yield `ENV_CPU_BUDGET_FAILED` rather than host-count fallback. Only newly created task containers change.

This limits available parallelism, not all hardware discovery. Python 3.12 os.cpu_count()/nproc --all may still show host totals. Use `len(os.sched_getaffinity(0))` and explicit TOML budgets in tests. Raw hardware counts do not define available budgets. See Terminal-Bench [check-nproc](https://github.com/harbor-framework/terminal-bench/blob/main/docs/TASK_REVIEW_AUTOMATION.md#check-nproc).

Preventing accidental test overparallelism removes one OOM cause, without guaranteeing all tasks fit8 GiB. Patches/typechecking/tests may still need more memory; investigate separately.

## Do Cleanup or Collection Failures Mean Wrong Answers?

No. In `result.json`, `scoreStatus` determines validity and `cleanupStatus` confirms release; `files.json` lists missing/unreadable evidence.

- CLEANUP_TIMEOUT/CLEANUP_FAILED: inspect container IDs, operations, and daemon. Unconfirmed release stops dispatch; recover cleanup before resume. Whole-task limits do not extend cleanup.
- `ARTIFACT_COLLECTION_INCOMPLETE`: trajectories/sessions/deliverables may be missing. Valid verifier scores remain with incomplete evidence.
- `Workspace transfer cleanup failed`: may precede verification; not an ordinary zero.

Retain original diagnostics. Avoid global Docker cleanup during other evaluations or recursive chmod777. See [error policies](../reference/errors.md).

## Inspect Container EACCES Errors

Find the exact unreadable file in `files.json`, then inspect task `USER`, ownership/permissions, and host result mounts. Unreadable sessions/trajectories do not imply missing scores.

Framework phase handoffs manage log permissions while retaining task/archive permissions. Python verifiers write as result-directory owners. Do not hide problems by recursively opening all files. Upgrades do not rewrite existing manifests; retain diagnostics and create new attempts.

## Build Networking or Older Docker API Incompatibility

For local Linux daemons only, choose `scripts/toolbox/docker-host.sh` via environment.config.dockerExecutable. It provides host build networking/old-API platform inspection. See [management container](../deployment/container-toolbox.md#build-networking-and-older-docker-apis) for configuration/boundaries. Do not apply directly to remote daemons.
