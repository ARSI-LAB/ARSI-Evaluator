# 选择 Solver 和模型服务

> [English](./solvers.md) | 中文

Benchmark 决定任务和评分，Solver 决定模型请求或 Agent 怎样执行。普通 Agent 任务可先用默认 SimpleAgent 跑通；MMLU 和 AgentX 使用各自的默认 Solver。修改后先做配置检查，并开始新的 run。

## 选哪一种 Solver

| Solver | 用途 | 额外准备 |
| --- | --- | --- |
| `simpleagent` | 内置 Pi Agent，普通质量题与需要工具/文件操作的任务 | 支持工具调用的模型 API；可选 Pi Bundle |
| `agentbundle` | 运行已打包的 DSH、deepagents、Hermes、Jiuwenswarm、pi 或 Dify Agent | 可读取且格式正确的 Bundle，满足对应 Harness 运行条件 |
| `codex` | 用 Codex CLI 解文本题、执行命令和生成任务文件 | 支持流式 Responses API 和工具调用的模型服务 |
| `claudecode` | 用 Claude Code 解文本题、编辑任务文件，在本机和 Docker 中执行 Bash | 支持流式 Anthropic Messages API 和工具调用的模型服务 |
| `zcode` | 用 ZCode CLI 解文本题、编辑任务文件，在本机和 Docker 中执行 Bash | 支持流式 Chat Completions、Responses 或 Messages 和工具调用的模型服务 |
| `agentx-replay` | 按 Trace 请求模型，测量服务性能 | AgentX 所需的流式 API、长上下文、tokenizer 和 Python 或 Docker |
| `choice-logprobs` | 直接请求单个输出位置的候选概率，供 MMLU 评分 | local 环境；模型服务必须实际返回 logprobs/top_logprobs；按需关闭思考 |

`simpleagent` 是框架通用默认值。AgentX Profile 自动选择 `agentx-replay`；MMLU Profile 自动选择 `choice-logprobs`。MMLU 不能仅靠 Agent 最后输出的字母评分，服务要求、候选缺失处理及 Chat 适配差异见[评分规则](reference/scoring.zh-CN.md#mmlu-概率评分与服务要求)。

每次选择一条求解路径。EnvironmentSession 表示运行接口和进程执行边界，不表示 Solver 插件代码被整体移动进容器；Harness 适配器负责读取输出并构造 `SolveResult`。评分仍由 Benchmark 执行，AgentX 的性能回放见[专项指南](benchmarks/agentx.zh-CN.md)。

## 模型服务与独立裁判

这是同时声明被测模型和 Judge 的完整两题示例：

```yaml
services:
  default:
    model: ${MODEL_NAME}
    base_url: ${MODEL_ENDPOINT}
    api_key: ${MODEL_API_KEY}
  judge:
    model: ${JUDGE_NAME}
    base_url: ${JUDGE_ENDPOINT}
    api_key: ${JUDGE_API_KEY}
benchmark:
  name: simpleqa
  config:
    judgeService: judge
environment: local
run:
  maxTasks: 2
output:
  directory: ./results/simpleqa
```

按[快速上手](quick-start.zh-CN.md#3-设置模型变量)的方式设置六个环境变量，然后运行 `doctor` 和 `run`。把 `simpleqa` 换成 `healthbench` 即使用 HealthBench 的 Profile。

- `benchmark.solver.service` 选择求解服务；省略时优先用 `services.default`，否则使用唯一服务。多个非 default 服务必须明确选择。
- **SimpleQA/HealthBench** 用 `benchmark.config.judgeService` 选择裁判，不会自动把被测模型当作裁判。`init` 会为它们生成 judge 服务变量；想显式复用同一个服务，可填 `judgeService: default`。
- **Harbor/WorkBuddy** 的模型验证器使用 `benchmark.verifier.service`。Web 要求裁判，Office 的模型评分可选，详见[Harbor 指南](benchmarks/harbor.zh-CN.md)。这与记录型 Benchmark 的 `judgeService` 不是同一个配置入口。

`api` 缺省为 `openai-completions`。显式 `base_url` 使用 Chat Completions 时，Pi/SimpleAgent 和内置 Judge 在未设置 `services.<名称>.maxTokens` 时不发送客户端输出上限；填写正整数时才发送。其他 Provider 和外部 Harness 保留各自协议的配置规则。

如需限制当前服务回复，可以在该服务条目增加 `maxTokens: 8192`。模型请求重试使用 `services.<名称>.retry.maxAttempts`，耗尽后结束当前 Attempt，不自动从头求解。

## SimpleAgent（基于 Pi）

`simpleagent` 是 Evaluator 内置的 Solver，使用 Pi SDK 执行 Agent 循环、模型请求与工具调用。不配置 Bundle 时，使用 Evaluator 默认的指令和工具即可运行；例如 `benchmark: gsm8k` 会选择默认 SimpleAgent，无需额外准备 Pi Bundle。

### 可选：加载 Pi Bundle

需要定制指令、技能、扩展或设置时，可以提供 Pi Bundle。修改为以下片段，保留原 services、environment 等字段：

```yaml
benchmark:
  name: gsm8k
  solver:
    name: simpleagent
    config:
      bundle:
        path: ${PI_BUNDLE_PATH}
```

路径指向已准备好的 Pi Bundle，不是任意源码目录。可用 `bundle.settings` 提供可序列化的 Pi 设置，框架在暂存副本中使用，不直接改原 Bundle。

> 注：Pi Bundle 中的扩展通过 Pi 官方支持的 Extensions（插件）机制加载；这里的 Bundle 是这些扩展及相关资源的打包形式。

### 工具命令超时

工具命令另有超时，增加任务总预算不会自动让单条 shell 命令无限执行。需要调整时：

```yaml
benchmark:
  name: gsm8k
  solver:
    config:
      toolPolicy:
        shellTimeoutSeconds: 180
        shellMaxTimeoutSeconds: 600
```

两项都要填写，最大值不能小于默认值；该片段保留默认的 `simpleagent`。工具调用时实际超时不超过最大值。

## 使用 Codex

`codex` 在本机或 Docker 的任务目录运行 Codex CLI。Evaluator 在首次准备时安装固定版本 `0.167.0`，认证来自所选模型服务。将以下配置保存为实验 YAML，设置 `CODEX_MODEL`、`CODEX_ENDPOINT` 和 `CODEX_API_KEY` 后运行。

```yaml
services:
  codex:
    model: ${CODEX_MODEL}
    base_url: ${CODEX_ENDPOINT}
    api: openai-responses
    api_key: ${CODEX_API_KEY}
benchmark:
  name: gsm8k
  solver:
    name: codex
    service: codex
environment: local
run:
  maxTasks: 1
output:
  directory: ./results/codex
```

- `base_url` 填 API 基址，例如 `https://api.openai.com/v1`，Codex 在该地址下请求 `/responses`。可用 `contextWindow` 指定自动压缩阈值。此 Solver 不支持服务字段 `maxTokens` 和 `retry`。
- 本机使用 Codex 的 `workspace-write` 沙箱。Windows 沙箱拒绝任务的 shell 命令时，可在 Docker 或 WSL 中运行需要写文件的评测。TerminalBench 等容器任务选择 `environment: docker`。
- 此 Solver 接收文本任务。显式图片、PDF、任务技能目录和 MCP 配置会报能力不支持。每次 attempt 的 `agent/` 保存 Codex 事件、Evaluator 轨迹和 stderr，评分仍由所选 Benchmark 或 Verifier 执行。

## 使用 Claude Code

Evaluator 在本机和 Docker 中安装固定版本的 Claude Code `2.1.322`。保存以下实验配置，设置 `CLAUDE_MODEL`、`CLAUDE_ENDPOINT` 和 `CLAUDE_API_KEY` 后运行。

```yaml
services:
  claude:
    model: ${CLAUDE_MODEL}
    base_url: ${CLAUDE_ENDPOINT}
    api: anthropic-messages
    api_key: ${CLAUDE_API_KEY}
benchmark:
  name: gsm8k
  solver:
    name: claudecode
    service: claude
environment: local
run:
  maxTasks: 1
output:
  directory: ./results/claudecode
```

- `base_url` 填 API 基址。Claude Code 会在该地址下请求 `/v1/messages`，通过 `x-api-key` 传递认证。Anthropic 原生服务可填 `https://api.anthropic.com`，DeepSeek 兼容服务可填 `https://api.deepseek.com/anthropic`。
- 内置文件工具仍限于任务目录，CLI 可以用 `Edit` 新建文件。本机和 Docker 都开放 Bash，命令按宿主机或容器进程的权限执行。Windows 需要安装 Git for Windows。如果 Claude Code 找不到 Git Bash，将 `CLAUDE_CODE_GIT_BASH_PATH` 设置为对应的 `bash.exe` 路径。
- Linux 运行时通过仅供当前 attempt 使用的本地转发器访问模型，Bash 启动时会清除转发凭据。
- Solver 接收文本任务，显式图片、PDF、任务技能目录和 MCP 配置会报能力不支持。
- 服务字段 `maxTokens` 传给 Claude Code 的输出用量设置，`contextWindow` 设置自动压缩阈值，允许 100000 到 1000000 token。此 Solver 不接受 `retry`。事件、轨迹和 stderr 保存在每次 attempt 的 `agent/` 目录。

## 使用 ZCode

Evaluator 在准备运行时时从固定源码归档构建 ZCode CLI `0.17.1`。首次运行或预热需要访问 GitHub 和 npm registry，后续运行复用构建缓存。预热无需模型密钥。镜像源配置见[网络配置指南](network.zh-CN.md)。

```yaml
services:
  zcode:
    model: ${ZCODE_MODEL}
    base_url: ${ZCODE_ENDPOINT}
    api: openai-completions
    api_key: ${ZCODE_API_KEY}
benchmark:
  name: gsm8k
  solver:
    name: zcode
    service: zcode
environment: local
run:
  maxTasks: 1
  preparation:
    environmentTimeoutSeconds: 1800
    roundTimeoutSeconds: 1800
output:
  directory: ./results/zcode
```

示例给首次构建预留 30 分钟，可按网络情况调整。

`base_url` 使用接口基地址。Chat Completions 或 Responses 通常填写以 `/v1` 结尾的地址。还可设置 `api: openai-responses` 或 `api: anthropic-messages`。使用此 Solver 时省略 `maxTokens`、`contextWindow` 和 `retry`。

本机和 Docker 都开放 Bash。本机 Bash 具有宿主进程权限，只用于可信任务。Windows 下使用 Bash 工具需要安装 Git Bash。任务需要容器隔离时使用 Docker。

Solver 接收文本提示词和任务工作区文件。显式附件、任务技能目录和任务 MCP 配置会报能力不支持。每次 attempt 在 `agent/` 下保存脱敏的会话事件、轨迹和 stderr。

## 使用 AgentBundle

先按[源码安装](installation.zh-CN.md#直接安装)准备 Evaluator；pnpm 会自动安装 AgentBundle SDK，无需同级源码仓库。下面的 `AGENT_BUNDLE_PATH` 指向已制作好的 **Agent Bundle 目录**，需要另行准备，不是 SDK 安装路径。Bundle 的概念、CLI 和示例见 [AgentBundle 项目](https://github.com/evolving-foundry/agentbundle)，各 Harness 的目录结构、清单及校验方法见 [Bundle 编写指南](https://github.com/evolving-foundry/agentbundle/blob/master/docs/bundle-formats.zh-CN.md)。

```yaml
services:
  default:
    model: ${MODEL_NAME}
    base_url: ${MODEL_ENDPOINT}
    api_key: ${MODEL_API_KEY}
benchmark:
  name: gsm8k
  solver:
    name: agentbundle
    config:
      path: ${AGENT_BUNDLE_PATH}
environment: local
run:
  maxTasks: 2
  timeoutSeconds: 900
output:
  directory: ./results/gsm8k-agentbundle
```

`AGENT_BUNDLE_PATH` 建议使用绝对路径。Evaluator 会读取 Bundle 声明的 Harness，检查内容身份，再选择适配器，不通过目录名猜测。本地 Harness 还会检查固定版本是否满足声明范围；远程 Dify 的版本限制见下文。Bundle 修改后应开始新 run。

| Harness 声明 | 对应使用方式 |
| --- | --- |
| `dsh` | 按 DSH 协议准备与运行，工具输出格式见[DSH 说明](usage.zh-CN.md#dsh-工具输出) |
| `deepagents` **Beta** | 使用 deepagents / LangGraph 适配器 |
| `hermes` **Beta** | 使用 Hermes 适配器 |
| `jiuwenswarm` **Beta** | 使用 Jiuwenswarm 适配器 |
| `pi` **Beta** | 使用 pi，检查发布产物与设置摘要 |
| `dify` **Beta** | 通过 SDK 安装远程应用，再运行 Workflow，见下文 |

某些 Harness 需要本机预装运行时，或在 Docker 准备阶段安装依赖；本机目录不会自动变成容器/远端可用路径。先确认 Bundle 和 Harness 的部署条件，再按 [Playbook](../../playbook/README.md) 选对应环境。

已有安装位置可用 `dshhome`、`dshprofile`、`hermeshome`、`jiuwenswarmhome` 等 Solver 配置指定；`jiuwenswarmTimeoutSeconds` 只针对对应 Harness。pi 的额外设置放在 `benchmark.solver.config.pi.settings`，其他 Harness 不接受这个字段。

Docker 下，DSH 默认使用固定版本 0.2.2-rc.1。如果该版本不满足 Bundle 的 `harness.version`，Solver 从配置的 npm 源选择符合范围的最高版本。范围需要显式包含预发布版才能匹配 RC。Local 环境使用同一范围校验本机已安装的 DSH。

输出上限优先放在 `services.<名称>.maxTokens`。AgentBundle 也接受 Solver 的 `maxTokens`，但两处同时填写会报错，不要重复配置。Evaluator 的配置与执行方式见本页；Bundle 的制作、格式与安装见上述 AgentBundle 项目文档。

## Docker 环境准备与网络

Solver 决定 Agent 怎样执行；任务环境决定使用现成镜像还是构建 Dockerfile。选择 `simpleagent` 或 `agentbundle` 不会直接决定镜像下载方式。`warmup` 不调用模型，但会准备任务镜像、Evaluator 共享的 Node 运行环境，以及所选 Harness 需要的安装依赖；可用缓存会被复用。

同一次预热可能既有 Dockerfile 的 `FROM` 拉取，也有 Evaluator 主动获取 Node 等现成镜像。前者使用 Docker daemon/BuildKit 的网络；后者才使用网络文件中的 `docker.mirrors` 和 `docker.pull`。即使 `docker.pull.method: docker`，Evaluator 仍会先替换镜像地址，再交给 Docker 下载。镜像获取、构建中安装依赖和运行时安装使用的配置边界见[预热期间的镜像与依赖下载](deployment/network.zh-CN.md#预热期间的镜像与依赖下载)。

## 使用 Dify

Dify 是 AgentBundle 的 Harness。准备声明 `harness.name: dify` 的 Bundle，使用下面的文本题示例：

```yaml
services:
  default:
    model: dify-internal-binding
    base_url: http://127.0.0.1:9/v1
    api_key: ${MODEL_API_KEY}
benchmark:
  name: gsm8k
  solver:
    name: agentbundle
    config:
      path: ${DIFY_BUNDLE_PATH}
      dify:
        baseUrl: ${DIFY_BASE_URL}
        registryPath: ${DIFY_REGISTRY_PATH}  # 可选
environment: local
run:
  maxTasks: 2
  timeoutSeconds: 900
output:
  directory: ./results/gsm8k-dify
```

`path` 指向 Dify Bundle；`dify.baseUrl` 填服务地址，例如 `https://dify.example`，不要带 `/v1`、`/workflows/run`、认证信息、查询参数或片段。安装与执行都使用这个地址，不受 SDK 环境变量 `DIFY_BASE` 覆盖。Workflow 接收名为 `task` 的文本输入，返回文本字段 `report` 或 `answer`；其他输出对象保存为 JSON 文本。

在运行 Evaluator 的进程所在机器上配置 Console 凭证：`DIFY_ADMIN_API_KEY`，或 `DIFY_EMAIL` 与 `DIFY_PASSWORD`，也可使用 SDK 已保存的登录凭证。未配置时直接报错，不等待交互登录。SDK 安装并发布应用后返回 `appId` 和 Service API key，不需要额外配置应用 key。Ray 部署中这些 Console 凭证需在执行安装的节点预先配置，本机环境变量不会自动分发。

services 保留框架要求的服务元数据，上例中的 `MODEL_API_KEY` 仅用于满足服务绑定要求，不会发往占位地址；实际模型由 Dify 应用内部绑定。`services.<名称>.maxTokens` 和 Solver 的 `maxTokens` 不会修改 Dify 工作流里的模型参数。

`dify.registryPath` 是安装记录文件，相对路径按 YAML 所在目录解析。省略时放在 SDK 默认记录目录下的 `dify/<服务地址摘要>/installations.json`。同一台机器上共享记录文件的并发 attempt 使用文件锁，只创建一个应用；远端节点使用各自的记录文件，不保证跨节点只安装一次。显式记录文件包含其他服务的同一 Bundle 时会报错，需换用另一文件。记录文件含 Service API key，不要提交；评测结果中的 `installation.json` 只保存不含密钥的安装证据。应用按 persistent 模式保留，评测结束不删除远程应用。

来源记录保存 Bundle 摘要、Runner 摘要及版本、Bundle 声明的平台版本范围。目前不探测远程 Dify 平台实际版本，也不保证服务端工作流未被外部修改。旧 `solver.name: dify`、`bundlePath`、`apiKeyEnv` 和 `appId` 配置不再接受；请改用上面的 Bundle 写法并开始新 run，已有结果仍可离线生成报告。

**Dify Harness 当前不把工作流生成的文件同步回任务环境。** Office、代码仓库修改等文件交付任务应使用能写入 EnvironmentSession 的 SimpleAgent 或其他 AgentBundle Harness。[Office Dify YAML](../../playbook/workbuddy/workbuddy-office-dify.yaml) 仅展示配置组合。

## 用 AgentX 测服务性能

不需要先制作 AgentBundle。选择 `benchmark.name: agentx` 后，由专用 Solver 发送 Trace 请求；API 必须满足流式、`ignore_eos`、完整上下文与输出长度要求。

- `replay`：显式指定 `traceCount`，完整跑完有限 Trace，适合适配验收。
- `standard`：固定的标准测量窗口及负载规则。

vLLM `/metrics` 和 Ascend 采样端点是可选项，不配置时只测模型 API。`replay` 不能作为正式可比成绩，standard 也要通过上游和本地的有效性检查。完整参数、Python 条件及 NPU 采集方式见 [AgentX 指南](benchmarks/agentx.zh-CN.md)。

[返回用户手册](README.zh-CN.md) · [日常操作](usage.zh-CN.md) · [完整配置参考](config.zh-CN.md)
