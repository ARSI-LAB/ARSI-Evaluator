# 常见问题 FAQ

> [English](./README.md) | 中文

按实际遇到的问题选择入口。完整配置、执行政策和评分定义分别在对应指南中维护。

[用户文档](../README.zh-CN.md) · [下载与镜像 FAQ](downloads.zh-CN.md) · [Docker FAQ](docker.zh-CN.md)

## 安装与配置

### 为什么使用 SimpleAgent 也会安装 AgentBundle？

Evaluator 导入内置插件时需要 AgentBundle SDK，因此 pnpm 会自动下载并构建它，即使本次选择 SimpleAgent。无需手动克隆 AgentBundle，但安装机器需要 GitHub 私仓的读取权限。这与待评测的 `AGENT_BUNDLE_PATH` 不同。完整命令见[安装指南](../installation.zh-CN.md#直接安装)。

### 为什么换到另一个目录后找不到命令或配置？

先[注册全局 CLI](../installation.zh-CN.md#安装全局命令)，并确认在同一个 Linux、WSL 或 Windows 环境中运行。跨目录时传入 YAML 的绝对路径；配置内部相对路径仍以 YAML 所在目录为基准，`--patch` 则以当前工作目录为基准，见[任意目录运行](../installation.zh-CN.md#在任意目录运行)。

### doctor 通过后，为什么正式运行仍可能失败？

`doctor` 不发送模型请求、不下载数据、不构建镜像，`not-checked` 也不是通过。`run --dry-run` 可以锁定来源并枚举任务，但仍不证明模型调用和任务执行成功；先限制样本实际运行，见[快速上手](../quick-start.zh-CN.md#4-先检查再运行)。

## 下载、容器与资源

### HF、GitHub、pip 或镜像下载失败怎么处理？

先根据日志区分数据源、任务镜像、Solver 运行时和裁判镜像。它们不一定使用同一下载源。访问权限、代理、软件源和缓存的检查方法见[下载 FAQ](downloads.zh-CN.md)；有明确网络证据的任务可按[网络故障补测](../network-retry.zh-CN.md)恢复。

### 为什么准备很久还没有开始做题？

整批模式会先准备所选任务的镜像与运行时，再启动 attempt。首次下载和冷构建可能较慢；查看 `[prepare]` 日志和准备轮次，而不是直接延长 Agent 解题时限。预算和本地流水线见[并发与环境准备](../concurrency.zh-CN.md)。

### 中断后重跑会重新下载或构建全部镜像吗？

镜像复用条件、可能重新构建的原因，以及普通运行与 `--resume` 的区别，见 [Docker FAQ](docker.zh-CN.md#中断后重跑会重新下载或构建全部镜像吗)。

### 如何区分每题的解题、验证和共享镜像？

镜像名称显示任务短名、`solve`／`verify` 用途和镜像种类；完整命名表、按任务查看命令及旧标签升级行为见 [Docker 镜像命名](docker.zh-CN.md#如何按任务区分和查看镜像)。

### amd64 模拟崩溃、CPU 数量异常或容器清理失败怎么办？

见 [Docker FAQ](docker.zh-CN.md)，其中分别说明平台检测、Go/esbuild 兼容、公开代码缓存预热、CPU 预算、证据权限和清理结果。模拟可运行不等于与原生机器性能相同。

## Agent 与模型

### 模型回复截断（SOLVER_OUTPUT_LIMIT）

模型返回 `stopReason=length` 表示响应被长度限制截断。推理模型可能在输出正文或工具调用前耗尽额度。若错误显示 `provider-default`，检查服务端回复与上下文限制；若显式设置了 `maxTokens`，检查是否能在服务支持范围内调大。

显式 `base_url` 的 OpenAI Chat Completions 服务在省略 `maxTokens` 时，SimpleAgent 和内置 Judge 不发送客户端输出上限。普通输出截断不触发上下文压缩；其他 Provider 和外部 Harness 使用各自的配置机制，见[模型服务](../solvers.zh-CN.md#模型服务与独立裁判)。

### DSH 事件显示 truncated，是否代表工具失败？

不一定。DSH 大工具输出会保存完整文件，事件只保留预览；按 `resultRef` 查看对应文件，并核对状态和文件清单。字段含义见[DSH 工具输出](../usage.zh-CN.md#dsh-工具输出)。这与模型回复 token 截断是不同情况。

### Dify 能否用于 Office 或代码文件交付？

当前 Dify Solver 返回文本，不将工作流文件同步到任务环境。需要交付文件的任务应使用 SimpleAgent 或具备文件操作能力的 AgentBundle，见[Dify 条件](../solvers.zh-CN.md#使用-dify)。

## Benchmark 与评分

### WorkBuddy Office 一定需要模型裁判吗？

不需要，Office 默认使用规则评分，绑定 judge 后才启用模型 rubric；Web 则需要模型裁判，视觉检查还需要图片输入能力。四种场景的评分和关闭 judge 的方法见[WorkBuddy 指南](../benchmarks/workbuddy.zh-CN.md#workbuddy-的上游-compositeverifier)。

### 为什么 Security 不支持在 Windows 目录解压？

Security 任务包含安全样本，使用 Linux 或 WSL 的原生文件系统保存 YAML、缓存和输出；不要解压到 `/mnt/c`、`/mnt/d`。任务范围与执行条件见[Security 说明](../benchmarks/workbuddy.zh-CN.md#sec-与-windows--wsl)。

### 为什么 AgentX replay 不是正式成绩？

replay 完整执行有限 Trace，包含冷启动、等待和排空，与正式 standard 的采样和一小时测量窗口不同，不能当作正式标准成绩。AgentX 不产生质量分数，具体可比条件见[AgentX 指南](../benchmarks/agentx.zh-CN.md)。

### 执行成功、零分、无效和清理失败有什么区别？

命令成功退出表示流程完成，不表示模型答对。查看 `executionStatus`、`scoreStatus` 和 `cleanupStatus`，不要只看错误文本或进程退出码。合法零分、Agent 超时、基础设施失败和缺失评分的处理见[评分说明](../reference/scoring.zh-CN.md)和[错误码](../reference/errors.zh-CN.md)。

### 为什么修改配置后不能续跑原 run？

续跑要求来源、选题、模型配置、代码和插件版本匹配，以免把不同实验条件的结果混在一起。更换题数、并发、准备方式或模型后应新建 run；原结果保留后仍可离线报告，见[续跑说明](../usage.zh-CN.md#续跑与重建报告)。

## 调试日志

错误会直接显示阶段、任务、原因和建议；完整结构化诊断保存在 attempt 的 `result.json`，准备阶段诊断保存在 `manifest.json`。需要额外细节时，在仓库根目录执行：

```bash
EVALUATOR_DEBUG=1 node dist/cli.js run playbook/gsm8k/gsm8k-simpleagent.yaml
```

`1` / `true` 开启，未设置或 `0` / `false` 关闭。PowerShell 使用 `$env:EVALUATOR_DEBUG="1"`。进度与错误写入 stderr，最终结果路径写入 stdout；错误分类和恢复策略见[错误码参考](../reference/errors.zh-CN.md)。
