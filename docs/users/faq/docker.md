# Docker and Cross-Architecture FAQ

> English | [中文](./docker.zh-CN.md)

[FAQ index](README.md) · [Docker platforms](../deployment/docker-platform.md)

Run shell commands from the Evaluator root and merge YAML fragments into actual experiments.

## Configure a Proxy Only for Image Pulls

Set an HTTP/HTTPS proxy in Docker environment options:

```yaml
environment:
  name: docker
  config:
    pullProxy: ${DOCKER_PULL_PROXY}
```

For local Clash, a variable may contain http://127.0.0.1:7890. Evaluator's process accesses it; inside containers/Ray, loopback means that container/node, so supply a reachable address. HTTP/HTTPS and URL proxy authentication are supported, not SOCKS.

For missing images, Evaluator proxies registry authentication/manifests/layers, verifies digests/platforms, archives them, and docker-loads into the current daemon. Registry credentials come from the execution user's config.json/credHelpers/credsStore; public images allow anonymous access. Temporary compressed/expanded/archive files require disk and are cleaned on failure/cancellation. Verified local images/source credentials can be reused.

This applies only to framework-fetched task/verification/sidecar/runtime images. It changes no system/daemon proxies and enters no Dockerfile args, containers, data downloads, or model requests. Docker/BuildKit still fetches `FROM` images. Existing system/Docker globals retain their effect. Proxy credentials are redacted; use variable references for restoration from saved configuration.

Omission retains native docker pull. Explicit proxy failures remain errors without direct/alternate fallback. HTTPS uses normal TLS; loopback registries may use HTTP. Remote insecure-registry/certificate-bypass daemon settings are not inherited automatically.

## Identify and Inspect Task Images

Generated names are `ember-evaluator/<short-task>:<purpose>-<kind>-<hash>.` solve/verify identify phases. Short names use the last task ID segment in valid lowercase; hashes include full IDs to distinguish datasets.

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

Digest-pinned external task images receive local Evaluator names. After validating digest/platform/ID and saving provenance, the program removes the corresponding official digest and declared tags still pointing to that image, without deleting content/forcing removal. Official task/result sources stay intact. Agent images exist only when installation is needed; not every task has every image. `materialize` without task context uses shared/solve and skips official-reference migration. Mutable tags, generated images, and pinned Node retain existing handling.

Inspect one task, all verification images, or shared images:

```bash
docker image ls --filter 'reference=ember-evaluator/atrx-vep-crispr:*'
docker image ls --filter 'reference=ember-evaluator/*:verify-*'
docker image ls --filter 'reference=ember-evaluator/shared:*'
```

Digest-pinned `base` tags derive from official repository/digest/platform/task/purpose, avoiding random tags on repeats. Mutable tags are pinned per preparation/attempt. Runtime/Agent/Dockerfile tags derive from content/task/purpose for cross-run reuse. Multiple tags may share IMAGE ID without duplicating images; different IDs may share layers. Do not sum image-ls SIZE as disk use; use docker system df.

Later runs inspect Evaluator tags using image IDs, RepoDigests, or saved provenance, never names alone. Records live under `EVALUATOR_CACHE_DIR/docker-images/` or application cache docker-images, typically `/toolbox-home/.cache/ember-evaluator/docker-images/` in toolbox. Classic Docker may lose RepoDigests after official references are removed; records validate official digest/platform/ID. Another task can tag verified content without pulling.

If provenance is lost and local images cannot prove official digests, fetch official content to validate. Replaced tags/platform mismatch fail explicitly. Failed official-reference removal retains generated tags/records and reports failure without forcing removal/claiming completion. Historical Evaluator tags remain; old official references migrate only when processed locally.

Upgrading from old kind/hash-only names searches new names, so **first preparation may rebuild**, with Docker layers reused where possible. Old images are neither retagged nor deleted automatically; running containers remain unaffected. Saved receipts still validate identities. Renaming alone saves no disk.

## Will Restarting Redownload or Rebuild Every Image?

Normally no. Completed images/tags on the same daemon are reused when identities, runtime code, installation files, and arguments match. Interruption does not delete completed images; incomplete builds are not reusable final images.

| Kind | Repeat behavior |
| --- | --- |
| Official digest-pinned solve/verify/sidecar | Validate stable tags/provenance, recreate missing tags from verified IDs, pull only without valid content, then remove official local references |
| Mutable task tags/pinned Node | Inspect local references/platform first; pull only if unreadable, downloading missing layers |
| Task Dockerfiles | Content/args/platform-derived tags reuse existing images |
| `ember-evaluator/<task>:solve-runtime-`… / `verify-runtime-…` | Reuse tags derived from task/Node IDs, runtime, platform, purpose |
| `ember-evaluator/shared:solver-install-…` | Reuse installation files/commands/probes/program/recipe/Node/platform identities |
| `ember-evaluator/<task>:solve-agent-`… | Reuse runtime/shared install/derived build/purpose identities |
| `ember-evaluator/<task>:solve-base-`… / `verify-base-…` | Digest content reuses stable tags; mutable references may add per-preparation tags |

Runs still check selected environments, so Preparing solve image and runtime environment/Task image ready logs repeat without proving downloads/builds. `source=explicit image reference` means configuration supplied an address, not whether it was cached/pulled. Runtime/Solver work may follow. See [preparation](../concurrency.md).

Shared install images set recursive agent read/execute permissions once and state1777. Final task copies retain permissions and check loading as the task's original user, avoiding per-task recursive chmod. Recipe changes generate new tags requiring first-use builds.

Solve/verify may use different official images and both need runtimes. Seeing solve ready does not prove verification/full-task readiness; later runs may download previously unprepared verify images.

Re-pulls/builds may occur when:

- Interruption preceded build completion.
- Images/tags were deleted or Docker context/daemon changed; local/Ray caches are not shared automatically.
- Task/Node images, platforms, runtime programs, Solver files/dependencies, or build args changed.
- Backend/API inspection changes altered image identities used in keys.
- Naming upgrades/task IDs/purpose changes select different tags.

Docker may still reuse build layers; its cache determines which steps rerun.

**Image reuse and task resume are separate.** Ordinary `run` creates a new evaluation, reuses images, and creates fresh containers/workspaces without skipping previous completed tasks:

```bash
node dist/cli.js run playbook/terminalbench/terminalbench-4.0.yaml
```

To continue the previous evaluation, use identical configuration with `--resume`:

```bash
node dist/cli.js run playbook/terminalbench/terminalbench-4.0.yaml --resume
```

Resume still checks/prepares environments, skips valid results, and reruns unfinished/invalid tasks under matching config/source/code/plugin versions. See [resume](../usage.md#resume-and-rebuild-reports). New runs without resume also reuse images.

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

Each task Dockerfile stage receives a constraint file/PIP_CONSTRAINT before pip installs. Only build snapshots change, not datasets; constraints enter cache digests. Images retain files/variables for later pip installs.

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
