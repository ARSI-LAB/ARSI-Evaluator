# 网络配置字段与代理

> [English](network.md) | 中文

[网络配置入口](../network.zh-CN.md)

本文说明如何修改网络文件：先复制示例，按需修改下载地址或代理，再检查环境变量是否覆盖了配置。确认可用后，可以将它设为默认文件。

## 修改 mirrors.yaml

仓库中的 [mirrors.yaml](../../../playbook/network/mirrors.yaml) 提供镜像源示例。建议在仓库根目录复制为自己的 `network.yaml`，后续命令使用这份副本：

```powershell
# PowerShell
Copy-Item -LiteralPath playbook/network/mirrors.yaml -Destination network.yaml
```

```bash
# Bash
cp playbook/network/mirrors.yaml network.yaml
```

修改副本中已有的字段。例如，将 Python 包源改回官方 PyPI，只需把 `sources.python.index` 改成下面的值，其他字段保留：

```yaml
sources:
  python:
    index: https://pypi.org/simple
```

上面是修改片段，不是完整文件；将值写入已有的 `sources`，不要再添加第二个 `sources:`。其他包源和代理字段见后文。要同时从 ModelScope 下载任务镜像，按[组合镜像源的方法](../image-downloads.zh-CN.md#从-modelscope-下载任务镜像)添加 `docker.benchmarks`。

修改后检查实际配置，再运行自己的实验：

```bash
ember-evaluator inspect experiment.yaml --network network.yaml
ember-evaluator run experiment.yaml --network network.yaml
```

## 修改下载地址

`sources` 控制数据和依赖包的下载地址。把对应字段换成执行节点能够访问、提供相同内容和路径布局的源：

| 字段 | 用途 |
| --- | --- |
| `sources.huggingface` | 数据集、任务文件、tokenizer 的 Hub 地址 |
| `sources.python.index/extraIndexes` | pip 和 uv 包索引 |
| `sources.python.interpreter` | uv 的 Python 解释器下载镜像；`null` 使用工具默认地址 |
| `sources.npm.registry` | npm、pnpm 和 Corepack 包源 |
| `sources.node.dist` | Node.js 发行文件地址 |
| `sources.github.api/raw/repository` | GitHub API、文件和 HTTPS Git 仓库地址 |
| `sources.apt` | `debian`、`debianSecurity`、`ubuntu`、`ubuntuSecurity`、`ubuntuPorts` 各自的完整仓库根地址 |

Docker 镜像另由 `docker` 配置：`docker.pull` 设置共享镜像及未单独配置的题库任务镜像的获取方式，`docker.benchmarks` 为指定题库的任务镜像单独选择方式。例如，任务镜像从 ModelScope 下载、共享镜像使用 `docker pull`，见[带注释的完整配置](../image-downloads.zh-CN.md#从-modelscope-下载任务镜像)。`docker.mirrors` 只修改 Registry 下载地址。

例如，`mirrors.yaml` 中的 `docker.mirrors.docker.io` 使用 DockerProxy。要恢复直接从 Docker Hub 拉取，删除该条目；若不使用任何 Registry 镜像源，在已有的 `docker:` 下将 `mirrors` 改为 `mirrors: {}`。配置结构和匹配规则见[镜像下载](../image-downloads.zh-CN.md#镜像获取方式)。

## 设置代理

下载地址决定请求发到哪里，`proxy` 决定请求是否经过代理。需要代理时，修改已有的 `proxy` 字段：

```yaml
proxy:
  http: http://127.0.0.1:7890
  https: http://127.0.0.1:7890
  noProxy: [localhost, 127.0.0.1, "::1"]
```

`http` 和 `https` 分别用于 HTTP、HTTPS 请求，只接受 HTTP(S) 代理地址；设为 `null` 表示直连。两者不相互补齐。`noProxy` 列出需要直连的地址。

`127.0.0.1` 始终指执行位置自身。代理在宿主机、任务在容器或 Ray 节点时，需要填写该执行位置实际能访问的地址，不会自动改成 `host.docker.internal`。

需要为不同位置设置代理时，使用以下字段；未填写的字段继承上面的公共代理，整个位置设为 `null` 表示该位置直连：

| 字段 | 适用位置 |
| --- | --- |
| `proxy.overrides.host` | Evaluator 进程 |
| `proxy.overrides.daemon` | Docker daemon |
| `proxy.overrides.build` | Dockerfile 的 `RUN` |
| `proxy.overrides.runtime` | 运行时安装命令 |

Docker 原生拉取使用 daemon 的代理；使用已有 daemon 时，按[部署网络配置](../deployment/network.zh-CN.md)在该 daemon 上应用设置。`docker.buildNetwork` 也在该文档说明。

Git SSH 的 `git.ssh.route` 默认为 `direct`。需要通过 HTTP CONNECT 代理时设为 `proxy`，并为 Evaluator 进程设置可用的 HTTP 或 HTTPS 代理；SSH 仓库地址保持不变。

认证代理请写成 `${NODE_PROXY}` 等环境变量引用。Ray 不接受直接带用户名或密码的代理地址；在每个执行节点设置对应变量，并检查该节点是否有其他网络环境变量覆盖它。

## 检查环境变量覆盖

字段优先级为：**已设置且非空的受支持环境变量 → YAML → 程序默认值**，传入 `--network` 时也适用。若修改 YAML 后实际地址没有变化，先用 `inspect` 查看结果，再核对下表。

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

例如，设置了 `HTTPS_PROXY` 时，它会覆盖所有位置的 `proxy.https`，包括 YAML 中显式填写的地址和 `null`，其他字段保留。要重新使用 YAML 中的 HTTPS 代理，在当前终端清除该变量，并检查小写变量 `https_proxy`：

```powershell
# PowerShell：清除已设置的变量
Remove-Item Env:HTTPS_PROXY -ErrorAction SilentlyContinue
```

```bash
# Bash：同时清除两种大小写
unset HTTPS_PROXY https_proxy
```

空字符串环境变量视为未设置，不会清空 YAML；无效的环境变量值直接报错。`ALL_PROXY` 不作为配置输入。

## 设置默认网络文件

每次命令只读取一份网络文件，按以下顺序选择：

| 优先级 | 文件来源 |
| --- | --- |
| 1 | CLI 的 `--network`，或 SDK 的 `networkConfigPath` |
| 2 | 环境变量 `EVALUATOR_NETWORK_CONFIG` |
| 3 | Linux/macOS 的 `~/.ember-evaluator/network.yaml`，或 Windows 的 `%USERPROFILE%\.ember-evaluator\network.yaml` |

相对路径以当前工作目录为基准。选中的文件不会与用户目录的默认文件叠加，未填写的字段使用程序默认值。显式指定的文件不存在或格式错误时直接报错。默认文件不存在时，程序会创建官方源和直连配置；已有文件不会被覆盖。

要长期使用自己的文件，可以编辑上述默认文件，或者在当前终端设置 `EVALUATOR_NETWORK_CONFIG`：

```powershell
# PowerShell：替换为已有文件的绝对路径
$env:EVALUATOR_NETWORK_CONFIG = "C:\configs\network.yaml"
```

```bash
# Bash
export EVALUATOR_NETWORK_CONFIG=/path/to/network.yaml
```

设置后，同一终端中的命令可以省略 `--network`；临时使用其他文件时再次传入该参数。

运行中的进程使用启动时读取的网络配置。停止的 run 用 `retry --run <run-id-or-directory>` 补跑时会重新读取当前网络文件，也可用 `--network` 指定。模型 API 地址、认证和任务网络权限仍由实验配置控制。

## 文件格式要求

- 顶层字段为 `proxy`、`sources`、`docker` 和 `git`，均可省略；不接受 `version` 或其他未知字段。
- 空文件、只有注释或 `{}` 均可。未被环境变量覆盖的字段使用程序默认值。
- 支持 `${VARIABLE}` 引用。字段已被受支持的环境变量覆盖时，不展开它原来的引用。

工具缺失、连接失败和下载验证见[网络诊断](../faq/network.zh-CN.md)。
