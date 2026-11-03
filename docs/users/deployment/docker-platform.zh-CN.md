# Docker 目标平台

> [English](./docker-platform.md) | 中文

```yaml
environment:
  name: docker
  config:
    platform: auto
```

省略 `platform` 等同于 `auto`。平台选择遵循以下规则：

- Benchmark 已声明平台时，使用其声明的平台，用户在 YAML 中指定的平台不生效。Benchmark 插件通过任务 `EnvironmentSpec.platform` 传递该声明。
- Benchmark 未声明平台时，用户可根据其实际平台要求，在 YAML 的 `environment.config.platform` 中指定 `linux/amd64` 或 `linux/arm64`。这主要适用于 `task.toml` 等任务配置没有声明架构、但任务镜像或依赖实际有平台要求的情况。
- Benchmark 未声明平台，且 YAML 未设置 `platform` 或设置为 `auto` 时，使用实际 Docker daemon 的原生平台。

仅支持 `linux/amd64`、`linux/arm64`，不按 Benchmark 名称猜测架构，也不通过修改 Dockerfile 将一种架构转换为另一种。

WorkBuddy 的可复制 Playbook 用以下配置补充其 amd64 镜像要求，不需要其他平台选项：

```yaml
environment:
  name: docker
  config:
    platform: linux/amd64
```

DeepSWE 1.1 的任务 TOML 只声明 Linux 和预制镜像地址，没有架构声明。使用当前仅有 amd64 的官方镜像时，应在 YAML 中以 `linux/amd64` 补充这个镜像要求；保持 `auto` 则选择节点原生平台。不能把该要求随意改成 `linux/arm64` 来转换预制镜像，镜像和其中依赖必须实际提供 ARM64 版本。DeepSWE 求解阶段使用 TOML 指定的预制镜像（或显式镜像映射）；独立验证阶段按任务的 verifier.environment 构建 tests/Dockerfile。

当目标平台与 Docker 节点原生架构不同时，Evaluator 提示“正在检测并使用 QEMU 模拟，可能产生性能损耗”，警告本身不终止运行；随后在该节点用固定 Node 镜像运行短探针，验证已注册的 QEMU/binfmt 能否实际执行目标程序；成功后 Docker 自动使用模拟器。Local 在检测前输出警告；Ray 将节点的脱敏警告随准备或执行响应带回协调端显示，不转发原始 stderr。每个环境实例对同一目标共享探针及警告，避免并发任务反复探测。探针禁止网络、只读文件系统，有独立时限和清理。Evaluator 不安装模拟器，不创建 privileged 容器，也不修改宿主机内核注册。Docker Desktop 通常已有模拟支持；Linux 服务器缺失时需管理员配置，参考[管理容器指南](container-toolbox.zh-CN.md#arm64-宿主机上的-x86-模拟与恢复)。

不匹配的镜像、缺失/失效模拟器等架构问题返回 `ENV_ARCH_UNSUPPORTED`，属于基础设施错误：环境准备不重试，任务没有有效评分，不作为 Agent 得 0 分。下载、daemon 和清理失败分别保留对应错误码。使用 `run.onError: continue` 时，其他并行任务继续；已有合法评分正常保留。清理未确认或节点级故障仍按原规则停止派发。

目标、来源、节点原生平台和 `native`/`qemu` 执行方式记录在准备回执及结果的环境元数据 `platformResolution` 中。缓存按目标平台隔离，禁止跨平台复用准备回执。模拟器可启动探针不保证任意应用二进制兼容；任务依赖仍可能在后续构建或执行中失败。

Local 和 Ray 使用同一解析及检测逻辑。Ray 的 `auto` 在实际 worker 的 Docker daemon 上解析，而不是采用协调端机器的架构；已准备任务仍绑定准备节点。混合架构集群按容量调度，不会自动优先选择原生架构节点；需要避免模拟时，应使用与任务镜像匹配的执行节点。

外部 Benchmark 可通过公开契约在 `solveEnv`、`verifyEnv` 中分别声明 `platform`，无需增加专属配置或核心分支。环境提前安装 solver 时会接收相应任务环境，避免自动平台与任务声明不同导致安装到错误架构。

[返回用户手册](../README.zh-CN.md) · [快速上手](../quick-start.zh-CN.md)
