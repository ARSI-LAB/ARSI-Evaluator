<h1 align="center">
  <img src="imgs/ember-evaluator-logo.png" alt="Ember Evaluator" width="520">
</h1>

<h3 align="center">多种评测方法，一个框架统一承载。</h3>

<p align="center">
  融合 Benchmark、Agent 能力评测与性能测试，覆盖代码、终端、办公、网页等多种场景，统一配置与执行。
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Node.js-24.x-339933?logo=nodedotjs&amp;logoColor=white" alt="Node.js 24.x">
  <img src="https://img.shields.io/badge/pnpm-11.22.0-F69220?logo=pnpm&amp;logoColor=white" alt="pnpm 11.22.0">
  <img src="https://img.shields.io/badge/License-Apache--2.0-blue" alt="License: Apache-2.0">
</p>

<p align="center">
  <a href="./README.md">English</a> | 中文
</p>

<p align="center">
  <a href="docs/users/quick-start.zh-CN.md">快速开始</a> ·
  <a href="docs/users/README.zh-CN.md">使用文档</a> ·
  <a href="playbook/README.md">实验配置</a> ·
  <a href="docs/development/plugins.md">插件开发</a>
</p>

## ℹ️ 简介

ember-evaluator 用一份 YAML 配置模型、Agent、Benchmark 和执行环境，完成任务执行、答案验证、结果保存和报告生成，帮助你在相同实验条件下比较不同模型与 Agent。

项目支持数学与知识问答、代码修改、终端操作、办公、网页和安全任务；也支持使用 AgentX 回放 Trace，测量模型服务的吞吐与延迟。

![Evaluator 从 YAML 配置到任务执行、验证、结果保存和报告生成的整体架构](imgs/01-framework-project-overview-v2.png.png)

模型与 Agent 负责求解，Benchmark 负责验证，Store 保存结果和证据。各模块的职责、调用流程和源码入口见 `src/` 目录。

## ⚙️ 功能介绍

- **多种评测任务**：支持 GSM8K、MMLU、HumanEval、Terminal-Bench、SWE-bench、WorkBuddy、[OfficeQA Pro V2](docs/users/benchmarks/officeqa-pro-v2.zh-CN.md)（默认解析 JSON，也支持原始 PDF）和自有 Harbor 任务，见[支持的 Benchmark](docs/users/README.zh-CN.md#现在能测哪些-benchmark)。
- **多种 Agent 与模型服务**：支持 SimpleAgent 和 AgentBundle（含 Dify Harness），可配置独立裁判模型，见[Solver 与模型服务](docs/users/solvers.zh-CN.md)。
- **本机、容器与分布式执行**：使用 local 或 Docker 执行任务，通过本地 Scheduler 或 Ray 调度，并控制并发和环境准备，见[运行方式](docs/users/usage.zh-CN.md#本地docker-与-ray)和[并发指南](docs/users/concurrency.zh-CN.md)。
- **证据保存与任务续跑**：保存配置、来源版本、轨迹、验证日志和产物，中断后继续未完成任务，见[续跑与结果文件](docs/users/usage.zh-CN.md#续跑与重建报告)。
- **指标与离线报告**：统计得分、正确率、耗时和 token usage，从已保存结果重建 Markdown 报告，见[结果阅读](docs/users/usage.zh-CN.md#如何读结果)和[评分口径](docs/users/reference/scoring.zh-CN.md)。
- **模型服务性能测量**：用 AgentX 测量吞吐、TTFT、ITL 和请求延迟，可选采集 vLLM 与 Ascend NPU 指标，见[AgentX 指南](docs/users/benchmarks/agentx.zh-CN.md)。
- **插件扩展**：可替换或新增 Benchmark、Verifier、Solver、Environment 等八类组件，见[插件开发与加载](docs/development/plugins.md)。
- **Node.js SDK**：在业务项目中通过 `Evaluator.run()` 执行评测，支持进度、取消、续跑和 Ray Jobs，见[SDK 指南](docs/users/sdk.zh-CN.md)。

## 📦 安装部署

需要 **Node.js 24.22.1 或更新的 24.x、pnpm 11 或 12、Git**，以及 AgentBundle GitHub 私仓的读取权限。没有 pnpm 时，先执行 `npm install --global pnpm`。

在 Evaluator 仓库根目录执行：

```bash
pnpm install --frozen-lockfile
pnpm add -g .
ember-evaluator --help
```

看到帮助信息即安装成功。详细步骤见[安装指南](docs/users/installation.zh-CN.md)，Linux 服务器也可使用[管理容器](docs/users/deployment/container-toolbox.zh-CN.md)。

## 🚀 快速入门

下面使用 SimpleAgent 在本机运行两道 GSM8K 数学题，无需 Docker。将模型名、API 地址和密钥替换为自己的值，在仓库根目录执行（Bash）：

```bash
export MODEL_NAME="your-model-id"
export MODEL_ENDPOINT="https://your-model-service.example/v1"
export MODEL_API_KEY="your-api-key"

ember-evaluator run playbook/gsm8k/gsm8k-quick-start.yaml
```

模型服务需支持 OpenAI Chat Completions 和工具调用。运行结束后，打开日志所示结果目录中的 `report.md`。PowerShell 用法及更多说明见[两题快速上手](docs/users/quick-start.zh-CN.md)。

| 评测目标 | Benchmark / 场景 | 执行环境 | 额外条件 | 快速入门 |
| --- | --- | --- | --- | --- |
| 跑通模型与报告链路 | GSM8K，两道题 | local | 支持工具调用的模型 API | [两题快速上手](docs/users/quick-start.zh-CN.md) |
| 评测终端操作能力 | Terminal-Bench 4.0 | Docker | amd64 镜像；ARM64 需 QEMU/binfmt | [Terminal-Bench 4.0 入门](docs/users/quick-start/terminalbench.zh-CN.md) |
| 模型服务标准性能测评 | AgentX standard | local，可选管理容器 | Python 3.11–3.13、venv、tokenizer、长上下文流式模型服务；管理镜像已提供 Python | [AgentX 性能入门](docs/users/quick-start/agentx.zh-CN.md) |

其他题库和运行组合见 [Playbook 示例](playbook/README.md)，续跑、报告和日常操作见[用户文档](docs/users/README.zh-CN.md)。

## 🛰️ Tracer：轨迹展示、优化反馈与运维

仓库内置的 `tracer` 插件会把每次 attempt 实时推送到本地 Collector：一个轻量 HTTP 服务，用于展示 Agent 轨迹与性能指标，产出确定性反馈（可选 LLM 归因），并导出文件供下游 RSI 使用。配置的 Store 始终是权威数据源，推送失败只产生告警，不会中断评测。

按需为单次运行开启，插件会自动拉起 Collector：

```bash
ember run playbook/gsm8k/gsm8k-quick-start.yaml --tracer
```

插件是独立包，首次使用前需要单独构建（仓库根构建不包含它）：

```bash
pnpm --dir plugins/tracer install --ignore-workspace --ignore-scripts
pnpm --dir plugins/tracer build
```

Collector 是 Python 服务，需要一个能 `import fastapi, uvicorn` 的解释器（Python 3.9+），首次使用前装一次依赖：

```bash
python3 -m pip install fastapi uvicorn
```

插件启动时会自动选择解释器：当前激活的 virtualenv/conda 环境 → `python3`/`python` → `python3.13`…`python3.9`，取第一个满足依赖的。只有自动探测选错时，才需要 `TRACER_PYTHON=/path/to/python` 指定。Collector 以子进程启动，环境变量在启动那一刻继承，改动后先 `ember tracer stop` 再 `ember tracer serve`。

用四个子命令管理 Collector：

| 命令 | 作用 |
| --- | --- |
| `ember tracer serve [--url <url>] [--db <path>] [--spool <path>] [--port <n>] [--timeout <ms>]` | 启动 Collector，或复用已健康的实例；在数据库同级写入 `tracer.pid` |
| `ember tracer status [--url <url>] [--db <path>] [--port <n>]` | 输出 JSON 状态；不健康时以非零码退出 |
| `ember tracer logs [--log <path>] [--lines <n>] [--follow]` | 输出 `collector.log` 末尾内容，可跟随新增日志 |
| `ember tracer stop [--url <url>] [--db <path>] [--port <n>]` | 按 `tracer.pid` 停止进程（先 SIGTERM，5 秒后升级为 SIGKILL） |

默认值为 `http://127.0.0.1:8787`、`plugins/tracer/trace.db`、`plugins/tracer/spool`、`plugins/tracer/collector.log`，可用 `TRACER_URL`、`TRACER_DB`、`TRACER_SPOOL`、`TRACER_COLLECTOR`、`TRACER_PYTHON`、`TRACER_TOKEN` 覆盖。

LLM 分析是可选能力；未配置 provider 时 Collector 只走确定性规则，反馈页的 LLM 区块会标记为未配置。要启用，准备一个 OpenAI 兼容的 `/chat/completions` 服务：

```bash
export TRACER_LLM_BASE_URL="https://your-model-service.example/v1"
export TRACER_LLM_MODEL="your-model-id"
export TRACER_LLM_API_KEY="your-api-key"
ember tracer serve
```

`TRACER_LLM_BASE_URL`、`TRACER_LLM_MODEL`、`TRACER_LLM_API_KEY` 会分别回退到 `MODEL_ENDPOINT`、`MODEL_NAME`、`MODEL_API_KEY`。`TRACER_LLM_TIMEOUT` 默认 120 秒，`TRACER_LLM_MAX_TOKENS` 默认 8000（推理模型需要更大预算）。这些变量在 Collector 启动时读取，所以要在 `ember tracer serve` 之前设置，或者改完后重启 Collector。

## 📖 使用指南

按操作目标阅读对应文档：

- **配置实验**：[YAML、Profile 与环境变量](docs/users/config.zh-CN.md)；[Solver、AgentBundle 与独立 Judge](docs/users/solvers.zh-CN.md)。
- **运行不同任务**：[Benchmark 场景指南](docs/users/benchmarks/README.zh-CN.md)；[各 Benchmark 的实验配置](playbook/README.md)。
- **管理评测过程**：[选题、续跑与报告](docs/users/usage.zh-CN.md)；[只预热镜像](docs/users/usage.zh-CN.md#只预热镜像不开始测评)；[删除评测镜像](docs/users/usage.zh-CN.md#删除评测镜像)；[并发、准备流水线与超时](docs/users/concurrency.zh-CN.md)。
- **测量服务性能**：[AgentX 并发扫描、Trace 回放与指标采集](docs/users/benchmarks/agentx.zh-CN.md)。
- **扩展项目**：[插件开发与加载](docs/development/plugins.md)；接入数据集见 [Benchmark 评测要求与验收指南](docs/development/benchmark-evaluation-requirements.md)，编写 Benchmark 插件见 [Benchmark 开发指南](docs/development/benchmarks.md)。
- **排查问题**：[下载、日志与模型截断](docs/users/faq/README.zh-CN.md)；[错误码](docs/users/reference/errors.zh-CN.md)；[网络失败补测](docs/users/network-retry.zh-CN.md)。

全部指南、Benchmark 列表和运行限制见[用户文档目录](docs/users/README.zh-CN.md)。

## 📊 评测结果

以下成绩按模型与 Agent Harness 组合记录，空白单元格表示暂未发布成绩；比较时需同时核对文档输入、题目范围和评分条件。

| 模型＋Agent Harness | GSM8K | MMLU | WorkBuddy | Terminal-Bench 4.0 | SWE-bench Verified | OfficeQA Pro V2 |
| --- | --- | --- | --- | --- | --- | --- |
| DeepSeek V4.1 Flash 1017＋SimpleAgent | 92.34%（1218/1319） |  | 0.8502(Office)，0.9009(Code)，0.7957(Web) |  |  | 56.67%（51/90） |
| DeepSeek V4.1 Flash 1017＋choice-logprobs |  | 88.83%（12,474/14,042） |  |  |  |  |

