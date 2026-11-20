# 分批问题清单

先完成 `benchmark list`、`benchmark info <name>` 和 `init`，把 Profile 已经确定的字段写成“已确认”，再只问下表中仍缺失或需要用户决策的项。每轮最多 5 个问题。

## 提问格式

每个问题包含四部分：标签、要决定什么、默认值/推荐值、一个短例子。

```text
1. [条件必填] 模型服务的 base_url 是什么？
   默认：使用已注册 provider 时可省略。
   例子：https://api.example.com/v1
2. [选填] 模型协议是什么？
   默认：openai-completions。可选：openai-responses、anthropic-messages、google-generative-ai。
```

判断规则：

- **必填**：缺失会导致配置校验失败，或无法确定要评测的对象（Benchmark、模型服务及模型 ID）。
- **条件必填**：只有所选 Benchmark 或场景需要时才必填，例如独立裁判服务、Hugging Face 受限数据认证。
- **选填**：Profile 或框架已有默认值，且用户不关心时可以直接采用。只有会显著改变成本、结果或执行位置的选填项，才在首次使用时确认一次。
- 用户回答“默认”“你决定”“不知道”时，采用默认值并在摘要中写明“按默认值”。
- 每个问题都必须能追溯到 `benchmark info` 的输出、Profile 字段或 CLI 的校验要求；无法追溯的问题不要问。
- 前序答案改变时，先标出受影响结论已失效，再重新询问受影响的问题，避免沿用旧答案。

## 第 1 轮：目标与 Benchmark

| 问题 | 标签 | 默认/推荐 | 说明与例子 |
| --- | --- | --- | --- |
| 要评哪个 Benchmark？ | 必填 | 从 `benchmark list` 推荐与用户目标最接近的项 | 例子：`gsm8k`、`terminalbench`、`workbuddy`。先展示可用名称，不要假设用户知道内部名称。展示名称可能与配置 ID 不同（例如展示 MATH-500，配置写 `math500`），写入 YAML 时一律使用 `benchmark list` 的原生 ID。 |
| 用哪个版本或场景？ | 选填 | 使用 Profile 的 `defaultVersion` / `defaultScenario` | 例子：`version: "4.0"`、`scenario: office`。版本号加引号。 |
| 关注哪个结果指标？ | 选填 | 使用 Profile 默认指标 | 例子：成功率、pass@1、延迟、显存占用。只有需要替换默认 `metrics` 时才追问。 |
| 先小样本还是全量？ | 选填 | 首次推荐小样本（2～10 题），正式评测默认全量 | 小样本用 `run.maxTasks`；确认链路后再切换全量。 |
| 是否更换 Solver？ | 选填 | 取 Profile 或框架默认 `simpleagent` | 先看 `benchmark info` 是否提供多个 Solver；需要时写 `benchmark.solver.name`，例如 `codex`。更换后通常还要在同一对象里用 `service` 绑定模型服务。 |

执行要点：

- 运行 `benchmark info <name>` 后，先告诉用户该 Benchmark 的默认版本、场景、数据来源、可选 Solver 和所需认证。
- 如果目标不存在，不要进入本轮的第 2 个问题；直接进入[回退流程](../SKILL.md#回退流程)。

## 第 2 轮：模型服务

| 问题 | 标签 | 默认/推荐 | 说明与例子 |
| --- | --- | --- | --- |
| 模型 ID 是什么？ | 必填 | 无 | 写在 `services.<service_name>.model`，默认服务名是 `default`，例如 `services.default.model`；自定义服务名按实际填写，如 `services.codex.model`。 |
| API base_url 是什么？ | 条件必填 | 使用已注册 provider 时可省略，走 provider 默认端点 | 自定义网关或自建服务时填写 `services.<service_name>.base_url`（默认服务名为 `default`），例如 `https://api.example.com/v1`。 |
| API key 用哪个环境变量？ | 条件必填（实际访问该服务时） | `MODEL_API_KEY` | 只收集变量名，不收集值。YAML 写 `api_key: ${MODEL_API_KEY}`。配置模式可保留占位符；预检或运行需要访问该服务前，再确认变量可用。 |
| 使用哪种协议？ | 选填 | `openai-completions` | 写入 `services.<name>.api`。可选：`openai-completions`、`openai-responses`、`anthropic-messages`、`google-generative-ai`。 |
| 是否使用已注册 provider？ | 选填 | 不设置 | 写入 `services.<name>.provider`。可选：`openai`、`anthropic`、`deepseek`、`azure-openai` 等。没有明确要求时不写。 |
| 服务名用 `default` 还是自定义名？ | 选填 | `default` | 自定义名时写 `services.<name>`，例如 `services.codex`。没有 `services.default` 且只有一个服务时，框架会自动选用它；存在多个可选服务时，必须用 `benchmark.solver.service`（以及 Verifier 对应字段）显式绑定。以 `inspect` 结果为准。 |
| 是否需要独立裁判模型？ | 条件必填 | 按 Benchmark Profile | 是否需要 Judge、绑定在哪个字段，完全由对应 Benchmark 的 Profile 决定，不得跨 Benchmark 套用。例如 SimpleQA / HealthBench / MATH-500 用 `benchmark.config.judgeService`，WorkBuddy 用 `benchmark.verifier.service`。`benchmark.verifier` 还必须提供已注册的 verifier `name`；只有 Profile 已提供 `name` 时才能只覆盖 `service`，否则 `inspect` 会报 `CONFIG_INVALID`。先读 Profile，再决定是否增加 `services.judge` 及绑定字段。 |
| 数据是否需要 HF_TOKEN？ | 条件必填 | 公开数据不需要 | GPQA、OfficeQA Pro V2 等受限数据需要先申请访问权限，再提供 `HF_TOKEN` 变量名；YAML 写 `benchmark.config.hfToken: ${HF_TOKEN}`。 |

执行要点：

- 用户可能只给一个 OpenAI 兼容网关；先按 `openai-completions` 处理，不要追问内部实现。
- 多服务且没有 `services.default` 时，必须确认 Solver 绑定哪个服务；否则校验会失败。
- 只有一个服务但没有 `services.default` 时，框架会把该服务作为默认服务，不必额外写 `benchmark.solver.service`；存在多个服务时才需要显式绑定。
- 自定义网关的模型 ID 按用户给出的原样接收，可在预检阶段用 `GET <base_url>/models` 核对；接口不可用时标记为“无法验证”。不在返回列表里时，把相近的可用 ID 列给用户选择，不要自行推测或删改版本后缀。
- 永远不要在对话、YAML、命令或日志中写入密钥值。最终摘要只列变量名。

## 第 3 轮：执行环境与并发

| 问题 | 标签 | 默认/推荐 | 说明与例子 |
| --- | --- | --- | --- |
| 任务在哪里运行？ | 选填 | `docker`（框架默认） | `local` 适合无隔离需求的轻量任务；`docker` 适合需要固定镜像或隔离的任务。 |
| Docker 平台是什么？ | 选填 | `auto` | `linux/amd64` 或 `linux/arm64`。Terminal-Bench 4.0 官方镜像通常需要 amd64；ARM 主机需要 QEMU/binfmt。 |
| 使用哪个调度器？ | 选填 | `local` | 只有用户已有 Ray 或明确要分布式时才选 `ray`；Ray 需要额外连接配置。 |
| 执行并发是多少？ | 选填 | `1` | 首次使用保持 1；确认单题链路后再提高。并发受 CPU、内存、Docker、模型服务限流和磁盘影响。 |
| 准备模式或准备并发？ | 选填 | Local 默认 `pipeline`，准备并发跟随执行并发 | 需要整批准备后统一执行时用 `batch`；需要单独限制下载/构建并发时设置 `run.preparation.concurrency`。 |
| 准备阶段需要放宽时限吗？ | 选填 | 跟随任务声明或 Benchmark 默认值 | 镜像大或依赖下载慢时设置 `run.preparation.environmentTimeoutSeconds` 和 `run.preparation.roundTimeoutSeconds`（秒），例如都设 `1800`；环境时限会按准备并发放宽，倍率最多 10。 |
| 超时怎么设置？ | 选填 | 框架默认整题 `7200` 秒；Profile 有声明时以 Profile 为准 | 可补充 `run.solveTimeoutSeconds`、`run.verifyTimeoutSeconds`；只有用户明确要求时写入。 |

执行要点：

- 不要在未确认宿主机资源时承诺“安全并发”；并发是上限，不是自动容量规划。
- 小样本验证阶段保持低并发；正式运行前再按准备开销和模型限流复核。
- 使用 Ray 时，先确认连接方式、节点数和认证变量，再写入 `deployment` 和 `scheduler`。

## 第 4 轮：选题、预算与输出

| 问题 | 标签 | 默认/推荐 | 说明与例子 |
| --- | --- | --- | --- |
| 只跑部分题目吗？ | 选填 | 全量 | `run.taskIds` 指定 ID；`run.offset` 跳过前 N 题；`run.maxTasks` 限制题数。 |
| 需要可复现的随机抽样吗？ | 选填 | 不设置 | 写入 `run.sampling: { strategy: random, seed: 42 }`。 |
| 结果写到哪里？ | 选填 | Evaluator 根目录的 `results/<benchmark>/<yaml 名>/<runId>/` | 显式 `output.directory` 覆盖；显式相对路径以 YAML 所在目录为基准。 |
| 单题失败后继续吗？ | 选填 | `continue` | 需要失败即停时设置 `run.onError: abort`。 |
| 本次预算上限是多少？ | 选填 | 无显式上限 | 用 `maxTasks`、超时和模型服务限额表达；无法估算时标为“未验证”，并建议先小样本。 |

执行要点：

- 不确定任务 ID 时，先运行 `arsi-evaluator run <yaml> --dry-run` 枚举；它只输出 `taskIds`，不打印输出目录，也不校验路径，且可能下载数据。输出路径以 `inspect` 的结果为准。
- 改选题或并发后需要新建 run；不要把不同范围的运行当成同一次续跑。
- 用户只关心“跑通”时，优先建议 `maxTasks: 2` 的小样本，再决定是否全量。

## 不要问的字段

以下字段有默认值或由 Profile 管理，除非用户明确提出需求，否则不要逐项追问：

- `store`、`reporter`、`metrics` 的实现细节。
- Profile 已提供的 Benchmark 数据来源、版本、场景、验证器和默认预算。
- 内部执行参数、缓存路径、容器工作目录、日志级别。
- Ray 的集群内部细节；只有用户选择 Ray 时才确认连接和节点。
- 任何密钥、token、代理密码的真实值。

## 访谈结束前的自检

- [ ] 所有 `[必填]` 和 `[条件必填]` 都已有答案。
- [ ] 每个 `[选填]` 要么有用户选择，要么明确采用默认值。
- [ ] YAML 中的认证字段全部是 `${ENV_NAME}` 引用。
- [ ] 选题范围和预算已复述给用户。
- [ ] 已向用户说明下一步操作符合所选模式：配置模式执行 `inspect`；预检模式和运行模式执行 `inspect`、`doctor`，并说明 doctor 可能产生下载探针和 Docker 可用性检查。
