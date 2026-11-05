# 网络下载配置

> [English](network.md) | 中文

网络文件独立于实验 YAML。文件选择顺序为：CLI 的 `--network`（SDK 的 `networkConfigPath`）→ `EVALUATOR_NETWORK_CONFIG` → 用户目录下的 `~/.ember-evaluator/network.yaml`。Windows 对应 `%USERPROFILE%\.ember-evaluator\network.yaml`。默认文件不存在时自动创建，文件内容使用官方源和直连；已有文件不会被覆盖。

字段优先级为：**已设置且非空的受支持环境变量 → YAML → 程序默认值**，显式指定 `--network` 时也适用。网络文件可以完全留空、只写注释或写 `{}`；没有对应环境变量时才使用默认源和直连。网络配置不接受 `version` 字段；已有文件中的该字段需要删除，否则报 `Unknown network field: version`。YAML 仍支持 `${VARIABLE}` 引用，环境变量覆盖的字段不再展开原来的引用。空字符串环境变量视为未设置，不会清空 YAML。无效的环境变量值直接报错，不回退 YAML。显式指定的文件不存在或格式错误时也直接报错，不回退其他文件。

以下命令使用已注册的 `ember-evaluator`，注册步骤见[安装指南](installation.zh-CN.md#安装全局命令)。示例路径相对当前工作目录；使用仓库中的 Playbook 时，请在仓库根目录执行。

```bash
# 查看实验和默认网络文件的实际设置，不下载
ember-evaluator inspect experiment.yaml
# 使用实验指定的执行位置检查网络
ember-evaluator doctor experiment.yaml
# 临时选择另一份网络配置
ember-evaluator doctor experiment.yaml --network playbook/network/mirrors.yaml
ember-evaluator warmup experiment.yaml --network network.yaml
ember-evaluator run experiment.yaml --network network.yaml
```

示例：[官方源](../../playbook/network/official.yaml)、[国内源与 DockerProxy](../../playbook/network/mirrors.yaml)、[题库镜像归档](../../playbook/network/archives.yaml)。国内源示例使用 `docker pull`，在镜像地址前添加 `dockerproxy.net/`；不会修改 Docker daemon 的 `registry-mirrors`。

停止的 run 使用 `ember-evaluator retry --run <run-id-or-directory>` 手动补跑时，也会重新读取当前默认网络文件；可用 `--network` 覆盖。正在运行的协调进程继续使用启动时加载的配置。

## 代理和下载地址

`proxy.http`、`proxy.https` 分别控制 HTTP 和 HTTPS；`null` 表示直连，`noProxy` 为直连域名列表。`proxy.overrides.host/daemon/build/runtime` 分别覆盖 Evaluator 进程、Docker daemon、Dockerfile 的 `RUN`、运行时安装命令。没有对应环境变量时，覆盖对象中未填写的字段继承公共代理，整个位置设为 `null` 表示该位置直连。代理环境变量会覆盖所有位置的对应字段，包括 YAML 中显式设置的地址和 `null`；其他字段保留原值。

| 环境变量（同一行按优先级排列，取第一个非空值） | 覆盖字段 |
| --- | --- |
| `HTTP_PROXY`、`http_proxy` | 所有位置的 `proxy.http` |
| `HTTPS_PROXY`、`https_proxy` | 所有位置的 `proxy.https` |
| `NO_PROXY`、`no_proxy` | 所有位置的 `proxy.noProxy`，逗号分隔 |
| `HF_ENDPOINT` | `sources.huggingface` |
| `UV_DEFAULT_INDEX`、`UV_INDEX_URL`、`PIP_INDEX_URL` | `sources.python.index` |
| `PIP_EXTRA_INDEX_URL` | `sources.python.extraIndexes`，空白分隔，替换 YAML 列表 |
| `UV_PYTHON_INSTALL_MIRROR` | `sources.python.interpreter` |
| `NPM_CONFIG_REGISTRY`、`npm_config_registry` | `sources.npm.registry` |
| `EVALUATOR_NODE_MIRROR` | `sources.node.dist` |
| `EVALUATOR_GITHUB_MIRROR` | `sources.github.repository`，不修改 API/raw 地址 |
| `EVALUATOR_DEBIAN_MIRROR` | `sources.apt`，按根地址添加 `debian`、`debian-security`、`ubuntu`、`ubuntu-ports` 路径 |
| `EVALUATOR_DOCKER_BUILD_NETWORK` | `docker.buildNetwork` |

例如，PowerShell 中设置 `$env:HTTPS_PROXY = "http://127.0.0.1:7890"` 后，即使 YAML 没写代理或写了 `https: null`，HTTPS 下载也使用该代理。要恢复 YAML 的配置，先执行 `Remove-Item Env:HTTPS_PROXY`，并检查是否仍设置了小写变量。HTTP 和 HTTPS 分别读取代理，不相互补齐；`ALL_PROXY` 不作为代理配置输入。代理仅支持 HTTP(S) 地址。

`127.0.0.1` 始终指执行位置自身，不自动改成 `host.docker.internal`。容器或 Ray 节点需要填写它实际能访问的地址。认证代理使用环境变量或 `${NODE_PROXY}` 等引用，避免将明文凭据保存在实验结果中；Ray 拒绝传输字面认证地址，节点优先使用自己的非空网络环境变量，然后展开模板引用。模板引用的变量必须在接收节点提供。

| 字段 | 用途 |
| --- | --- |
| `sources.huggingface` | 数据集、任务文件、tokenizer 的 Hub 地址 |
| `sources.python.index/extraIndexes` | pip 和 uv 包索引 |
| `sources.python.interpreter` | uv 的 Python 解释器下载镜像；`null` 使用工具默认地址 |
| `sources.npm.registry` | npm、pnpm 和 Corepack 包源 |
| `sources.node.dist` | Node.js 发行文件地址 |
| `sources.github.api/raw/repository` | GitHub API、文件和 HTTPS Git 仓库地址 |
| `sources.apt` | `debian`、`debianSecurity`、`ubuntu`、`ubuntuSecurity`、`ubuntuPorts` 各自的完整仓库根地址 |
| `git.ssh.route` | `direct` 或 HTTP CONNECT `proxy`；不将 SSH Git 地址改成 HTTPS |

未指定 `--network` 或 `EVALUATOR_NETWORK_CONFIG` 时读取用户目录中的默认文件，可直接编辑其中的对应字段；环境变量仍优先于该文件。各下载器使用本次运行启动时固定的设置，`inspect` 显示环境变量覆盖后的实际值；运行中修改进程变量不会改变已有实例。模型 endpoint、模型认证和任务网络权限仍由实验配置控制。

## 镜像获取方式

`docker.pull` 是默认方式，任务基础镜像可由 `docker.benchmarks.<实验选择的 benchmark 标识>` 覆盖。Node 等共享镜像始终使用默认方式。

| 配置 | 行为 |
| --- | --- |
| `method: docker` | 默认；执行 `docker pull --platform`，HTTP 代理由 daemon 决定 |
| `method: registry-client`，`backend: nodejs` | Evaluator 下载并验证 Manifest、Config 和 Layers，再导入 Docker |
| `method: registry-client`，`backend: skopeo` | 调用预装 skopeo；可设置 `skopeoExecutable`，不会自动安装或切换后端 |
| `method: archive` | 仅用于 benchmark 覆盖；按 `provider` 和 `baseUrl` 从固定路径下载任务镜像 |

`docker.mirrors` 按原 registry 精确匹配，例如 `docker.io: https://dockerproxy.net/` 将 `ubuntu:24.04` 的主动下载地址变成 `dockerproxy.net/library/ubuntu:24.04`，保留 tag/digest，不改 GHCR 等其他 registry。失败不轮换、不回退。

本地已验证镜像可以复用。Registry API 读取当前执行用户的 Docker 登录凭据，跨域重定向不转发 registry 认证。导入后检查镜像 ID 和平台，固定 digest 必须有完整来源证明。skopeo 必须支持 `copy --preserve-digests`（已验证 1.13.3；Ubuntu 22.04 自带的 1.4.1 不支持）。skopeo 将原始内容写入临时 OCI layout；内容校验、打包和 Docker 导入与 Node.js 下载器相同。

归档配置只需 `provider: modelscope` 或 `huggingface`，以及 benchmark 目录的下载根地址 `baseUrl`。例如 `terminal-bench/vf2-speedup-networkx` 使用 `vf2-speedup-networkx` 目录。主镜像按 `<baseUrl>/<去掉命名空间的任务路径>/<linux/amd64 或 linux/arm64>/<solve 或 verify>.tar.gz` 下载；服务镜像使用 `<阶段>/services/<服务名>.tar.gz`。每个文件由 `docker save` 导出一个镜像并 gzip 压缩，不使用 `docker export`。无需 catalog.json、SHA256SUMS 或原始 Registry Manifest。

归档下载后直接执行 `docker load` 并添加 Evaluator 标签；不解析归档、不比较文件 SHA-256、原 Registry 摘要或镜像平台，也不做导入后的身份校验。Docker 返回失败时正常报错，不回退到其他来源。原始镜像标签可能由 Docker load 恢复或覆盖。运行时读取镜像 ID 等元数据用于后续构建。

归档方式下，`environment.platform` 显式选择下载平台，`auto` 使用执行节点原生平台；不采用任务内原 Registry 镜像的平台声明。本机对应 URL 的 Evaluator 镜像标签存在时复用；覆盖远端同名文件后需清理对应镜像缓存，或使用新的版本目录/revision。操作和迁移说明见[任务镜像归档](../development/image-archives.md)。

官方维护的 ModelScope 仓库为 [evolving-foundry/ember-evaluator](https://www.modelscope.cn/datasets/evolving-foundry/ember-evaluator)，存放部分 Benchmark 的官方任务镜像归档。可用镜像以仓库目录为准；上传自己的镜像见[单个和批量上传指引](../development/image-archives.md#上传到-modelscope)。

### 核验 ModelScope 镜像

比较同一平台下的完整镜像 ID：**ID 相同，就是同一个镜像，名称和标签可以不同。**

下面以 `linux/amd64` 为例，替换镜像引用和文件路径后，按顺序执行：

```bash
# 1. 拉取官方镜像，记下输出的完整 ID
docker pull --platform linux/amd64 '官方镜像:标签'
docker image inspect --platform linux/amd64 --format '{{.Id}}' '官方镜像:标签'

# 2. 加载 ModelScope 下载的归档
docker load --input solve.tar.gz

# 3. 使用上一步 Loaded image 输出的引用，查看 ID，与第 1 步比较
docker image inspect --platform linux/amd64 --format '{{.Id}}' '导入后的镜像引用'
```

先记下官方 ID，再加载归档，避免同名标签被覆盖。若 ID 不同，检查是否使用了相同版本和平台，或误打包了 Runtime/Agent 镜像；官方 tag 更新也会导致 ID 不同。

## 预热期间的镜像与依赖下载

“Evaluator 主动获取镜像”描述由谁发起操作，不表示一定由 Evaluator 自己下载镜像层。任务环境指定现成镜像时，Evaluator 检查本地镜像，需要下载时调用镜像获取器；任务提供 Dockerfile 时则执行构建，其中的 `FROM` 由 Docker/BuildKit 解析和拉取。`docker.pull.method` 只选择显式镜像获取方式，不接管构建器的 `FROM`。

| 下载步骤 | 镜像源或下载地址 | 连接代理 |
| --- | --- | --- |
| 主动获取镜像，`method: docker` | `docker.mirrors` 替换地址后执行 `docker pull` | Docker daemon / Desktop 的代理 |
| 主动获取镜像，`method: registry-client`、`backend: nodejs` | `docker.mirrors` 替换地址，由 Evaluator 下载并导入 Docker | 网络文件解析后的 host 代理 |
| Dockerfile 的 `FROM` 或外部 `COPY --from` | Docker daemon/BuildKit 的 registry 配置；不使用 YAML 的 `docker.mirrors` | Docker daemon / Desktop 的代理 |
| Dockerfile 的 `RUN pip install` 等 | `sources` 中对应的包源或命令的下载地址 | 网络文件解析后的 build 代理 |
| Harness 运行时安装依赖 | `sources` 中对应的包源或安装器的下载地址 | 网络文件解析后的 runtime 代理 |

例如，SWE-bench 预热可能先构建以 `FROM swebench/...` 开头的任务镜像，再准备 Evaluator 的 Node 运行环境。Node 镜像本地不存在时通过镜像获取器下载，使用默认 `docker.pull` 和 `docker.mirrors`；已有镜像则可复用。任务在 `FROM` 阶段失败时，尚未进入后续运行环境准备，不能据此判断整个预热都不使用 YAML 镜像配置。

YAML 的 `docker.mirrors` 不会写入 daemon 的 `registry-mirrors`，YAML 的代理也不会自动修改已运行的 Docker daemon。两处镜像源即使填同一地址，仍分别控制上述不同步骤。`proxy: null` 或某个代理字段为 `null` 也不会关闭 Docker Desktop 已配置的代理；网络文件的环境变量覆盖规则见上文。

## Docker 构建与诊断

`FROM` 和外部 `COPY --from` 使用 Docker 自带构建器及 daemon 的网络。临时 registry 映射只控制显式镜像获取。`RUN` 使用应用环境变量覆盖后的代理、包源和临时 Dockerfile 副本，原任务文件保持不变。`docker.buildNetwork` 可选 `default` 或 `host`；这不是任务运行网络权限。

`doctor experiment.yaml` 的 `network.dockerAdvice` 提供脱敏的 Docker 代理配置建议，Docker 探针通过当前 context 访问 daemon。Linux Engine 管理员保留原配置其他字段，校验后应用并重启；Docker Desktop 在 Desktop 设置中应用代理，不能依赖 `daemon.json` 的代理字段。远端 daemon 的配置必须在远端主机应用。所有普通评测、预热和诊断命令均不自动重启 Docker。

`inspect experiment.yaml` 显示实验配置、网络文件绝对路径和脱敏后的实际设置，不发网络请求。`doctor experiment.yaml` 同时检查配置、工具和网络，显式进行临时下载，报告位置、目标、路线、证据和耗时；`passed`、`failed`、`not-checked`、`not-applicable` 分别表示通过、失败、未完成验证、不适用。缓存命中或无法证明实际下载时不计为通过，报告不完整时退出码为 1。Python/pip/uv/npm/pnpm/Git 需要在被检查的执行节点可用；不会安装到宿主系统。Ray 实验在实际执行节点运行探针；节点不可用会单独报告失败。

`warmup` 按实验选题准备真实数据、镜像和安装依赖，可用于固定路径归档和具体任务验收。它不调用模型。正常 `run` 不执行额外诊断下载。

诊断在 stderr 逐项显示状态，最终 JSON 的 `network.configPath` 标明当前文件，`recommendedConfigPath` 和 `recommendedCommand` 指向随包提供的国内源示例。先根据失败原因修改当前文件，再按 `retryCommand` 重试；也可显式选择推荐配置，程序不会自动换源。WorkBuddy、Terminal-Bench 等归档题库还会读取实际任务压缩包的一小段数据，完整校验仍使用 `warmup`。

失败探针保留原始原因，并通过 `guidance.yamlFields` 列出需要核对的 YAML 字段，`guidance.action` 给出调整步骤。程序缺失、认证失败和 Docker daemon 连接问题不能一律通过换源解决；缓存证据不足也不等于网络失败。

## 源码启动与部署

首次安装前即可使用仓库附带的启动器（需符合 `package.json` 的 Node.js/pnpm 版本）：

```bash
node scripts/network/bootstrap.mjs --network network.yaml -- pnpm install --frozen-lockfile
node scripts/network/bootstrap.mjs --network network.yaml -- pnpm ray:ensure
```

启动器包含 YAML 解析依赖。修改相关源码后运行 `pnpm network:bundle` 更新它。toolbox 读取 `EVALUATOR_NETWORK_CONFIG` 或默认网络文件，构建副本及首次依赖安装使用该文件，并挂载到管理容器中。Ray 部署生成节点模板和 Compose 覆盖文件，模板变量由节点环境展开；skopeo 也需在每个使用它的节点预装。

Docker-in-Docker 首次创建时接收 YAML 中的 daemon 代理。已有服务的网络配置发生变化时，启动器停止并要求管理员显式重建这些服务，不自动重启运行中的 daemon。直接手工运行 Compose 会绕过启动器；请使用网络启动器和生成的覆盖文件。

第三方脚本若在命令行写死其他源，环境变量不能保证覆盖。诊断只能验证实际运行的路径；具体任务仍需 `warmup`。工具安装权限、私有 Git SSH 认证、远端 Docker 和真实归档服务需要在目标部署环境验收。
