# Docker 与跨架构运行 FAQ

> [English](./docker.md) | 中文

[FAQ 目录](README.zh-CN.md) · [Docker 平台规则](../deployment/docker-platform.zh-CN.md)

本页 Shell 命令在 Evaluator 仓库根目录执行，YAML 片段合入实际实验配置。

## 如何只为拉取镜像指定代理？

在 Docker 环境参数中填写 HTTP/HTTPS 代理：

```yaml
environment:
  name: docker
  config:
    pullProxy: ${DOCKER_PULL_PROXY}
```

例如本机 Clash 的 HTTP 入口可以通过环境变量设置为 `http://127.0.0.1:7890`。该地址由运行 Evaluator 的进程访问；Evaluator 在容器或 Ray 节点运行时，`127.0.0.1` 指的是该容器或节点，需填写它可访问的代理地址。支持 HTTP/HTTPS 代理及 URL 中的代理认证，不支持 SOCKS。

缺少所需镜像时，Evaluator 使用该代理访问 registry 的认证、manifest 和镜像层，验证摘要及目标平台，生成归档并通过 `docker load` 导入当前 Docker daemon。Registry 登录凭据读取当前执行用户的 Docker `config.json`、`credHelpers` 或 `credsStore`；公开镜像可匿名下载。镜像归档临时占用压缩层、展开层及打包文件的磁盘空间，下载或导入失败、取消后会清理临时文件。已验证的本地镜像及来源凭据可跨运行复用。

这个参数只用于框架主动获取的任务、验证、侧车和运行时镜像，不修改系统或 Docker daemon 代理，不传给 Dockerfile 构建参数、任务容器、数据集下载或模型请求。Dockerfile 中自行获取的 `FROM` 镜像仍由 Docker/BuildKit 处理；已有系统环境变量和 Docker 全局设置保持其原有作用。代理认证信息会脱敏；认证代理应使用上面的环境变量引用，以便保存配置后仍能恢复凭据。

省略 `pullProxy` 时沿用原生 `docker pull`；显式配置后失败会报告错误，不静默改成直连或其他代理。HTTPS registry 使用正常 TLS 证书校验；本机 loopback registry 可使用 HTTP，不会自动继承 daemon 中任意远端不安全 registry 或跳过证书校验设置。

## 如何按任务区分和查看镜像？

框架生成的本地镜像使用 `ember-evaluator/<任务短名>:<用途>-<种类>-<hash>`。`solve` 表示解题，`verify` 表示验证；任务短名取任务 ID 的最后一段并转成 Docker 允许的小写字符，哈希包含完整任务 ID，避免不同题库的同名任务混用标签。

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

带 `@sha256:` 的外部任务镜像在本地改用 Evaluator 名称。程序先核对摘要、平台和镜像 ID，保存本地校验记录，再移除对应的官方摘要引用及仍指向同一镜像的声明标签；不删除镜像内容，不使用强制删除。任务声明及结果中的官方来源保持原样。只有 Solver 需要安装 Agent 时才生成 Agent 镜像；上述镜像不一定每题都有。直接调用 `materialize` 且未提供任务上下文时，生成名称放在 `ember-evaluator/shared` 下，默认用途为 `solve`，不执行官方引用迁移。可变标签、Evaluator 已生成的镜像及固定 Node 镜像保持原处理方式。

查看某一道题、所有任务的验证镜像或共享镜像：

```bash
docker image ls --filter 'reference=ember-evaluator/atrx-vep-crispr:*'
docker image ls --filter 'reference=ember-evaluator/*:verify-*'
docker image ls --filter 'reference=ember-evaluator/shared:*'
```

固定摘要任务镜像的 `base` 标签按官方仓库、摘要、平台、任务和用途生成，同一内容重复准备不再新增随机标签；可变标签仍按本次准备或 attempt 固定引用。Runtime、Agent 和 Dockerfile 构建镜像也按内容及任务、用途生成，相同内容的同任务同用途可跨运行复用。多个标签可以指向同一个 IMAGE ID，不会因此复制整份镜像；不同 IMAGE ID 之间也可能共享层，不能把 `docker image ls` 的每行 SIZE 直接相加作为磁盘占用。查看 Docker 统计可执行 `docker system df`。

后续运行先检查 Evaluator 标签。校验可以使用镜像 ID、RepoDigests 或先前保存的来源记录；不会仅凭标签名称信任镜像内容。记录保存在 `EVALUATOR_CACHE_DIR/docker-images/`，未设置该变量时默认在应用缓存目录的 `docker-images/` 下，管理容器通常是 `/toolbox-home/.cache/ember-evaluator/docker-images/`。经典 Docker 存储移除官方引用后可能没有 RepoDigests，此时依靠记录中的官方摘要、平台和镜像 ID 核对。另一题使用相同来源时可从已校验的镜像创建自己的名称，无需重新拉取。

来源记录丢失且现有镜像不能证明匹配官方摘要时，需要重新取得官方来源以验证。Evaluator 标签被替换或平台不符时明确报错；官方引用无法移除时保留已生成的 Evaluator 标签和记录并报告失败，不强制删除、不报告完成。已有历史 Evaluator 标签不自动删除；本机首次处理旧官方引用时会迁移它们，其他未参与准备的镜像不变。

从旧版只有种类前缀和哈希的名称升级后，程序会查找新名称，**首次准备可能重新触发构建**；Docker 仍可复用旧构建层。程序不自动为旧镜像补新标签，也不删除旧标签，正在使用旧镜像的容器不受改名影响。已有准备凭据继续按保存的镜像身份校验。命名变化本身不会减少磁盘占用。

## 中断后重跑会重新下载或构建全部镜像吗？

正常情况下不会。只要上次完成的镜像及其标签仍在同一个 Docker daemon 中，且参与缓存计算的镜像标识、运行时代码、安装文件和参数没有变化，新运行就会复用已有镜像。中断不会主动删除已完成的镜像；尚未完成的构建不能视为可复用的成品。

| 镜像种类 | 再次运行时的处理 |
| --- | --- |
| 固定摘要的官方解题、验证及 Sidecar 镜像 | 先校验稳定的 Evaluator 标签和本地来源记录；标签缺失时可从已验证 ID 创建，无法取得有效本地内容时才拉取。完成后移除对应官方本地引用 |
| 可变标签任务镜像及固定 Node 镜像 | 先检查原本地引用与目标平台，无法读取时才尝试拉取；缺失的镜像层仍需下载 |
| 从 Dockerfile 构建的任务镜像 | 按公开构建文件、构建参数和平台等计算标签，已有对应镜像时复用 |
| `ember-evaluator/<任务>:solve-runtime-…` / `verify-runtime-…` | 按任务镜像标识、Node 镜像标识、Runtime 程序、平台及任务用途等计算标签，已有对应镜像时复用 |
| `ember-evaluator/shared:solver-install-…` | 按安装文件、安装命令、探针、安装程序、共享构建配方、Node 镜像标识和平台等计算标签，已有对应镜像时复用 |
| `ember-evaluator/<任务>:solve-agent-…` | 按 Runtime 镜像标识、共享安装镜像标识、派生构建内容及任务用途等计算标签，已有对应镜像时复用 |
| `ember-evaluator/<任务>:solve-base-…` / `verify-base-…` | 固定摘要任务按内容复用同一标签；可变标签按本次准备固定引用，可能新增标签 |

重新运行仍会检查所选任务的环境，因此会再次输出 `Preparing solve image and runtime environment`、`Task image ready` 等日志。这些日志不代表重新下载或构建；`source=explicit image reference` 只说明配置提供了镜像地址，也不区分本地命中和实际拉取。镜像就绪后还可能继续准备 Runtime 和 Solver，详见[并发与环境准备](../concurrency.zh-CN.md)。

Agent 目录的递归读取和执行权限在共享安装镜像中设置一次，`state` 目录同时设置为 `1777`。每题最终镜像复制时保留这些权限，随后以任务镜像原来的用户检查 Agent 是否可加载，不再为每题递归执行 `chmod`。共享构建配方改变后会生成新的镜像标签，首次使用需要重新构建相关镜像。

解题和验证可以使用不同的官方镜像，也各自需要准备 Runtime。上次只看到“用途=解题”的镜像就绪，不代表验证镜像已经拉取、整题环境已经准备完成；后续重新运行可能首次下载此前尚未准备的验证镜像。

以下情况可能重新拉取或构建相关镜像：

- 上次中断时，该镜像还没有构建完成。
- 镜像或对应标签被删除，或改用了另一个 Docker context / daemon；例如本地与 Ray 节点不会自动共享镜像缓存。
- 任务镜像、Node 镜像、目标平台、Runtime 程序、Solver 安装文件、依赖或构建参数等发生变化。
- Docker 后端或 API 检查方式变化，使参与缓存计算的镜像标识不同。
- 从旧命名版本升级，或任务 ID、解题／验证用途改变，导致程序查找不同标签。

即使需要重新构建，Docker 仍可能复用已有构建层；是否完整执行每一步，由 Docker 的构建缓存决定。

**镜像复用与任务续跑是两回事。** 普通 `run` 会新建一次评测，复用可用镜像，再为任务创建新的容器和工作区，不会自动跳过上次已完成的题目：

```bash
node dist/cli.js run playbook/terminalbench/terminalbench-4.0.yaml
```

需要继续上次评测时，使用同一份配置增加 `--resume`：

```bash
node dist/cli.js run playbook/terminalbench/terminalbench-4.0.yaml --resume
```

续跑同样需要检查和准备环境。已有有效结果会跳过，未完成或无效任务按恢复规则重新执行；配置、来源、代码和插件版本需要匹配，详见[续跑与重建报告](../usage.zh-CN.md#续跑与重建报告)。不使用 `--resume` 的新运行也能复用镜像。

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

Evaluator 在任务 Dockerfile 的每个构建阶段复制约束文件并设置 `PIP_CONSTRAINT`，原有 `pip install` 因而遵守版本限制。只修改构建快照，数据集文件不变；约束加入镜像缓存摘要。生成的镜像保留约束文件和环境变量，后续容器内的 pip 安装也会遵守它。

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
