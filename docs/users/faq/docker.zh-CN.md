# Docker 与跨架构运行 FAQ

> [English](./docker.md) | 中文

[FAQ 目录](README.zh-CN.md) · [Docker 平台规则](../deployment/docker-platform.zh-CN.md)

本页 Shell 命令在 Evaluator 仓库根目录执行，YAML 片段合入实际实验配置。

## 如何配置镜像下载源和代理？

使用独立的网络 YAML，通过 `--network network.yaml` 传入。`docker.pull.method` 选择 Docker 原生拉取或 Registry API 下载，`docker.mirrors` 临时替换 registry 地址，`docker.benchmarks` 可为指定题库选择 ModelScope/Hugging Face 镜像归档。

Registry API 支持内置 Node.js 下载器和用户预装的 skopeo。代理配置在 `proxy` 中；执行进程、daemon、构建步骤和安装容器分别使用 `host`、`daemon`、`build`、`runtime` 覆盖值。凭据和节点地址见[代理配置](../reference/network.zh-CN.md)，归档固定路径见[镜像下载](../image-downloads.zh-CN.md)。

`FROM` 和外部 `COPY --from` 由 Docker 自带构建器下载，使用 daemon 已生效的网络设置。`doctor experiment.yaml` 检查镜像获取、`FROM` 和 `RUN`，并生成配置建议，不修改配置或重启 Docker；管理员应用建议后再次运行诊断。

任务镜像缺少系统 CA 时，Evaluator 会在构建派生 Runtime 镜像时，将固定 Node 版本自带的公共根证书写入 `/etc/ssl/certs/ca-certificates.crt`。已有 CA 证书和显式配置的证书路径会保留。Codex 等使用系统 CA 的客户端可以直接进行 HTTPS 证书校验。

## 如何按任务区分和查看镜像？

本地镜像名称采用 `ember-evaluator/<任务短名>:<用途>-<种类>-<hash>`。`solve` 表示解题，`verify` 表示验证；名称后缀用于区分不同任务和内容。可按任务短名或用途查找镜像：

以 `terminal-bench/atrx-vep-crispr` 为例：

| 镜像种类 | 名称示例 |
| --- | --- |
| 官方解题镜像的本地固定引用 | `ember-evaluator/atrx-vep-crispr:solve-base-<hash>` |
| 解题 Runtime | `ember-evaluator/atrx-vep-crispr:solve-runtime-<hash>` |
| 安装 Agent 后的最终解题镜像 | `ember-evaluator/atrx-vep-crispr:solve-agent-<hash>` |
| 官方验证镜像的本地固定引用 | `ember-evaluator/atrx-vep-crispr:verify-base-<hash>` |
| 验证 Runtime | `ember-evaluator/atrx-vep-crispr:verify-runtime-<hash>` |
| 从任务 Dockerfile 构建的镜像（按需生成） | `ember-evaluator/atrx-vep-crispr:solve-task-<hash>` 或 `verify-task-<hash>` |
| Agent 构建所用的 Runtime 固定引用（按需生成） | `ember-evaluator/atrx-vep-crispr:solve-agent-base-<hash>` |
| 任务 Sidecar（按需生成） | `ember-evaluator/atrx-vep-crispr:verify-service-redis-base-<hash>`；从 Dockerfile 构建时还会有 `verify-service-redis-task-<hash>` |
| 所有任务共享的 Agent 安装镜像 | `ember-evaluator/shared:solver-install-<hash>` |
| 内部网关的固定引用（按需生成） | `ember-evaluator/shared:gateway-base-<hash>` |

固定摘要的官方任务镜像在本地会使用 Evaluator 名称，原官方标签可能被移除，但镜像内容和结果中的官方来源不变。只有需要安装 Agent 时才生成 Agent 镜像，因此表中的种类不一定每题都有。

查看某一道题、所有任务的验证镜像或共享镜像：

```bash
docker image ls --filter 'reference=ember-evaluator/atrx-vep-crispr:*'
docker image ls --filter 'reference=ember-evaluator/*:verify-*'
docker image ls --filter 'reference=ember-evaluator/shared:*'
```

相同任务、用途和内容可以复用已有镜像。多个标签可能指向同一个 IMAGE ID，不会因此复制整份镜像；不同镜像也可能共享镜像层。查看磁盘占用请执行 `docker system df`，不要直接累加 `docker image ls` 的 SIZE。

除 Docker 中的镜像外，Evaluator 还会保存复用所需的本地记录，位于 `EVALUATOR_CACHE_DIR/docker-images/`；未设置该变量时使用应用缓存目录，管理容器中通常为 `/toolbox-home/.cache/ember-evaluator/docker-images/`。只复制镜像、没有对应记录时，仍可能重新下载。

本地镜像标签被替换或平台不符时，准备会报错。先确认 Docker context、目标平台和缓存目录是否正确；需要清理后重新准备时，按[删除评测镜像](../usage.zh-CN.md#删除评测镜像)操作，再执行 `warmup`。

升级后若镜像名称发生变化，首次准备可能重新构建，但 Docker 仍可复用已有构建层。旧镜像和正在使用它们的容器不会自动删除；改名本身不会释放磁盘空间。

## 中断后重跑会重新下载或构建全部镜像吗？

正常情况下不会。只要上次完成的镜像及其标签仍在同一个 Docker daemon 中，且参与缓存计算的镜像标识、运行时代码、安装文件和参数没有变化，新运行就会复用已有镜像。中断不会主动删除已完成的镜像；尚未完成的构建不能视为可复用的成品。

| 镜像种类 | 再次运行时的处理 |
| --- | --- |
| 官方任务镜像、服务镜像和 Node 镜像 | 本地内容仍可用时复用；缺少所需镜像时下载 |
| 从 Dockerfile 构建的任务镜像 | 构建文件、参数和平台未变时复用 |
| Runtime 镜像 | 任务镜像、Node 镜像、运行时代码和平台未变时复用 |
| Agent 安装镜像和最终解题镜像 | 相关基础镜像、Agent 文件、安装命令和参数未变时复用 |

重新运行仍会检查所选任务的环境，因此会再次输出 `Preparing solve image and runtime environment`、`Task image ready` 等日志。这些日志不代表重新下载或构建；`source=explicit image reference` 只说明配置提供了镜像地址，也不区分本地命中和实际拉取。镜像就绪后还可能继续准备 Runtime 和 Solver，详见[并发与环境准备](../concurrency.zh-CN.md)。

解题和验证可以使用不同的官方镜像，也各自需要准备 Runtime。上次只看到“用途=解题”的镜像就绪，不代表验证镜像已经拉取、整题环境已经准备完成；后续重新运行可能首次下载此前尚未准备的验证镜像。

以下情况可能重新拉取或构建相关镜像：

- 上次中断时，该镜像还没有构建完成。
- 镜像或对应标签被删除，或改用了另一个 Docker context / daemon；例如本地与 Ray 节点不会自动共享镜像缓存。
- 任务镜像、Node 镜像、目标平台、Runtime 程序、Solver 安装文件、依赖或构建参数等发生变化。
- 切换 Docker 后端，导致之前的镜像或构建缓存不可用。
- 从旧命名版本升级，或任务 ID、解题／验证用途改变，导致程序查找不同标签。

即使需要重新构建，Docker 仍可能复用已有构建层；是否完整执行每一步，由 Docker 的构建缓存决定。

**镜像复用与任务续跑是两回事。** 普通 `run` 会新建一次评测，复用可用镜像，再为任务创建新的容器和工作区，不会自动跳过上次已完成的题目：

```bash
ember-evaluator run playbook/terminalbench/terminalbench-4.0.yaml
```

需要继续上次评测时，使用同一份配置增加 `--resume`：

```bash
ember-evaluator run playbook/terminalbench/terminalbench-4.0.yaml --resume
```

续跑同样需要检查和准备环境。已有有效结果会跳过，未完成或无效任务按恢复规则重新执行；Evaluator 代码允许更新并重新构建，配置、来源、外部插件及待评测 Bundle、Harness 版本仍需匹配，详见[续跑与重建报告](../usage.zh-CN.md#续跑与重建报告)。不使用 `--resume` 的新运行也能复用镜像。

## amd64 镜像能在 ARM64 节点运行吗？

可以使用节点已安装的 QEMU/binfmt，但模拟器探针成功只证明基本执行能力，不保证所有应用兼容或性能相同。任务已声明平台时遵循该声明；未声明时可在 YAML 中选择 `linux/amd64`。缺少模拟器或格式不兼容时记为基础设施错误，见[平台检测与安装入口](../deployment/docker-platform.zh-CN.md)。

## Go 或 esbuild 在 amd64 模拟环境崩溃怎么办？

若验证日志出现 `runtime: lfstack.push invalid packing`、`fatal error: lfstack.push`，属于 Go 运行时与 x86 用户态模拟的兼容问题，esbuild 等 Go 编译的工具也可能受影响。增加 verifier 超时不会修复该崩溃。

可以为受影响的实验单独尝试以下兼容配置，并先选一题检查：

```yaml
environment:
  name: docker
  config:
    platform: linux/amd64
    containerEnv:
      GOGC: "off"
      GOMAXPROCS: "2"
```

`containerEnv` 只进入本实验的任务容器，求解与验证阶段一致，不进入其他容器或宿主机。默认不设置；不要在这里保存模型密钥。`GOGC=off` 关闭 Go 自动 GC，会增加内存使用，应保留任务的容器内存限制。`GOMAXPROCS` 对应 Go 并行度，不代表同时运行的评测任务数。

兼容配置不改变官方测试、补丁或评分规则，也不保证模拟环境与原生 amd64 的性能一致。先选择受影响的一题或复用已有 patch 单独验证，不必重跑完整题集。使用新输出目录保存验证证据，保留原始运行结果。

## 如何限制旧题目镜像中的 Python 依赖？

`environment.config.buildPipConstraints` 按完整 task ID 配置 pip 版本约束。例如：

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

这些约束用于构建任务镜像时的 pip 安装，也会在生成的容器中继续生效。修改约束后会重新构建相关镜像，原始数据集文件不变。

仅支持包名与版本比较，不接受 URL、命令选项、extras、条件标记或多行内容。`*` 键可以为未单独配置的主任务镜像提供默认列表；具体 task ID 的列表优先，空数组表示该题不加限制。sidecar 不应用这些约束。未配置时保持原行为；预构建镜像不重新安装依赖。不能把整个旧题库都限制为低版本：有些题目会明确依赖新版 pytest，应按已确认不兼容的题目配置。

## Go 冷构建耗尽验证预算怎么办？

`GOGC=off` 用于排查前述兼容问题，不能消除模拟器中的编译成本。验证任务包含 `go build ./...` 时，冷构建可能耗尽任务声明的预算。不要为所有任务覆盖 `GOCACHE`：部分镜像已在 `/tmp/gocache` 等目录预热，改成另一目录会绕开已有缓存。没有预编译的镜像，仅指定缓存目录也不能消除第一次编译成本。

可以单独从公开基线镜像制作编译缓存，再用 Docker 环境的 `imageOverrides` 精确映射到新镜像。预热脚本只编译公开源码，核对原 commit 与干净工作区，使用离线、2 CPU、8 GiB 容器，成功后保留派生镜像并删除临时容器。它保留原镜像声明的 `GOCACHE`，没有声明时使用 `/root/.cache/go-build`，并将该目录保存在派生镜像的环境变量中。原始镜像标签保持不变。第一次预热仍需编译时间；缓存可在后续新建容器中复用。

```bash
bash scripts/prewarm-go-image.sh \
  '公开任务镜像引用' \
  'ember-evaluator-prewarm:任务名' \
  'task.toml 中的完整 base_commit_hash'
```

第 4 个参数可指定公开模块目录，例如 `/app/backend`；后续参数可限制公开包范围，例如 `./internal/services`。省略时在 `/app` 执行 `go build ./...`。这些参数不能指向隐藏测试或解题后的工作区。

```yaml
environment:
  name: docker
  config:
    platform: linux/amd64
    imageOverrides:
      "公开任务镜像引用": "ember-evaluator-prewarm:任务名"
    containerEnv:
      GOGC: "off"
      GOMAXPROCS: "2"
```

映射缺省为空，精确匹配一次，不递归匹配；只作用于任务镜像，不替换固定的 evaluator Node 或模型网关镜像。结果记录实际使用的镜像引用与 ID，实验配置保留映射。公开 Dockerfile 的构建上下文及内容校验仍生效。

输入必须是公开原始任务镜像，不要从求解完成或执行过隐藏测试的容器提交缓存镜像。每个新任务容器保留独立可写层，验证器缓存不传回求解器。不要通过改官方测试或增加验证预算来提高评分。预热后先用相同保存 patch 单独验证，检查日志、镜像身份与评分是否一致。

## 容器看到很多 CPU，是否说明任务获得了这些 CPU？

Harbor 任务从 `task.toml` 读取 CPU 预算，传给求解和验证环境。Docker 环境会同时约束 CPU 时间配额与亲和性；例如预算为 2 时，普通 `nproc`、Node `os.availableParallelism()` 都返回 2。对旧版 Vitest/Jest 常用的 `os.cpus().length`，任务容器中的 Node preload 也按可用数量裁剪，并覆盖 CJS、ESM 和继承环境的子 Node 进程。

此行为按每题预算自动应用，不需要在实验 YAML 中手动写 2，也不需要重建任务镜像。CPU 集由当前容器允许的 CPU 编号选取并分散到不同任务；它不是独占预留，评测任务的并发数仍由 scheduler 配置。小数 CPU 配额保持原值，可见核心数向上取整；无 CPU 预算的环境维持原行为。

原有镜像和配置的 `NODE_OPTIONS` 会保留。`result.json` 的 `environments.solve/verify.resources.effective` 额外记录 `cpusetCpus` 和 `availableCpus`；若约束或可见数量核验失败，环境准备明确报 `ENV_CPU_BUDGET_FAILED`，不会静默回退到宿主 CPU 数量。资源配置只作用于新创建的任务容器。

这里约束的是可用并行度，不是整个宿主硬件信息的虚拟化。Python 3.12 的 `os.cpu_count()`、`nproc --all` 等仍可能读取宿主数量；Python 任务应使用 `len(os.sched_getaffinity(0))`，测试脚本也应按 `task.toml` 的预算显式选择并行度。不得据原始硬件数量推断容器可用预算。该做法对应 Terminal-Bench 的 [check-nproc 检查](https://github.com/harbor-framework/terminal-bench/blob/main/docs/TASK_REVIEW_AUTOMATION.md#check-nproc)。

限制测试工具的意外过度并行可以消除一类 OOM 诱因，但不保证所有任务都能在 8 GiB 内完成；真实补丁、类型检查或测试本身仍可能需要更多内存，应分别分析。

## 清理超时或证据收集失败是否表示模型答错？

不能据此判断。检查 attempt 的 `result.json`：`scoreStatus` 表示评分是否有效，`cleanupStatus` 表示资源是否确认释放；`files.json` 列出缺失或读取失败的证据。

- `CLEANUP_TIMEOUT` / `CLEANUP_FAILED`：确认日志中的容器 ID、具体操作和 Docker daemon 状态。资源未确认释放时停止派发，先恢复清理再续跑；增加整题超时不会延长清理预算。
- `ARTIFACT_COLLECTION_INCOMPLETE`：轨迹、session 或业务产物可能缺失；若已获得合法 verifier 结果，评分仍保留，并标记证据不完整。
- `Workspace transfer cleanup failed`：传输收尾失败，可能还没有进入验证；不能把它当成普通零分。

保留原结果和错误，不在其他评测运行时执行全局 Docker 清理，也不以递归 `chmod 777` 处理权限。完整策略见[错误码](../reference/errors.zh-CN.md)。

## 容器文件权限导致 EACCES 时检查什么？

先从 `files.json` 找到具体读取失败的文件，再检查任务镜像的 `USER`、文件属主和权限、宿主结果目录挂载。session 或轨迹不可读不代表评分文件一定缺失，应分别查看。

框架按阶段交接日志目录权限，保留任务文件和归档的原权限；Python verifier 以结果目录属主写证据。不要用递归放宽全部任务文件权限来掩盖问题。已有 attempt 的文件清单不会因升级而自动改写，应保留原诊断；重新运行时使用新 attempt。

## 构建网络或旧 Docker API 不兼容怎么办？

仅对本机 Linux Docker daemon，可以通过 `environment.config.dockerExecutable` 选择 `scripts/toolbox/docker-host.sh`。它提供 host 构建网络和旧 API 的镜像平台检查，配置方法与网络边界见[管理容器指南](../deployment/container-toolbox.zh-CN.md#构建网络与旧-docker-api-的兼容配置)。不要将该脚本直接套用于远程 daemon。
