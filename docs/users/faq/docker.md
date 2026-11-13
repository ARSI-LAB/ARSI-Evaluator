# Docker and Cross-Architecture FAQ

> English | [中文](./docker.zh-CN.md)

[FAQ index](README.md) · [Docker platforms](../deployment/docker-platform.md)

Run shell commands from the Evaluator root and merge YAML fragments into actual experiments.

## Configure image sources and proxies

Pass a separate network YAML with `--network network.yaml`. `docker.pull.method` selects native Docker or Registry API downloads, `docker.mirrors` rewrites the registry for explicit acquisition, and `docker.benchmarks` can select ModelScope/Hugging Face image archives.

Registry API acquisition supports the built-in Node.js client and user-installed skopeo. Configure proxies under `proxy`, with separate `host`, `daemon`, `build`, and `runtime` overrides. See [proxy configuration](../reference/network.md) for credentials and node addresses, and [image downloads](../image-downloads.md) for archive paths.

`FROM` and external `COPY --from` use Docker's built-in builder and the daemon's active network settings. `doctor experiment.yaml` generates application guidance without changing files or restarting Docker. After an administrator applies it, use `doctor experiment.yaml` to check explicit acquisition, `FROM`, and `RUN` independently.

When a task image lacks system CA certificates, Evaluator writes the pinned Node.js version's bundled public roots to `/etc/ssl/certs/ca-certificates.crt` while building the derived runtime image. Existing CA certificates and explicitly configured certificate paths are preserved. This supplies trust roots for HTTPS clients that use the system store, including Codex.

## Identify and Inspect Task Images

Evaluator reuses references by actual image ID on the same Docker daemon. Newly prepared images retain at most one Evaluator-managed tag per ID, and can reuse existing source references. Each attempt starts a separate container from its final image ID.

Evaluator generates references in the form `ember-evaluator/<repository-path>:<platform>-<purpose>`. In `ember-evaluator/terminalbench4.0/coq-block-bound:linux-amd64-solver-codex`, each part has a specific meaning.

- `ember-evaluator` is the Evaluator image namespace.
- `terminalbench4.0/coq-block-bound` identifies the benchmark version and task path. Harbor uses this structure for task-provided images. A shared benchmark image uses just the benchmark name, such as `officeqa-pro-v2`. The default solve environment uses `base`.
- `linux-amd64` represents the Docker platform `linux/amd64`. ARM64 uses `linux-arm64`.
- `solver-codex` identifies the image used to launch Codex. The `base` purpose marks a base image, `verify` marks a separate verifier image, and `solve-service-redis` marks a Redis sidecar for the solve phase. Verification sidecars use `verify-service-<service>`.

| Retained image | Example reference |
| --- | --- |
| Default solve base | `ember-evaluator/base:linux-amd64-base` |
| Harbor task base | `ember-evaluator/terminalbench4.0/coq-block-bound:linux-amd64-base` |
| Solver image | `ember-evaluator/terminalbench4.0/coq-block-bound:linux-amd64-solver-codex` |
| Shared OfficeQA Pro V2 corpus | `ember-evaluator/officeqa-pro-v2:linux-amd64-base` |
| Separate verification image | `ember-evaluator/officeqa-pro-v2:linux-amd64-verify` |
| Sidecar | `ember-evaluator/terminalbench4.0/example:linux-amd64-solve-service-redis` |
| Separately acquired shared Node image | `ember-evaluator/node:linux-amd64-base` |

When a tag already points to a different image, the next image gets a suffix such as `-2` or `-3`. The suffix distinguishes images that would otherwise have the same tag. Tasks and roles that resolve to the same image ID share its registered reference. For example, a verifier image shared by two tasks may appear under just one task path.

ModelScope uses its archive file layout. A local `linux-amd64-base` tag for a task base corresponds to `linux/amd64/solve.tar.gz` in the dataset repository. See the [archive layout](../../development/image-archives.md#文件布局) for verification and sidecar paths.

One multi-stage build adds the Solver installation and runtime helpers to the final solve image. Different solve bases can reuse the installation stage in BuildKit. Preparation releases temporary build tags. Separate verification retains the image used to start the verifier and any sources still used by other tasks.

List images by benchmark.

```bash
docker image ls --filter 'reference=ember-evaluator/terminalbench4.0/*:*'
docker image ls --filter 'reference=ember-evaluator/officeqa-pro-v2:*'
```

Different images can share layers. Use `docker system df` for disk usage.

Alongside Docker images, Evaluator stores local records needed for reuse under `EVALUATOR_CACHE_DIR/docker-images/`, or the application cache directory when unset. Toolbox typically uses `/toolbox-home/.cache/ember-evaluator/docker-images/`. Copying images without these records may still require downloading again.

Preparation fails if local image tags were replaced or the platform does not match. Check Docker context, target platform, and cache directory first. To clean up and prepare again, follow [delete evaluation images](../usage.md#delete-evaluation-images), then run `warmup`.

When preparation hits an older tag, Evaluator replaces it with a readable tag once containers and other preparations release the image. Cache lookups still use build inputs and image IDs. Use `cleanup images --all` to preview cleanup of older tags.

## Will Restarting Redownload or Rebuild Every Image?

Normally no. Completed images/tags on the same daemon are reused when identities, runtime code, installation files, and arguments match. Interruption does not delete completed images; incomplete builds are not reusable final images.

| Kind | Repeat behavior |
| --- | --- |
| Official task, service, and Node images | Reuse usable local content; download missing images |
| Task Dockerfile images | Reuse when build files, arguments, and platform are unchanged |
| Runtime images | Reuse when task/Node images, runtime code, and platform are unchanged |
| Final solve images with an Agent | Reuse when relevant base images, Agent files, installation commands, and arguments are unchanged |

Runs still check selected environments, so Preparing solve image and runtime environment/Task image ready logs repeat without proving downloads/builds. `source=explicit image reference` means configuration supplied an address, not whether it was cached/pulled. Runtime/Solver work may follow. See [preparation](../concurrency.md).

Solve/verify may use different official images and both need runtimes. Seeing solve ready does not prove verification/full-task readiness; later runs may download previously unprepared verify images.

Re-pulls/builds may occur when:

- Interruption preceded build completion.
- Images/tags were deleted or Docker context/daemon changed; local/Ray caches are not shared automatically.
- Task/Node images, platforms, runtime programs, Solver files/dependencies, or build args changed.
- Switching Docker backends makes previous images or build caches unavailable.

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
