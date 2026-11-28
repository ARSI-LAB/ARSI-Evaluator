# 分批问题清单

先完成 `benchmark list`、`benchmark info <name>` 和 `init`，把 Profile 已经确定的字段写成“已确认”，再只问下表中仍缺失或需要用户决策的项。访谈分三轮：三项必选 → 可选项开关 →（仅开关选择“需要配置”时）关键可选项。每轮最多 5 个问题。

## 提问格式

问句使用简洁、规范的书面语，一句话说明需要用户决定的事项。标签仅出现在 header，默认值、示例与限制条件写在选项描述中；每轮在正文最多给一次命令提示。

```text
问：选择要评估的 Benchmark。
选项：gsm8k（轻量数学推理）／terminalbench（终端任务）／workbuddy（办公任务）／其他
提示：可运行 arsi-evaluator benchmark list 查看全部候选。

问：Harness 采用默认配置，还是指定其他实现？
选项：使用默认（推荐）／指定其他实现
```

表达规范：

- 使用书面语与准确术语，不使用口语化表达（如“跑几道题”“同时跑几个”“都按默认”）。
- 不将标签、命令或“默认：无，必须由你提供”等模板句写入问句。
- 每个必选问题给出“比如 <名称>”的示例，并说明可用哪个命令查询更多信息。
- 字段名可以出现，但需附中文说明，例如“运行任务数量（`run.maxTasks`）”。

判断规则：

- **必选**：缺失会导致配置校验失败，或无法确定要评测的对象（Benchmark、Harness、模型服务及模型 ID）。
- **条件必填**：只有所选 Benchmark 或场景需要时才必填，例如独立裁判服务、Hugging Face 受限数据认证、AISBench 的 SSH 凭据。
- **可选**：Profile 或框架已有默认值；用户选择“采用默认值”时全部保留默认。
- 用户回答“默认”“你决定”“不知道”时，采用默认值并在摘要中写明“按默认值”。
- 每个问题都必须能追溯到 `benchmark info` 的输出、Profile 字段或 CLI 的校验要求；无法追溯的问题不要问。
- 前序答案改变时，先标出受影响结论已失效，再重新询问受影响的问题，避免沿用旧答案。

## 第 1 轮：三项必选（一次问完）

| 问题 | 标签 | 默认/推荐 | 说明与示例 |
| --- | --- | --- | --- |
| 选择要评估的 Benchmark。 | 必选 | 从 `benchmark list` 推荐与用户目标最接近的项 | 比如 `gsm8k`、`terminalbench`、`workbuddy`。展示名称可能与配置 ID 不同（例如展示 MATH-500，配置写 `math500`），写入 YAML 时一律使用原生 ID。更多候选通过 `arsi-evaluator benchmark list` 查询，细节通过 `benchmark info <name>` 查询。 |
| Harness 采用默认配置，还是指定其他实现？ | 必选 | 取 Profile 或框架默认 `simpleagent` | 先看 `benchmark info` 是否提供多个 Harness；指定时写 `benchmark.solver.name`，例如 `codex`，并通常在同一对象里用 `service` 绑定模型服务。更换后要说明它是否支持所选场景（例如 WorkBuddy 的 Dify Harness 目前只返回文本，无法交付文件）。 |
| 配置模型服务：模型名称与 API 地址。 | 必选 | `init` 生成的 `MODEL_NAME` / `MODEL_ENDPOINT` / `MODEL_API_KEY` | 模型名称写在 `services.<service_name>.model`，默认服务名 `default`。`base_url` 必须是非空字符串，设置 `provider` 也不能省略，例如 `https://api.example.com/v1`。密钥只收集变量名，不收集值。协议默认 `openai-completions`。 |

执行要点：

- 三项必选在同一轮完成，不拆分为多轮重复追问。
- 条件必填项随所属必选项一并询问，不单独发起一轮：
  - 独立裁判：是否需要 Judge、绑定在哪个字段，完全由对应 Benchmark 的 Profile 决定，不得跨 Benchmark 套用。例如 SimpleQA / HealthBench / MATH-500 用 `benchmark.config.judgeService`，WorkBuddy 用 `benchmark.verifier.service`。`benchmark.verifier` 还必须提供已注册的 verifier `name`；只有 Profile 已提供 `name` 时才能只覆盖 `service`，否则 `inspect` 会报 `CONFIG_INVALID`。
  - 受限数据：GPQA、OfficeQA Pro V2 等需要先申请访问权限，再提供 `HF_TOKEN` 变量名；在 `with.benchmark.config` 中写 `hfToken: {credential: HF_TOKEN}`。
  - AISBench：需要远端 SSH 凭据时，只收集环境变量名，不收集密码。
- 版本与场景默认使用 Profile 的 `defaultVersion` / `defaultScenario`，用户主动要求时才修改；版本号加引号，例如 `version: "4.0"`。
- 用户可能只给一个 OpenAI 兼容网关；先按 `openai-completions` 处理，不要追问内部实现。
- 多服务且没有 `services.default` 时，必须确认 Harness 绑定哪个服务；只有一个服务时框架会自动选用，不必额外绑定。
- 自定义网关的模型 ID 按用户给出的原样接收，可在预检阶段用 `GET <base_url>/models` 核对；接口不可用时标记为“无法验证”。不在返回列表里时，把相近的可用 ID 列给用户选择，不要自行推测或删改版本后缀。
- 永远不要在对话、YAML、命令或日志中写入密钥值。最终摘要只列变量名。
- 如果目标 Benchmark 不存在，不要继续提问；直接进入[回退流程](../SKILL.md#回退流程)。

## 第 2 轮：可选项开关

| 问题 | 标签 | 默认/推荐 | 说明与示例 |
| --- | --- | --- | --- |
| 是否配置可选项（运行任务数量、并发度、执行环境等）？ | 可选 | 采用默认值 | 选项为“采用默认值（推荐）/需要配置”。选择采用默认值后直接生成 YAML，不再询问其他项。 |

执行要点：

- 该问题必须询问一次，不得跳过直接询问任务数量或并发度。
- 选择“采用默认值”时整轮结束访谈，包括不询问“是否还有其他默认项需要修改”，并在最终摘要注明“可选项均采用默认值”。

## 第 3 轮：关键可选项（仅当第 2 轮选择“需要配置”时）

| 问题 | 标签 | 默认/推荐 | 说明与示例 |
| --- | --- | --- | --- |
| 运行任务数量。 | 可选 | 全量；首次建议 2～10 条 | 写入 `run.maxTasks`；指定 ID 用 `run.taskIds`，跳过前 N 题用 `run.offset`；需要可复现抽样时写 `run.sampling: { strategy: random, seed: 42 }`。AISBench 的一次运行对应一个测量点（默认 160 条请求）。 |
| 并发度。 | 可选 | `1` | 写入 `scheduler.concurrency`；首次保持 1，确认单题链路后再提高。并发受 CPU、内存、Docker、模型服务限流和磁盘影响。 |
| 是否还有其他默认项需要修改？ | 可选 | 不需要 | 用户点名后再修改具体项，例如 `output.directory`、`run.timeoutSeconds`、`environment`、`run.preparation.*`、`run.onError`、`benchmark.config`、`services.<name>.api`。 |

执行要点：

- 只询问用户真正会关心的项，不逐项确认 `hardware`、`store`、`reporter` 等。
- 不要在未确认宿主机资源时承诺“安全并发”；并发是上限，不是自动容量规划。
- 不确定任务 ID 时，可运行 `arsi-evaluator run <yaml> --dry-run` 枚举；命令可能下载数据，所选题目见 `benchmark.runtime` 资源的 `output.groups[].taskIds`。输出路径以 `inspect` 的结果为准。
- 改选题或并发后需要新建 run；不要把不同范围的运行当成同一次续跑。

## 不要问的字段

以下字段有默认值或由 Profile 管理，除非用户明确提出需求，否则不要逐项追问：

- `store`、`reporter`、`metrics` 的实现细节。
- Profile 已提供的 Benchmark 数据来源、版本、场景、验证器和默认预算。
- 内部执行参数、缓存路径、容器工作目录、日志级别。
- Ray 的集群内部细节；只有用户选择 Ray 时才确认连接和节点。
- 任何密钥、token、代理密码的真实值。

## 访谈结束前的自检

- [ ] 三项必选（Benchmark、Harness、模型服务）均已确认，问句使用规范书面语。
- [ ] 第 2 轮可选项开关已询问；选择“采用默认值”时未追问其他项。
- [ ] 所有 `[条件必填]` 项已确认。
- [ ] YAML 中的认证字段全部是 `${ENV_NAME}` 引用。
- [ ] 已向用户说明下一步操作符合所选模式：配置模式执行 `inspect`；预检模式和运行模式执行 `inspect`、`doctor`，并说明 doctor 可能产生下载探针和 Docker 可用性检查。
