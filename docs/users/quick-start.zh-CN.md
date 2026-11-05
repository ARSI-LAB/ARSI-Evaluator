# 快速上手：先跑两道题

> [English](./quick-start.md) | 中文

目标：用你的模型 API 跑两道 GSM8K 数学题，得到一份可离线查看的报告。下文运行命令在 Evaluator 仓库根目录执行。

## 1. 安装和构建

先完成[安装指南](installation.zh-CN.md#直接安装)。下面的 local 示例不需要 Docker 或 Ray，Agent 会在本机执行工具。

后文使用安装时注册的 `ember-evaluator` 命令；请在同一工作目录依次执行，便于使用生成的配置和结果路径。

## 2. 选择题库并生成配置

```bash
ember-evaluator benchmark list
ember-evaluator benchmark info gsm8k
ember-evaluator init --benchmark gsm8k --output first-run.yaml
```

`list` 列出可用名称，`info` 显示默认组合，`init` 生成配置文件。文件已存在时 `init` 会报错，不会覆盖它。

打开 `first-run.yaml`，将内容改为下面这份完整配置：

```yaml
services:
  default:
    model: ${MODEL_NAME}
    base_url: ${MODEL_ENDPOINT}
    api_key: ${MODEL_API_KEY}

benchmark: gsm8k
environment: local
scheduler:
  concurrency: 1
run:
  maxTasks: 2
  timeoutSeconds: 300
output:
  directory: ./results/first-run
```

这里选了 GSM8K、默认 SimpleAgent、本机执行、一次一题、总共两题。`timeoutSeconds` 是每题总预算；首次安装运行时、读取数据也会花时间，因此首次运行通常比模型回答本身更久。

**不要省略示例中的 `environment: local`。** 框架通用默认值是 Docker，`init gsm8k` 本身不会把环境改成本地。

## 3. 设置模型变量

使用支持 OpenAI Chat Completions 和工具调用的模型服务。`MODEL_NAME` 填服务实际接受的模型 ID，`MODEL_ENDPOINT` 填服务 base URL，例如以 `/v1` 结尾的地址，不要在这里填写网页聊天地址。

Linux、WSL 或 macOS 的 Bash：

```bash
export MODEL_NAME="your-model-id"
export MODEL_ENDPOINT="https://your-model-service.example/v1"
read -rsp '模型 API key: ' MODEL_API_KEY
printf '\n'
export MODEL_API_KEY
```

Windows PowerShell：

```powershell
$env:MODEL_NAME = "your-model-id"
$env:MODEL_ENDPOINT = "https://your-model-service.example/v1"
$modelKey = Read-Host "模型 API key" -AsSecureString
$env:MODEL_API_KEY = [System.Net.NetworkCredential]::new("", $modelKey).Password
```

把示例模型名和地址换成自己的值，API key 在交互提示中输入。YAML 中保留 `${MODEL_API_KEY}`，不要替换成真实密钥。环境变量只作用于当前终端及其子进程；在 WSL 运行时要在 WSL 中设置。

未设置 `maxTokens` 时，显式 Chat Completions 服务的 SimpleAgent 不发送客户端回复上限，由服务端决定。服务仍可能因自身输出或上下文限制截断，详见[模型配置](solvers.zh-CN.md#模型服务与独立裁判)。

## 4. 先检查，再运行

```bash
ember-evaluator doctor first-run.yaml
ember-evaluator run first-run.yaml
```

`doctor` 会检查配置、认证引用、工具和网络，执行临时下载及 Docker 构建探针，不发送模型请求、不执行题目。`not-checked` 表示没有检查，不表示检查通过；模型与数据源权限需要实际运行确认。

`run` 才会读取数据并调用模型。日志会显示准备、求解、验证、报告等阶段；结束后输出类似下面的目录，实际 `<RUN_ID>` 是本次生成的值：

```text
results/first-run/<RUN_ID>
```

运行中“停在准备阶段”不一定是卡住：首次需要读取数据、安装依赖；Docker 题目还可能拉取或构建镜像。先看最新阶段和错误，再决定是否重试。

## 5. 打开报告

打开上一步目录中的 `report.md`。其中 `metrics.json` 是同一份统计的 JSON，`tasks/` 保存各题尝试和证据。

以后需要重新生成报告时：

```bash
ember-evaluator report results/first-run/<RUN_ID>
```

把 `<RUN_ID>` 换成实际目录名。离线报告不需要模型 key，不会再次发题；保持结果目录完整，不要只复制一个 `result.json`。

对这次质量评测，先看三件事：是否运行完整、两题得分/正确性如何、是否有错误或证据缺失。**命令成功退出不代表模型两题都答对。**

## 6. 中断后怎么办

保持实验配置不变，使用同一份 YAML：

```bash
ember-evaluator run first-run.yaml --resume
```

也可用 `--resume <RUN_ID>` 明确指定。续跑跳过已有有效结果，未完成或无效任务会新建 attempt，不是从对话的某一轮继续。Evaluator 代码允许更新并重新构建后续跑；改了模型、题目、并发等配置后应开始新 run。配置、来源、外部插件和 Solver 身份检查仍然有效，详见[续跑说明](usage.zh-CN.md#续跑与重建报告)。

## 下一步

- [日常操作](usage.zh-CN.md)：抽题、并发、超时、结果文件、错误和 CLI 命令。
- [选择 Solver 和模型服务](solvers.zh-CN.md)：AgentBundle、独立 Judge、Dify 和 AgentX。
- [Terminal-Bench 4.0 入门](quick-start/terminalbench.zh-CN.md)：用现有 YAML 运行 Docker 终端任务；更多 Office、Code、Web、Security、DeepSWE 场景见 [Harbor 指南](benchmarks/harbor.zh-CN.md)。
- [AgentX 性能入门](quick-start/agentx.zh-CN.md)：配置长上下文模型服务、tokenizer 和指标采集，执行配置检查后开始正式测评。
- [返回用户手册](README.zh-CN.md)：查看所有功能和专项指南。
