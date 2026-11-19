# 自定义评测流程

> [English](workflows.md) | 中文

先选择流程模板，再填写模型、样例和评分参数。需要增删步骤时，导出展开后的 YAML。两种配置都使用 `run` 执行。

## 生成与运行

```bash
arsi-evaluator workflow list
arsi-evaluator init --workflow application.evaluate --output evaluate.yaml
```

修改 `evaluate.yaml` 中的模型地址、模型名和样例。认证使用 `apiKeyEnv` 指定环境变量名；不要把密钥写进配置。

```yaml
schemaVersion: 2
workflow: application.evaluate
with:
  model:
    model: your-model
    endpoint: https://api.example.com/v1
    apiKeyEnv: MODEL_API_KEY
  cases:
    - id: addition
      request:
        question: 2 + 2 等于几？只返回数字。
      reference: "4"
output:
  directory: results
```

```bash
arsi-evaluator inspect evaluate.yaml
arsi-evaluator run evaluate.yaml
```

`inspect` 检查插件、配置、输入输出和资源作用域，不执行评测。`apiKeyEnv` 在运行时读取，展开计划和产物中不保存认证值。通用模型资源使用 OpenAI-compatible Chat Completions 接口；使用 `--network network.yaml` 选择网络配置。

Benchmark 模板保留 `--model`、`--endpoint`、`--api-key-env` 和 `--task-ids-file`。`--api-key` 的值只存放在本次调用内存中，建议优先用环境变量。参数覆盖由模板处理，完整展开的工作流须直接修改 YAML。

```bash
arsi-evaluator run benchmark.yaml --model my-model --api-key-env MODEL_API_KEY
arsi-evaluator run benchmark.yaml --dry-run --task-ids-file selected.json
```

`--dry-run` 调用资源的 `preview` 操作。Benchmark 会读取来源并输出各模型分组的题目 ID，不创建 Solver、执行环境或运行结果，也不要求模型认证。没有预览操作的流程会提示使用 `inspect`。`selected.json` 格式为 `{"taskIds":["case-a","case-b"]}`，指定后覆盖采样、偏移和题数限制。

## 从文件读取样例

用 `casesFile: ./cases.jsonl` 替换 `cases`。每行一个样例：

```json
{"id":"addition","request":{"question":"2 + 2?"},"reference":"4"}
```

读取步骤把公开请求写入集合产物，答案单独作为私有输入传给评分器。续跑会检查原文件摘要；数据改变后需要新建 run。集合目前以 JSONL 文件保存，执行时读入内存。

## 增加、删除或替换步骤

```bash
arsi-evaluator inspect evaluate.yaml --output custom.yaml
arsi-evaluator run custom.yaml
```

展开配置包含 `resources`、`steps`、`inputs`、`outputs`。步骤用 `use` 选择插件，输入用 `{ ref: 上一步.outputs.字段 }` 引用已提交的输出，也可以用 `{ value: ... }` 提供常量。

- 删除报告步骤，可以只保存评分和指标。
- 在调用应用前插入数据处理步骤，再让应用读取其输出。
- 替换评分步骤时，同时修改资源绑定和指标所读取的输出。
- 删除某个输出的生产步骤后，必须一并修改依赖它的后续输入；`inspect` 会指出失效引用。

内核始终记录步骤、结果、产物和清理状态。用户不能通过删除报告或评分插件来删除运行记录。是否必须有数值分数，由工作流的 `outputs` 与 `required` 决定。

`forEach.mode: units` 表示相互独立的样例，可设置并发、模型 variants 和 repetitions；内层顺序遍历用于多轮对话或连续会话。记忆资源一般使用 `attempt` 作用域，避免不同样例共享状态。只有明确声明可安全共享的资源，才能由独立样例共同使用。

## 可用模板

| 模板 | 用途 | 显式 patch |
| --- | --- | --- |
| `application.evaluate` | 模型调用、精确匹配或模型评分 | 内置 |
| `benchmark.evaluate` | 使用现有 Benchmark、Solver、Environment 和 Verifier | 内置 |
| `results.rescore` | 对已保存的公开文本输出重新评分 | 内置 |
| `application.compare` | 比较两个模型，分别执行后再配对评分 | `plugins/workflow-compare/cordis.patch.yaml` |
| `memory.qa` | 跨会话记忆写入、查询和评分 | `plugins/workflow-memory/cordis.patch.yaml` |
| `pelican.svg` | 生成 SVG、浏览器渲染 PNG、视觉评分 | `plugins/workflow-pelican/cordis.patch.yaml` |

外部示例需先执行 `pnpm build`。使用同一份 patch 完成发现、初始化、检查、运行和补测：

```bash
arsi-evaluator workflow list --patch plugins/workflow-compare/cordis.patch.yaml
arsi-evaluator init --workflow application.compare --output compare.yaml --patch plugins/workflow-compare/cordis.patch.yaml
arsi-evaluator run compare.yaml --patch plugins/workflow-compare/cordis.patch.yaml
```

[示例配置](../../playbook/workflows/)提供记忆、双模型比较和鹈鹕流程。鹈鹕流程需要本机 Chromium/Chrome 可执行文件及支持图片输入的裁判模型；默认使用新的浏览器 profile。它不是文章中某个榜单的完整复刻。

## 续跑、补测与报告

```bash
arsi-evaluator run evaluate.yaml --resume <run-id>
arsi-evaluator retry --run results/<run-id> --task-id failed-case
arsi-evaluator report results/<run-id>
```

续跑核对配置、插件版本、数据来源和已保存产物。成功的样例不再次调用模型；失败的样例从新的 attempt 开始。只因资源清理失败而中断时，先确认清理，不重复生成和评分。外部写入步骤必须声明可安全重放，否则自动重试会拒绝执行。

`retry` 可反复指定 `--task-id`，省略时处理所有失败样例。运行中也可提交补测：只有已经失败且完成清理的样例会被重新入队，正在执行的样例保持运行。若请求没有可补测样例，命令会报告拒绝。重复提交同一个 `--request-id` 不会重复执行；原运行退出后，命令会直接执行所选补测。`report` 离线读取已保存的指标和产物，不调用模型，也不要求模型密钥。

运行结束或取消后，入口报告写入运行目录的 `report.md`。Benchmark 保留所选 Metrics/Reporter；其他流程可以由步骤提供离线报告接口，未提供时生成通用摘要。离线重建只要求相关报告插件可用且版本一致。显式续跑在 `reports/` 留存先前报告，补测和 `report` 更新当前报告，不覆盖此前的续跑快照。

## 重新评分

```bash
arsi-evaluator init --workflow results.rescore --output score.yaml
```

在 `with.source` 填原 run 目录，填写 `judge` 和 `rubric`，再执行 `arsi-evaluator run score.yaml`。新 run 只调用裁判，保留原模型分组和重复次数，原结果不被覆盖。模板读取执行单元公开输出中的 `response.text`；若输出名不同，可配置 `with.output`。图片、原生验证器证据等其他评分输入需编写对应的数据读取和评分步骤。

## Benchmark 模型分组与重复

在 `benchmark.evaluate` 的 `with` 中设置 `variants` 和 `repetitions`。每个分组继承基础配置，可以覆盖模型服务或 Solver：

```yaml
variants:
  - id: model-a
    services:
      default:
        model: model-a
  - id: model-b
    services:
      default:
        model: model-b
repetitions: 2
```

各组使用相同的题目选择。评分按组保存，不把不同模型和重复实验混成同一份成绩。

## 网络配置

工作流沿用 `--network network.yaml` 和 `EVALUATOR_NETWORK_CONFIG`；未指定时读取用户目录中的 `.arsi-evaluator/network.yaml`。例如：

```bash
arsi-evaluator inspect evaluate.yaml --network network.yaml --output expanded.yaml
arsi-evaluator run evaluate.yaml --network network.yaml
```

应用层自动为模型和 Benchmark 添加 `network.runtime` 依赖。导出的流程包含原始网络模板，`${PROXY_URL}` 等引用留到执行节点解析；检查和导出不要求提供这些值。代理、下载源和镜像的字段与[网络配置](config.zh-CN.md)相同。节点已有环境值优先，缺少时通过已认证通道读取提交端提供的已声明变量，凭据不写入计划。

编辑展开流程时，可以自行声明多个 `network.runtime` 资源，并在模型或 Benchmark 的 `resources.network` 中选择其中一个。已有的显式绑定不会被 `--network` 替换。协调端资源使用 `run` 网络资源，远端模型使用 `worker` 网络资源。

预热只创建允许用于依赖准备的网络客户端，不调用模型；操作结束或失败后释放客户端。`retry` 使用已保存计划的网络模板，不重新读取默认网络文件；`run --resume` 会重新检查 YAML 和网络模板是否与原计划一致。凭据值变化不会改变计划指纹。

## Ray 执行

`application.evaluate` 和 `benchmark.evaluate` 默认在本地执行。使用 Ray 时，在 `with` 中增加调度配置：

```yaml
scheduler:
  name: ray
  config:
    endpoint: ray://ray-head:10001
    concurrency: 4
    collector:
      certFile: security/collector.crt
      keyFile: security/collector.key
      tokenEnv: EVALUATOR_TRANSFER_TOKEN
      host: 0.0.0.0
      port: 8443
      publicUrl: https://coordinator.example:8443
```

每个节点安装相同版本的 evaluator 和插件，在节点配置中设置 `workflowWorkerEntry` 为 `dist/application/ray/workflow-worker.js` 的绝对路径。模型认证可在协调端或节点设置：优先使用节点已有值，缺少时通过认证 HTTPS 通道获取资源声明的凭据。凭据值只保留在内存中，不写入计划、结果或恢复日志。节点仍使用 `EVALUATOR_NODE_CONFIG`、`pluginPatchPath`、`configDirectory`、`outputRoot`、`caFile` 和 `tokenEnv`。协调端 patch 路径不会发送给节点。

模板自动生成 `ray.connection` 和执行器资源。Benchmark 的准备和执行共用连接，样例派发到已准备的节点。自定义展开流程可在独立样例的 `forEach.executor` 中选择 `executor.ray` 资源，并通过它的 `connection` 依赖绑定 `ray.connection`。模型客户端等可共享资源使用 `worker`，有状态会话使用 `attempt`。资源清理失败后，续跑先联系原节点恢复；原节点不可达时不会假定已经释放。控制消息上限为 2 MiB，单个产物上限为 256 MiB。

## Ray Jobs 部署

将协调进程也放到集群时，在 YAML 顶层配置 Jobs 网关。`with.scheduler` 只填写节点数和并发数，证书、内部 Ray 地址和产物通道由部署环境提供：

```yaml
schemaVersion: 2
workflow: application.evaluate
deployment:
  kind: ray-jobs
  endpoint: https://gateway.example:9443
  caFile: security/cert.pem
  tokenEnv: EVALUATOR_JOBS_TOKEN
with:
  scheduler:
    name: ray
    config:
      concurrency: 4
  model:
    model: your-model
    endpoint: https://api.example.com/v1
    apiKeyEnv: MODEL_API_KEY
  cases:
    - id: addition
      request: {question: "2 + 2"}
      reference: "4"
```

继续使用相同的 `run`、`warmup` 和 `retry` 命令。`run experiment.yaml --resume <run-id>` 自动上传本地结果中的完整产物，逐块校验摘要；成功样例继续复用。网关使用内存保存模型凭据，协调进程按需读取，临时提交文件只保存名称。网关重启后，使用相同续跑命令重新提供凭据。

顶层 `output.directory` 是下载结果的本地目录。计划中的相对资源路径指向集群部署的实验目录，不会上传本机数据文件或插件源码；各节点应预装对应数据、插件及运行时。`inspect --output` 导出时保留 Jobs 连接和本地输出位置。

`benchmark.evaluate` 也使用同一份调度配置；其 `with.deployment` 可配置网关。仅设置 `scheduler: {name: ray}` 而未指定网关时，会使用仓库提供的本机 Ray Jobs 环境。

## 使用范围

`benchmark.evaluate` 支持本地或 Ray 调度、原生环境准备、求解、验证、指标和报告。Ray 准备使用 batch 模式；pipeline 准备仍限于本地。各模型分组和重复实验使用独立的原生结果目录、指标和报告。浏览器的正常结束和取消会关闭进程，进程异常退出后的自动恢复仍可能要求人工确认。详细插件契约见[工作流插件开发](../development/workflow-plugins.md)。

## 本机 Bundle 与题库认证

`benchmark.evaluate` 会从实际执行的 Solver 分组收集 AgentBundle 名称，本机 Ray Jobs 自动挂载对应目录。通常不需要额外填写；目录不在默认位置时可在顶层覆盖：

```yaml
deployment:
  kind: ray-jobs
  managedLocal: true
  bundles:
    first: ./custom-bundles/first
    second: ../another-project/bundles/second
```

名称对应节点上的 `./bundles/first` 和 `./bundles/second`。每个目录必须包含 `bundle.yaml`，挂载为只读。宿主目录只写入本地部署记录；导出配置会保存解析后的绝对路径。修改映射后启动器重新检查集群挂载；仍有任务运行时不会重建。外部集群继续预装 Bundle，不使用本机挂载映射。

需要 HF 认证的 Benchmark 配置使用凭据名称：

```yaml
with:
  benchmark:
    name: gsm8k
    config:
      hfToken: {credential: HF_TOKEN}
```

运行前在环境变量 `HF_TOKEN` 中提供值。配置检查与导出保留引用，不展开真实认证。Ray 节点优先读取本地变量，缺少时通过认证通道向提交端按需获取。不要在 YAML 中填写 token 明文。

## 检查与镜像清理

```bash
arsi-evaluator doctor experiment.yaml
arsi-evaluator cleanup images experiment.yaml
arsi-evaluator cleanup images experiment.yaml --execute
```

第二条命令只预览，第三条才删除；已有的 `--yes` 同样表示执行删除。doctor 调用资源插件声明的检查，显示环境、认证是否可用及网络探测结果，不请求模型回答。镜像清理不需要模型或题库认证。配置包含 Ray Jobs 时，相同命令把维护请求发送到集群。

输出按资源列出检查结果。`failed` 是失败，`incomplete` 表示检查不完整，`deferred` 表示依赖评测步骤输出、当前无法执行；这些状态会使命令返回非零退出码。`not-required` 表示该资源未声明这项操作，不代表对应环境已经通过实际检查。

## 自动重试

Benchmark 模板遇到模型响应流中断时，会在清理完成后重新执行整道题，最多执行 3 次。普通业务失败和评分不通过不会自动重跑。每次保留独立 attempt 和失败证据；成功样例在续跑时继续复用。

自定义完整流程可以删除 `forEach.retry` 关闭自动重试，或替换策略资源并设置 `maxAttempts`。次数包含首次执行，续跑和手动补测不会重置自动重试额度。取消或清理未确认时停止自动重试。

## 从旧版本迁移

| 内容 | 当前支持方式 |
| --- | --- |
| 现有 Benchmark 评测流程 | 使用 `benchmark.evaluate`，保留题库、Solver、Environment、Verifier、指标和报告 |
| 旧实验 YAML | 改为 `schemaVersion: 2`，业务参数移到 `with`；`output` 和 `deployment` 放顶层；仓库 Playbook 已迁移 |
| 模型与题库认证 | 模型使用 `apiKeyEnv`，插件认证使用 `{credential: ENV_NAME}`；不再把环境变量展开成配置内的密钥 |
| 旧插件注册 | 改用 `registerNativeResource`；步骤、资源和模板使用各自的新注册接口 |
| 旧 SDK 运行入口 | 改用包根 `Evaluator`；结果类型为 `kind: "workflow"`，见 [SDK 指南](sdk.zh-CN.md) |
| 只有旧 `manifest.json` 的运行 | 使用生成它的旧版本读取报告或续跑；新入口不转换旧结果，也不改写历史文件 |
| 新工作流结果的续跑 | 要求计划、输入和插件/包实现指纹匹配；改变流程后开始新运行 |

命令仍使用 `run`、`warmup`、`doctor`、`retry` 和 `report`。旧 YAML 或插件不是自动兼容输入；先按上述方式迁移，再执行 `inspect` 检查。
