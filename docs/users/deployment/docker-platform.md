# Docker Target Platforms

> English | [中文](./docker-platform.zh-CN.md)

```yaml
environment:
  name: docker
  config:
    platform: auto
```

Omitted `platform` means `auto`. Selection follows these rules:

- A benchmark-declared platform takes precedence over YAML. Benchmark plugins pass it through task `EnvironmentSpec.platform`.
- Without a benchmark declaration, set YAML `environment.config.platform` to `linux/amd64` or `linux/arm64` according to actual requirements. This applies when task configuration such as `task.toml` omits architecture but images/dependencies require one.
- With no benchmark `platform` and omitted or `auto` YAML `platform`, use the actual Docker daemon's native platform.

Only `linux/amd64` and `linux/arm64` are supported. Architecture is not guessed from benchmark names, and editing Dockerfiles does not convert architectures.

Copyable WorkBuddy Playbooks supply their amd64 image requirement with this configuration; no additional platform options are needed:

```yaml
environment:
  name: docker
  config:
    platform: linux/amd64
```

DeepSWE 1.1 TOML declares Linux and a prebuilt image but no architecture. Set YAML `linux/amd64` for the current amd64-only official images; `auto` selects the node's native platform. Changing this to `linux/arm64` does not convert images: ARM64 images and dependencies must actually exist. Solving uses the TOML image or an explicit image mapping; independent verification builds tests/Dockerfile from verifier.environment.

When target and node architectures differ, Evaluator warns that QEMU emulation is being checked/used and may reduce performance; the warning alone does not stop execution. A short probe using a pinned Node image verifies registered QEMU/binfmt can execute the target, then Docker uses emulation automatically. Local prints warnings before probing; Ray returns redacted warnings in preparation/execution responses without forwarding raw stderr. Each environment instance shares probes/warnings for a target across concurrent tasks. Probes disable networking, use read-only filesystems, and have separate timeouts/cleanup. Evaluator does not install emulators, create privileged containers, or alter host kernel registration. Docker Desktop usually includes support; Linux administrators must configure missing support. See [management container recovery](container-toolbox.md#x86-emulation-and-recovery-on-arm64-hosts).

Image mismatches and missing/broken emulators produce infrastructure error `ENV_ARCH_UNSUPPORTED`. Preparation is not retried and no valid score is assigned, rather than an agent zero. Download, daemon, and cleanup failures retain their own codes. With `run.onError: continue`, other tasks continue and valid scores remain. Unconfirmed cleanup or node failures still stop dispatch under existing rules.

Preparation receipts and result environment metadata `platformResolution` record target, source, node-native platform, and `native`/`qemu` execution. Caches are separated by target platform; preparation receipts cannot cross platforms. A passing probe does not guarantee every application binary works; subsequent builds/execution may still fail.

Local and Ray share resolution/probing logic. Ray resolves `auto` on the worker Docker daemon rather than the coordinator. Prepared tasks remain bound to that node. Mixed-architecture clusters schedule by capacity, without preferring native matches. Use nodes matching task images to avoid emulation.

External benchmarks can declare separate `platform` values in `solveEnv` and `verifyEnv` through public contracts, without dedicated options or core branches. Environments installing solvers early receive the task environment to prevent installation for an incorrect automatic architecture.

[User guide](../README.md) · [Quick start](../quick-start.md)
