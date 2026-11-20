---
name: arsi-evaluator-setup
description: Use when the user wants to run an ARSI-Evaluator benchmark without writing an experiment YAML, asks to be interviewed for required and optional settings, needs a network connectivity preflight, or wants the agent to generate the YAML and launch the run.
---

# 交互式配置并运行 ARSI-Evaluator

在 Evaluator 仓库根目录操作。用户不需要手写 YAML：先盘点当前版本原生支持的 Benchmark 和默认 Profile，再分批询问真正需要用户决定的信息，生成实验 YAML，按用户选择的模式执行 `inspect`、`doctor` 或 `run`，并在需要时补充 network YAML。

通过 `npx skills add` 安装到其他项目时，本文件中的 `../../playbook/...` 和 `../../../docs/...` 是 Evaluator checkout 内的仓库路径，不是安装目录的相对路径；先定位 Evaluator 仓库根目录，再按这些路径读取。

已有实验 YAML、只需要诊断或续跑时，使用 `arsi-evaluator` Skill，不要重复访谈。实验创建完成或运行结束后，后续诊断、结果分析和 retry/resume 同样交给 `arsi-evaluator`，本 Skill 不重复承担。

按用户意图选择结束点：

- **配置模式**：生成 YAML 并执行 `inspect` 后停止，不触发下载或构建探针。
- **预检模式**：生成 YAML，执行 `inspect` 和 `doctor` 后停止。
- **运行模式**：完成配置、预检和用户确认后，才执行 `run`。

## 核心原则

- **先发现，后提问。** 先运行 `benchmark list`、`benchmark info` 和 `init`，复用 Profile 提供的版本、场景、数据来源、验证器、默认并发和运行参数。只问没有原生默认值、会改变评测结果或执行成本的事项。
- **必填与选填分开。** 每个问题标 `[必填]` 或 `[选填]`，同时给出默认值、推荐值和一个例子。用户回答“默认”“你决定”或“不知道”时采用默认值，并在后续摘要中写明。
- **分批访谈。** 每轮最多 5 个问题，先必填后选填；拿到本轮回答后再决定下一轮。不要一次列出全部字段。
- **密钥只留在环境变量。** YAML 中只写 `${ENV_NAME}` 引用；询问变量名，不询问密钥值，也不把值写进 YAML、命令、日志或对话。
- **先预检，后确认，再运行。** 按用户选择的模式执行：配置模式只跑 `inspect`；预检模式和运行模式跑 `inspect` 与 `doctor`。只有运行模式需要在 Preflight 汇总后取得用户确认，再执行 `run`。
- **Benchmark 字段只以 Profile 和 CLI 输出为准。** `benchmark list` 决定真实存在的 Benchmark ID，`benchmark info`、`init` 和 Profile 决定字段与默认值。不得根据名称或其它 Benchmark 的格式推测字段：不把 `math500` 改写成 `math-500`，也不假设 Judge/Verifier 字段在所有 Benchmark 中位置相同。Profile 未声明的字段不得编造。Benchmark 不在注册表时，按“回退流程”询问用户提供配置、数据来源或插件 patch，不要臆造 URL、路径或字段。每个访谈问题都必须能追溯到 CLI 输出、Profile 字段或校验要求，无法追溯就不要问。

## 流程总览

| 阶段 | 目标 | 关键命令 |
| --- | --- | --- |
| 0. 定位 | 确认 CLI、仓库根目录和输出位置 | `arsi-evaluator --help` |
| 1. 发现 | 查原生 Benchmark、版本、场景和默认配置 | `benchmark list`、`benchmark info`、`init` |
| 2. 访谈 | 分批补齐必填项和用户决策 | 见[问题清单](references/questions.md) |
| 3. 生成 | 写出 `experiment.yaml` | `init` 后按回答调整 |
| 4. 预检 | 校验配置并探测网络 | `inspect`、`doctor` |
| 5. 网络 | 失败时问询代理或下载源并复检 | 见[网络与 doctor](references/network-and-doctor.md) |
| 6. 确认 | 汇总配置、并发、预算和检查结果 | 用户确认后继续 |
| 7. 运行 | 正式评测并交付结果 | `run <yaml> --progress plain` |

## 0. 定位命令

先运行 `arsi-evaluator --help`。从源码运行时，按仓库要求执行 `pnpm install --frozen-lockfile` 和 `pnpm build`，并用 `node dist/cli.js` 替换下文的 `arsi-evaluator`。所有命令都在 Evaluator 仓库根目录执行，除非用户明确指定其他目录。

输出目录默认使用仓库内 `.scratch/arsi-setup/`，避免污染 `playbook/`。用户指定路径时遵从用户；路径应使用绝对路径或相对当前工作目录的路径。

## 1. 先发现原生能力

1. 运行 `arsi-evaluator benchmark list`（需要结构化处理时加 `--json`），确认目标 Benchmark 是否已注册，记录名称、版本、场景和默认组件。
2. 运行 `arsi-evaluator benchmark info <name>`，查看该 Benchmark 的版本、场景、解析后的设置和数据来源要求。
3. 运行 `mkdir -p .scratch/arsi-setup`，再运行 `arsi-evaluator init --benchmark <name> --output .scratch/arsi-setup/<name>.yaml` 生成最小配置。已有文件不会被覆盖；需要重新生成时换一个文件名。需要修改已有 YAML 时，先读取内容并核对它是否属于当前 Benchmark 与版本，再只改用户确认的字段，改完重新 `inspect`。`init` 会生成 `MODEL_NAME` / `MODEL_ENDPOINT` / `MODEL_API_KEY` 占位符；Profile 需要裁判时再生成 `JUDGE_NAME` / `JUDGE_ENDPOINT` / `JUDGE_API_KEY`。
4. 在 [Playbook](../../playbook/README.md) 中找同名 Benchmark 的示例，优先复用其数据来源、版本、场景、Solver 和网络要求。只把示例当作该 Benchmark 的默认证据，不要照抄与本机环境无关的绝对路径或机器名。
5. 用户已有插件 patch 时，`benchmark list`、`benchmark info` 和 `init` 也要带同一个 `--patch`，否则插件中的 Benchmark 不会出现在注册表里。
6. 把“已由原生配置确定”的字段列成简短清单，只对清单之外的必填项和用户决策提问。

Benchmark 未注册时，进入[回退流程](#回退流程)，不要先用通用模板猜一个 YAML。

## 2. 分批访谈

完整问题、默认值和跳过条件见[问题清单](references/questions.md)。优先使用 Agent 自带的结构化提问工具；没有时用编号问题。每轮遵循以下格式：

```text
第 1 轮（必填 2 项，选填 2 项）
1. [必填] 要评哪个 Benchmark？默认：<从 benchmark list 推荐>。例子：gsm8k。
2. [必填] 模型 ID 是什么？[条件必填] 自定义网关的地址是什么？例子：your-model + https://api.example.com/v1。
3. [选填] 先跑小样本还是全量？默认：全量；推荐首次先用 2～10 题验证链路。
4. [选填] 结果写到哪里？默认：Evaluator 根目录的 results/<benchmark>/<yaml 名>/<runId>/。
```

推荐顺序：

| 轮次 | 主题 | 必填 | 选填 |
| --- | --- | --- | --- |
| 1 | 目标与 Benchmark | Benchmark 名称 | 版本、场景、指标目标、是否更换 Solver、是否先小样本 |
| 2 | 模型服务 | 模型 ID、API key 环境变量名；自定义网关时的 base_url | 服务名、协议、provider、输出上限、独立裁判服务 |
| 3 | 执行环境与并发 | 无（均有默认） | local/docker、platform、调度器、并发、准备模式、准备时限 |
| 4 | 选题、预算与输出 | 无（均有默认） | taskIds、offset、maxTasks、采样、超时、输出目录、预算确认 |

规则：

- 用户不需要编辑 YAML；YAML 由你生成，只在最终审阅时展示。
- 用户已经提供的字段不再问；Profile 已给出默认值的字段只在会显著影响成本或结果时确认一次。
- 某个 Benchmark 需要额外认证（例如 Hugging Face 受限数据、独立裁判模型）时，在该轮把对应项标为 `[条件必填]`，并说明申请条件。
- 用户不确定并发时，先按 Profile 默认值给出小样本方案，并说明正式运行前会根据宿主机和准备开销复核。
- 每轮问题必须根据前一答案、`benchmark info` 结果和已生成配置动态收敛：用户选 local 就不问 Ray；不需要 Judge 的 Benchmark 不问裁判模型；已有模型服务不重复问部署方式；只有触发条件成立时，条件必填项才出现。
- 用户中途改变决定时，先明确指出受影响的前序结论已失效，再只重问受影响的项，并同步修订 YAML。
- 每轮结束时用两三行复述已确认项和仍待确认项，避免用户重复回答。

## 3. 生成 experiment.yaml

以 `init` 生成的配置为底稿，只加入用户确认的字段。保持渐进式配置：能由 Profile 补齐的字段不要重复写。结构通常是：

```yaml
services:
  default:
    model: ${MODEL_NAME}
    base_url: ${MODEL_ENDPOINT}
    api_key: ${MODEL_API_KEY}

benchmark:
  name: <benchmark>
  # version / scenario 按用户确认或 Profile 默认

# 可选：只写用户明确选择的字段
environment:
  platform: linux/amd64
scheduler:
  concurrency: 4
run:
  maxTasks: 5
output:
  directory: ./results/my-experiment
```

生成规则：

- 模型服务至少一个；Benchmark 必填。其余字段仅在用户选择或目标 Benchmark 明确要求时写入。
- 认证一律使用环境变量引用，例如 `${MODEL_API_KEY}`、`${HF_TOKEN}`、`${JUDGE_API_KEY}`。在最终摘要中列出需要导出的变量名。
- 相对路径以实验 YAML 所在目录为基准；需要跨目录复用时优先写绝对路径。
- 不写已废弃字段，不把旧版 `benchmarks` 数组、顶层 `model` 或 `solver` 混进新格式。
- 写完把完整的最终 YAML 展示给用户；用户要求修改时只改相关字段并重新预检。
- 每次修改 `experiment.yaml` 后都必须重新执行 `inspect`；涉及执行环境、并发或网络时，同时重跑受影响的 `doctor` 检查。Preflight 摘要必须回读即将执行的那份 YAML，不能使用访谈过程中的暂存参数。

## 4. 运行 inspect 和 doctor

四个命令职责不同，不要混用：

| 命令 | 职责 | 副作用 |
| --- | --- | --- |
| `inspect` | 解析和校验配置结构与内容 | 不下载、不启动组件、不发模型请求 |
| `doctor` | 检查运行条件和下载连通性 | 可能产生临时下载探针和 Docker 可用性检查（如 `docker version`），但不构建镜像、不准备任务镜像 |
| `warmup` | 准备任务镜像和运行时依赖 | 拉取或构建镜像，不执行任务 |
| `run` | 正式执行评测 | 调用模型、执行任务、产生费用 |

不要用 `doctor` 代替 `warmup`，也不要把 `warmup` 的资源准备描述成 `doctor` 的行为。

先解析配置，再探测网络和运行前置条件：

```bash
arsi-evaluator inspect <experiment.yaml>
arsi-evaluator doctor <experiment.yaml>
```

使用外部插件或显式网络配置时，给后续所有命令传同一份参数：

```bash
arsi-evaluator inspect <experiment.yaml> --patch <cordis.patch.yaml> --network <network.yaml>
arsi-evaluator doctor  <experiment.yaml> --patch <cordis.patch.yaml> --network <network.yaml>
```

省略 `--network` 时，CLI 可能加载用户级默认网络配置（例如当前用户目录下的 `.arsi-evaluator/network.yaml`）。不同机器内容不同；需要可复现时，始终显式传 `--network`。

`inspect` 只解析和校验配置，不下载、不启动组件，也不发模型请求。`doctor` 会检查配置、Docker/Python、本地路径、Ray 连接和下载连通性，可能执行临时下载或 Docker 构建探针，但不调用模型或执行任务。

doctor 的退出码：

| 退出码 | 含义 | 下一步 |
| --- | --- | --- |
| `0` | 无 `failed` 检查，且 `network.status` 为 `passed` | 注意仍可能有 `not-checked` 项，不能当作全部通过 |
| `1` | 存在 `failed` 检查，或 `network.status` 不为 `passed`（常见为 `incomplete`） | 先看是否有 `failed`：有则按失败操作、端点和执行位置分类处理；只有 `not-checked` 导致 `incomplete` 时，表示证据不足，不等于网络失败，可在风险说明后继续 |
| `2` | 配置错误 | 先修 YAML，不要改网络配置 |
| `130` | 用户取消 | 询问是否继续或停止 |

向用户报告 `passed`、`failed`、`not-checked` 的数量和具体失败项。宿主机探测成功不代表 Docker daemon、构建容器、任务运行时或 Ray 节点也能访问同一网络。

doctor 不调用模型，`model and task execution` 始终是 `not-checked`。使用自定义网关、供应商代理或不确定模型 ID 时，可以额外核对一次模型是否存在（可选，部分兼容网关不提供 `/models`）：

```bash
curl -s -H "Authorization: Bearer ${MODEL_API_KEY}" "${MODEL_ENDPOINT}/models"
```

确认 Solver 绑定服务的 `model` 出现在返回的 `data[].id` 中。接口不可用或返回结构不符时，标记为“无法验证”，不要据此判定模型 ID 错误。常见问题是 ID 多带了版本或日期后缀，doctor 不会发现，只有 run 才会以 404 `model_not_found` 失败。发现不一致时先和用户确认用哪个 ID，再重新 `inspect` 和 `run`。

## 5. 网络失败时再问网络配置

只在 doctor 明确显示网络、下载、镜像或代理相关失败时进入本轮；配置错误和缺少本地文件不属于网络问题。详细字段、模板和位置说明见[网络与 doctor](references/network-and-doctor.md)。

按一轮问题询问：

```text
网络预检发现 <操作/端点/位置> 失败。需要你确认连接方式：
1. [必填] 本机是否有可用的 HTTP(S) 代理？有则给地址；没有则回复“无”。
2. [选填] 下载源偏好：官方源 / 镜像源 / ModelScope 归档 / 自建源？默认：官方源。
3. [选填] Docker daemon、构建和任务运行时是否使用不同代理或镜像源？默认：与宿主机相同。
4. [条件必填] 代理需要认证时，凭据放在哪个环境变量？不要把用户名密码发到对话里。
```

根据回答生成独立的 `network.yaml`，放在实验 YAML 同目录或用户指定位置，然后复用同一路径重新执行：

```bash
arsi-evaluator inspect <experiment.yaml> --network <network.yaml>
arsi-evaluator doctor  <experiment.yaml> --network <network.yaml>
```

规则：

- 不虚构代理地址、镜像地址或认证信息；用户没有提供就保持默认或停止。
- 代理地址属于用户环境，写入 `network.yaml` 前确认它是用户明确给出的值；含认证信息时改用环境变量引用。
- 优先复用 [network Playbook](../../playbook/network/) 中现成的官方源、镜像源或 ModelScope 归档配置，只改需要变的字段。
- 网络仍然失败时，报告阻塞点和已尝试的配置，不要继续 run。

## 6. 预检审阅并确认（Preflight）

预检完成后，在启动正式评测前给出一份可审阅摘要，覆盖配置、并发能力、预算和执行范围。

并发能力需要单独说明：结合 Profile 默认值、宿主机 CPU/内存/磁盘、Docker 或 Ray 的承载能力、模型服务限流和准备开销，给出建议并发及理由。并发是上限而不是容量承诺；小样本阶段和正式运行阶段可以使用不同并发，并在摘要中写清楚。

| 项目 | 内容 |
| --- | --- |
| Benchmark | 名称、版本、场景、数据来源、Solver（含绑定的服务） |
| 模型服务 | 服务名、模型 ID、base_url、密钥变量名；独立裁判服务如有；自定义网关注明模型 ID 已核对或标记为“无法验证” |
| 选题 | 全量或 `taskIds` / `offset` / `maxTasks` / 采样 |
| 执行环境 | local 或 docker、platform、Docker 位置 |
| 调度与并发 | scheduler、concurrency、准备模式/并发/时限 |
| 准备 | 是否需要先 `warmup`；预计拉取或构建的镜像与运行时依赖 |
| 预算 | 超时、最大题数、模型调用或外部花费上限（如有） |
| 预检 | inspect 结果、doctor 的 passed/failed/not-checked、仍存在的风险 |
| 下一步 | 即将执行的完整 `run` 命令 |

然后询问用户是否确认配置和执行范围并开始运行。用户选择调整时，回到对应轮次，修改后重新执行 `inspect` 和受影响的 `doctor` 检查。配置模式在 `inspect` 后停止并交付 YAML；预检模式在此停止并交付配置摘要与预检结论。

若用户此前已经确认过同一配置、同一范围和同一花费上限，可以直接引用该确认继续，不重复询问；配置、选题、网络或预算发生实质变化时重新确认。

## 7. 运行并交付

用户确认后执行：

```bash
arsi-evaluator run <experiment.yaml> --progress plain
```

使用外部插件或网络配置时带上同样的参数：

```bash
arsi-evaluator run <experiment.yaml> --patch <cordis.patch.yaml> --network <network.yaml> --progress plain
```

需要先枚举任务 ID 时可以用 `run <yaml> --dry-run`；它只输出解析后的 `taskIds`，不打印输出目录，也不校验路径。输出目录和相对路径语义以 `inspect` 的结果为准。

运行期间保持进程存活，不要 detach。结束后先判定运行状态，再交付：

| 状态 | 判定依据 | 下一步建议 |
| --- | --- | --- |
| 全部成功 | 所选任务全部完成且校验通过 | 交付报告，可按需扩大范围 |
| 部分成功 | 部分任务失败、无效或跳过 | 交付成功/失败清单，失败题用 `retry --run <run-id>` |
| 任务执行失败 | 环境就绪但解题或校验失败 | 附 result.json、agent/stderr.log 路径，先定位再决定 retry |
| 未能开始 | 数据下载、镜像、网络或模型错误 | 先修对应配置或网络，再重新 `run` |
| 用户中断 | 手动终止 | 先检查 run 状态与可恢复条件，已完成的任务不会重跑，再给出 `run <yaml> --resume <run-id>`；不可恢复时新建 run |

交付内容：

- Run ID、结果目录和 `report.md` 路径。
- 完成、失败、无效或跳过的任务数量及原因。
- 网络补测或续跑命令（如适用）：`retry --run <run-id>`、`run <yaml> --resume <run-id>`。
- 用户导出过的密钥变量名；不要在结果中复述密钥值。

交付完成后，后续诊断、结果分析和恢复操作交由 `arsi-evaluator` Skill 处理，本 Skill 不重复实现。

需要预热任务镜像或运行时依赖时，先运行 `arsi-evaluator warmup <experiment.yaml> --progress plain`，确认 `failures` 为空且 `readyTaskIds` 覆盖所选任务，再执行 run。

## 回退流程

**Benchmark 未注册或原生配置不存在。** 先向用户确认是否已有可用的外部 Benchmark 插件、数据来源或配置样例：

- 有插件时，用 `--patch <cordis.patch.yaml>` 加载，并在 inspect、doctor、run 中保持一致。
- 有配置样例时，只复用与当前环境相关的字段，仍按本流程完成访谈和预检。
- 没有可用的 Benchmark 或集成契约时，报告缺失项并停止；不要用猜测的下载地址或字段生成一个无法运行的 YAML。

**用户只想要配置。** 配置模式完成 `inspect` 后交付 YAML；预检模式额外执行 `doctor` 并交付预检结论。两种情况都明确说明尚未运行。

**doctor 阻塞且用户无法调整网络。** 交付已生成的 YAML、失败项和修复建议，不启动 run。

**需要模型调用或镜像下载预算。** 在确认轮明确列出预计范围；无法给出可靠估算时标注“未验证”，并建议先用 `maxTasks` 小样本运行。

## 参考

- [问题清单](references/questions.md)：分批提问、默认值、必填和选填判断。
- [网络与 doctor](references/network-and-doctor.md)：失败分类、网络 YAML 模板和复检方法。
- [实验 YAML 字段参考](../../../docs/users/reference/experiment-yaml.zh-CN.md)
- [渐进式实验配置](../../../docs/users/config.zh-CN.md)
- [并发与环境准备](../../../docs/users/concurrency.zh-CN.md)
- [网络下载配置](../../../docs/users/network.zh-CN.md)
- [Playbook 示例](../../playbook/README.md)
