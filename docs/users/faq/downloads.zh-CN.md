# 数据下载与镜像构建 FAQ

> [English](./downloads.md) | 中文

[FAQ 目录](README.zh-CN.md) · [用户文档](../README.zh-CN.md)

下文环境变量应设置在实际启动 Evaluator 或执行节点的环境中。换源只改变下载地址，实验选择的数据版本保持不变。

## 数据下载、镜像与代理

数据和依赖下载缺省使用官方源。通过独立的[网络 YAML](../network.zh-CN.md)选择 Hugging Face、GitHub、pip/uv、npm、Node、APT 源及各执行位置的代理。文件通过 `--network` 或 `EVALUATOR_NETWORK_CONFIG` 指定。

`sources.apt` 分别设置 Debian 主仓库、安全仓库及 Ubuntu archive、security、ports 的完整地址。构建时会使用这些地址，同时保留原发行版和签名设置；第三方仓库需要另行配置，原始任务文件不会被修改。

共享镜像默认使用 `docker.pull` 指定的方式，`docker.mirrors` 可设置 Registry 镜像源。任务镜像还可以通过 `docker.benchmarks` 单独指定 ModelScope/Hugging Face 归档来源。Dockerfile 中的 `FROM` 使用 Docker daemon 的网络设置。具体配置见[镜像下载](../image-downloads.zh-CN.md)。

Evaluator 和 Pi runner 默认使用 HTTP/1.1。在**启动进程前**设置 `EVALUATOR_HTTP2=1` 可允许 HTTP/2；不设置或设为 `0` 则保持 HTTP/1.1。服务器不支持 HTTP/2 时仍可使用 HTTP/1.1。

容器和 Worker 需要在各自的启动环境中设置此变量。它不控制浏览器、Docker 镜像拉取或第三方 Solver 自己的下载工具。

```bash
# 可选：允许 HTTP/2（Git Bash / Linux / macOS）
export EVALUATOR_HTTP2=1
```

```powershell
# 可选：允许 HTTP/2（PowerShell）
$env:EVALUATOR_HTTP2 = "1"
```

大文件下载反复报 `UND_ERR_RES_CONTENT_LENGTH_MISMATCH` 时，保持默认 HTTP/1.1，并检查代理连接。当前下载中断后仍会从头重试。

## 裁判镜像的下载源与构建网络

任务镜像、Solver 运行时和裁判镜像分别构建，但读取同一次运行的网络 YAML。`sources.python`、`sources.npm`、`sources.github`、`sources.apt` 指定安装源，`proxy.overrides.build` 指定构建代理，`docker.buildNetwork` 选择 `default` 或 `host`。缺省使用官方源；代理中的回环地址不自动改写，需填写容器可访问的地址。

受支持的非空网络环境变量优先于网络 YAML，字段及优先级见[网络配置字段](../reference/network.zh-CN.md)。如果使用自定义 Docker 适配脚本，Environment 和 Verifier 需分别指定执行器；Verifier 使用 `verifier.config.dockerExecutable`。

构建成功不代表做题进程也能下载依赖。普通及 Compose 主容器从网络配置获得 `NPM_CONFIG_REGISTRY`、`PIP_INDEX_URL`、`PIP_EXTRA_INDEX_URL` 和 `UV_DEFAULT_INDEX`，任务或 Environment 显式设置的同名变量优先；`model-api` 隔离环境不继承这些部署变量。

APT 下载默认对失败文件最多重试 3 次，连接和读取超时为 30 秒；镜像或任务已有设置时使用其设置。索引更新重试后仍失败，会停止构建。下载重试不重新执行整个镜像构建或任务，编译和脚本错误也不会因此重跑。

WorkBuddy 和 Harbor 的 Git 依赖下载最多尝试 3 次，每次最多 120 秒；持续低速也可能中断。遇到连接问题时，配置可访问的 Git 镜像地址或 `HTTPS_PROXY`，程序不会自动选择第三方公共代理。

基础镜像缺少 CA 证书时，构建会先安装 `ca-certificates`，再使用 HTTPS 包源。自建 HTTPS APT 镜像源需提供对应的 HTTP 地址用于首次安装证书，或者在基础镜像中预装 CA 证书。

依赖锁文件可能保存了固定下载地址。框架安装 Harbor 依赖时会使用配置的包源，并保留锁定的版本；源码依赖仍使用固定 Git 提交。任务自己的安装脚本若仍访问其他地址，需要检查脚本和工具配置。

## 已有缓存为什么还会访问数据源？

只有当前来源和版本所需的文件完整时，才能复用缓存；下载了一部分仍可能需要联网。检查实际 `cacheDir`，并确认正在使用相同的运行环境。Windows、WSL 或不同用户可能使用不同缓存目录。

GitHub/Hugging Face 的 403 与模型服务的 403 要分别处理。先从失败日志确认域名，再检查对应账号权限、访问限制或代理配置。

## 构建时 pip 无法卸载 distutils 包怎么办？

只有日志明确显示无法卸载 distutils 安装包、且镜像混用 Conda 与 pip 时，才尝试设置 `PIP_IGNORE_INSTALLED=1`。它会改变 Python 包安装结果并重新构建相关依赖层。先预热确认安装成功，再开始新的评测；其他安装错误应按日志原因处理。

## 下载失败后能否只补测失败任务？

恢复网络后使用[网络故障补测](../network-retry.zh-CN.md)。只有有明确网络证据、没有有效评分且资源已回收的任务可以补测；镜像不存在、永久权限错误、依赖冲突和普通超时不满足条件。
