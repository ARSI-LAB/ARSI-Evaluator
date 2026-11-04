# 数据下载与镜像构建 FAQ

> [English](./downloads.md) | 中文

[FAQ 目录](README.zh-CN.md) · [用户文档](../README.zh-CN.md)

下文环境变量应设置在实际启动 Evaluator 或执行节点的环境中。修改下载源不会改变数据版本和摘要要求。

## 数据下载、镜像与代理

数据和依赖下载缺省使用官方源。通过独立的[网络 YAML](../network.zh-CN.md)选择 Hugging Face、GitHub、pip/uv、npm、Node、APT 源及各执行位置的代理。文件通过 `--network` 或 `EVALUATOR_NETWORK_CONFIG` 指定。

APT 换源处理 `/etc/apt/sources.list` 和 `sources.list.d/` 下的 `.list`、`.sources` 文件。`sources.apt` 分别指定 Debian 主仓库、安全仓库及 Ubuntu archive、security、ports 的完整地址，保留发行版、组件和签名密钥；第三方仓库保持原地址。原始任务文件和已有镜像不会被原地修改。

固定 Node Docker 镜像、任务基础镜像和独立裁判镜像使用网络 YAML 的 `docker.pull` 与 `docker.mirrors`。镜像源按原 registry 精确匹配，固定 digest 与平台校验保持不变；不再自动挑选 daemon 中的华为云镜像。`FROM` 的联网由实际 Docker daemon 配置负责。三种获取方式及配置示例见[网络下载配置](../network.zh-CN.md)。

评测进程的全局 `fetch` 和 Pi runner 在直连和代理连接下均默认使用 HTTP/1.1。在**启动进程前**设置 `EVALUATOR_HTTP2=1` 才允许协商 HTTP/2；不设置或设为 `EVALUATOR_HTTP2=0` 时使用 HTTP/1.1。开启后，服务器不支持 HTTP/2 时仍可使用 HTTP/1.1。代理配置和 TLS 证书验证继续生效。Pi runner 从自身环境读取此变量；容器和 Worker 的启动环境需单独配置；它不控制浏览器、Docker 镜像拉取、外部下载命令或其他第三方 Solver 运行时。

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

`PIP_IGNORE_INSTALLED` 是独立的安装行为选项，允许 `0/1/false/true`，默认不设置。它改变 pip 安装行为并参与构建缓存标识，不属于网络换源配置。其他网络变量需在网络 YAML 中显式引用，字段及优先级见[网络指南](../network.zh-CN.md)。使用 Docker 适配脚本时，在 `verifier.config.dockerExecutable` 中也显式选择相应脚本；Environment 与 Verifier 的执行器分别配置。

构建成功不代表做题进程也能下载依赖。普通及 Compose 主容器从网络配置获得 `NPM_CONFIG_REGISTRY`、`PIP_INDEX_URL`、`PIP_EXTRA_INDEX_URL` 和 `UV_DEFAULT_INDEX`，任务或 Environment 显式设置的同名变量优先；`model-api` 隔离环境不继承这些部署变量。

任务镜像构建为未配置的 APT 选项补充缺省值：单个文件下载失败最多重试三次，HTTP/HTTPS 连接和读取超时 30 秒；索引更新重试后仍有错误时立即失败，避免继续安装后只报找不到包。配置在 CA 引导之前生效，镜像已有设置、任务后续配置及 `apt-get -o` 参数可覆盖缺省行为。重试发生在 APT 下载阶段；下载重试耗尽后构建失败，不触发整个镜像构建或 Attempt 的自动重试。编译失败和脚本错误也不重试；原有环境准备总时限仍生效。

Git 拉取 WorkBuddy 固定提交及 uv.lock 中的 Harbor 固定提交，失败最多三次尝试，每次最多 120 秒，低于 1 KiB/s 持续 30 秒会中断；超时会终止 Git 及其传输子进程。Git 不会自动选择第三方公共代理，可配置自己的镜像前缀，或使用可达的 HTTPS_PROXY。

任务基础镜像缺少 CA 证书时，Docker 构建先通过同一镜像源的 HTTP 地址安装 ca-certificates，保留 APT 包签名校验，再切回配置的 HTTPS 源。已经指向所选镜像站 HTTPS 地址的 APT 源也会执行此引导，覆盖 `.list` 和 `.sources` 格式。自建 HTTPS 镜像源需提供对应的 HTTP 引导地址，或在基础镜像预装 CA；已有证书时不会重复安装。此处理只修改构建快照，原始任务文件和来源摘要保持不变。

仅设置 PIP_INDEX_URL 后继续 uv sync --frozen，仍可能使用锁文件中的官方下载 URL。本实现先离线冻结导出 registry 依赖，再从配置的索引以 --require-hashes、--no-deps 安装；上游版本和哈希保持不变，两个源码包按固定提交安装，不重新解析或修改 uv.lock。导出机制见 [uv 官方文档](https://docs.astral.sh/uv/concepts/projects/sync/#exporting-the-lockfile)。

## 已有缓存为什么还会访问数据源？

缓存命中需要同时匹配来源标识、固定版本和内容摘要；磁盘上存在部分文件不等于已有完整、可校验的来源锁。检查原 run 的 `manifest.json`、实际 `cacheDir` 和当前运行环境，避免 Windows、WSL 或不同用户使用了不同缓存目录。

GitHub/HF 的 403 与模型服务的 403 是不同问题。先在失败日志中确定访问的是哪一个域名，再检查该数据源的权限、限流或代理；不要通过修改来源摘要绕过验证。旧版 DeepSWE 专用缓存登记脚本依赖已移除的来源实现，不适用于当前 Harbor Profile；新实验使用当前来源适配器，历史结果保留后可离线重建报告。

## 构建时 pip 无法卸载 distutils 包怎么办？

仅当上游镜像混用 Conda 与 pip，日志明确显示无法卸载 distutils 安装包时，才尝试设置 `PIP_IGNORE_INSTALLED=1`。它会改变 Python 包安装结果并产生新的镜像缓存身份；不要把它当成所有安装错误的默认处理方式。验证新环境后再开始新的评测。

## 下载失败后能否只补测失败任务？

恢复网络后使用[网络故障补测](../network-retry.zh-CN.md)。只有有明确网络证据、没有有效评分且资源已回收的任务可以补测；镜像不存在、永久权限错误、依赖冲突和普通超时不满足条件。
