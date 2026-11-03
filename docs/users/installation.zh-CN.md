# 安装与部署

> [English](./installation.md) | 中文

本文说明源码安装、AgentBundle 前置构建、全局命令和跨目录运行。

[返回项目主页](../../README.zh-CN.md) · [用户手册](README.zh-CN.md)

## 名称与已有部署

项目包名和主命令为 `ember-evaluator`，短命令为 `ember`。插件从 `ember-evaluator` 导入公共 API；模型运行时认证变量为 `EMBER_EVALUATOR_API_KEY`，原生 Bash 路径覆盖变量为 `EMBER_BASH_PATH`。Pi Bundle 的 `harness.name` 和安装 profile 均为 `pi`，WorkBuddy Pi 示例路径为同级 `pi/bundles/pi`，请按实际目录调整。

已有部署更名后需要重新链接全局命令并同步更新插件导入、环境变量和 Bundle manifest。旧命令与变量没有兼容别名；缓存、Docker 镜像和已有结果不自动迁移，跨更名前后的续跑兼容性未保证。

## 直接安装

需要 Node.js **24.22.1 或更新的 24.x**、Corepack、Git 和 pnpm **11.22.0**。未配置代理时，下载请求使用 Node.js 内置 `fetch()`；旧版 Node.js 内置的 undici 不会随项目 npm 依赖升级，请同时更新本机和 Ray 节点的 Node.js。以下使用 Linux / WSL 的 Bash；WSL 下的安装、构建和运行都在同一个 WSL 环境中执行。

先准备同级的两个仓库：

```text
/path/to/workspace/
├── AgentBundle/
│   └── packages/core/
└── ember-evaluator/
```

当前 [pnpm-workspace.yaml](../../pnpm-workspace.yaml) 使用本地依赖覆盖：`agent-bundle-core` 指向 `../AgentBundle/packages/core`，`agentbundle-workspace` 指向 `../AgentBundle/packages/cli`。因此安装前必须准备同级的 AgentBundle 源码，且先构建 core；即使本次使用 `simpleagent`，Evaluator 也会加载这个 SDK。AgentBundle 仓库与 Solver 配置中的 `AGENT_BUNDLE_PATH` 不同，后者指向待评测的 Agent Bundle。

如果同级还没有 AgentBundle，在两个仓库的父目录克隆它，已有目录则跳过：

```bash
cd '/path/to/workspace'
git clone ssh://git@gitcode.com/evanTang/AgentBundle.git AgentBundle
```

克隆需要该 GitCode 仓库的读取权限。AgentBundle 当前没有声明 `packageManager`，Evaluator 固定为 `pnpm@11.22.0`，所以两个仓库都显式使用 `corepack pnpm@11.22.0`，避免切换目录后使用不同版本。先检查工具：

```bash
node --version
corepack pnpm@11.22.0 --version
```

如果没有 `corepack`，先执行 `npm install --global corepack`。然后按顺序安装和构建，替换下面的父目录路径：

```bash
cd '/path/to/workspace/AgentBundle' && \
corepack pnpm@11.22.0 install --frozen-lockfile && \
corepack pnpm@11.22.0 --filter agent-bundle-core build && \
cd '../ember-evaluator' && \
corepack pnpm@11.22.0 install --frozen-lockfile && \
corepack pnpm@11.22.0 build && \
node dist/cli.js --help
```

Evaluator 的 `install` 会通过 `prepare` 自动构建一次，上面仍显式保留 `build`，便于检查最终产物。先构建 AgentBundle core 的顺序不能省略；只有源码而没有 `packages/core/lib` 产物时，Evaluator 可能报找不到 `agent-bundle-core` 或其类型声明。

后续修改或更新 AgentBundle 后，先重新构建 core，再构建 Evaluator。已完成 Evaluator 依赖安装时，可从 Evaluator 仓库根目录按下面的顺序运行 Terminal-Bench 4.0：

```bash
cd '../AgentBundle' && \
corepack pnpm@11.22.0 install --frozen-lockfile && \
corepack pnpm@11.22.0 --filter agent-bundle-core build && \
cd '../ember-evaluator' && \
corepack pnpm@11.22.0 build && \
node dist/cli.js run playbook/terminalbench/terminalbench-4.0.yaml
```

运行前在同一终端设置 YAML 引用的模型变量，并准备该任务所需的 Docker 等条件，见[快速上手的模型变量](quick-start.zh-CN.md#3-设置模型变量)、[Harbor 指南](benchmarks/harbor.zh-CN.md)和 [Playbook](../../playbook/README.md)。依赖安装与构建只在首次准备或相关代码、依赖变化后执行，不需要在每次评测前重复。

开发检查使用 `corepack pnpm@11.22.0 typecheck` 和 `corepack pnpm@11.22.0 test --run`，生成发行包使用 `corepack pnpm@11.22.0 pack --pack-destination .scratch/packages`（先完成构建）。

## 安装全局命令

完成上面的两个仓库构建后，在 **Evaluator 仓库根目录**注册命令：

```bash
corepack pnpm@11.22.0 add -g .
ember-evaluator --help
```

如果提示未设置全局 bin 目录、全局 bin 目录不在 PATH，或终端找不到 `ember-evaluator`，先运行：

```bash
corepack pnpm@11.22.0 setup
```

按提示重新打开终端或重新加载 shell 配置，再回到 Evaluator 仓库重试注册命令。pnpm 11 的全局命令目录是 `$PNPM_HOME/bin`；可用 `corepack pnpm@11.22.0 bin -g` 查看，详见 [pnpm 全局命令说明](https://pnpm.io/global-packages#registering-local-packages-globally)。

这一步把本地项目的 `bin` 入口注册为命令，便于离开源码目录使用；请保留本地 Evaluator、相邻 AgentBundle 以及已安装的依赖。它不要求将包发布到 npm，也不等于可以删除源码目录。

## 在任意目录运行

安装全局命令后，可以在安装它的同一运行环境中离开源码目录执行，例如同一个 WSL 环境；配置使用绝对路径：

```bash
cd ~
ember-evaluator doctor '/path/to/config.yaml'
ember-evaluator run '/path/to/config.yaml'
```

也可以直接运行仓库中的示例：

```bash
ember-evaluator run '/path/to/workspace/ember-evaluator/playbook/terminalbench/terminalbench-4.0.yaml'
```

配置内的 `output.directory`、Bundle 路径等相对路径以 **YAML 所在目录**为基准，切换当前目录不会改变它们。复制 YAML 到其他目录后应检查这些路径；命令行 `--patch` 则以当前工作目录解析，跨目录运行时建议也传绝对路径。使用命令的终端仍需设置模型环境变量，执行机器仍需满足 Docker、Harness 等运行条件。

## 本机运行时缓存与 Windows 路径长度

使用本机环境时，Evaluator 会按所选 Solver 准备独立的运行文件和依赖，例如 AgentX 的 Python venv。托管缓存使用 `<运行时名称和版本>/<12 位内容哈希>/`，例如 `agentx-1.0.7-py3.12/a1b2c3d4e5f6/`。相同内容跨次运行复用；安装文件、命令或平台改变时，生成另一个哈希目录。完整内容哈希保存在目录内的 `.runtime-ready.json`，用于复用检查。

Windows 默认根目录为 `%LOCALAPPDATA%\ember\r`，未设置 `LOCALAPPDATA` 时使用用户目录下的 `AppData\Local\ember\r`。macOS 仍使用 `~/Library/Caches/ember-evaluator/runtimes`；Linux 仍使用 `${XDG_CACHE_HOME:-~/.cache}/ember-evaluator/runtimes`。已有完整哈希命名的缓存不自动搬迁或删除，新路径首次使用时会重新安装。

安装直接在最终目录执行，不添加 UUID 临时目录，也不在安装后移动 Python venv。无需管理员权限或开启 Windows 长路径。如果用户目录特别长、第三方依赖仍出现 `WinError 206`，可在启动 Evaluator 前为本机运行时指定更短的绝对路径，例如 PowerShell：

```powershell
$env:EVALUATOR_RUNTIME_CACHE_DIR = "D:\ae"
ember-evaluator run "D:\experiments\config.yaml"
```

该变量只改变托管本机运行时的位置，不改变结果、数据集或 Docker 镜像缓存。短目录不能保证任意深度的第三方依赖都低于 Windows 路径限制。

安装失败或取消时会删除本次创建的运行时目录。进程被强制终止后若留下未完成目录，或完整摘要校验失败，Evaluator 会报出目录位置；确认没有进程使用后再删除该目录并重试。不要删除其他正在使用的哈希目录。

## 在管理容器中运行（Linux 服务器）

宿主机需已有 Docker Engine。在宿主机的仓库根目录启动管理容器：

```bash
bash scripts/toolbox/run.sh
```

toolbox 保留工作目录的内外绝对路径，Evaluator 和同级 AgentBundle 在容器内均可访问。先在管理容器中为 AgentBundle 安装依赖并构建 core，再构建 Evaluator；安装顺序与上方源码安装相同。管理容器已设置 `PNPM_HOME`、PATH 并创建全局命令目录，不需要再运行 pnpm setup 或手动配置 PATH。完整边界见[管理容器指南](deployment/container-toolbox.zh-CN.md#环境边界)。

提供上述依赖后，进入容器，在 Evaluator 仓库目录执行：

```bash
bash scripts/toolbox/git-login.sh # 按提示输入 GitCode 账号和访问令牌，以 HTTPS 拉取私有 AgentBundle
pnpm install --frozen-lockfile
pnpm build
```

模型配置、两题 Office 示例、Ray 运行及 ARM64 兼容步骤见 [管理容器使用指南](deployment/container-toolbox.zh-CN.md)。Docker 的 `environment.config.platform` 缺省为 `auto`。当 Benchmark 未声明平台时，用户可根据其实际平台要求在 YAML 中指定平台，例如任务的 `task.toml` 未声明架构、但镜像仅支持 amd64 的情况；当 Benchmark 已声明平台时，以该声明为准，YAML 中指定的平台不生效。两处均未指定平台时，使用 Docker 节点原生平台。跨架构时警告可能存在性能损耗，并检测、使用已有 QEMU，详细规则见 [Docker 目标平台](deployment/docker-platform.zh-CN.md)。依赖安装和 Git/SSH 配置保存在管理容器及其专用卷中；仓库与宿主机共享，任务容器由宿主机 Docker 管理。
