# OfficeQA Pro V2

> [English](./officeqa-pro-v2.md) | 中文

`officeqa-pro-v2` 评测 Agent 在完整文档集合中检索证据、计算并回答问题的能力。使用 Databricks 官方 90 道题和 1,435 份美国财政文档；每题以原始 `uid` 标识，当前固定版本 CSV 的前两题为字符串 `"0"`、`"1"`。

[官方代码](https://github.com/databricks/officeqa) · [官方数据集与访问申请](https://huggingface.co/datasets/databricks/officeqa-pro-v2) · [配置示例](../../../playbook/officeqa-pro-v2/) · [返回 Benchmark 指南](README.zh-CN.md)

## 输入与测评口径

题目保存在 CSV 中，文档语料另行下载。每题向 Agent 提供问题及完整语料目录；参考答案、相关文档名单和答案页码仅用于私有评分及核查，不放进公开输入。

官方同时提供解析 JSON 和原始 PDF，没有在数据集说明中限定只能使用 PDF 或页面图片。本实现支持以下两种文档表示；JSON 是文档解析结果，不是参考答案：

| 输入 | 配置值 | Agent 可以读取的内容 |
| --- | --- | --- |
| 官方解析 JSON，默认 | `corpusFormat: parsed-json` | 可搜索的文本、表格、页面结构和坐标，约 794MB |
| 原始 PDF | `corpusFormat: pdf` | 官方原始 PDF，约 13.3GB；保留原有文本层，允许 `pdftotext` 和页面渲染 |

**当前没有实现“全部 PDF 强制渲染为图片、不给机器可读文本”的测评协议。** `pdf` 表示原始文件，不表示纯图片；仅切换 corpusFormat 不能复现纯图片输入条件。

例如，Moonshot 公布的 DeepSeek V4.1 Flash 1017 的 OfficeQA Pro V2 **40.4%** 使用完整 PDF 渲染图片、不提供机器可读文本，DeepSeek 使用 Claude Code；其测评还对在线取得参考答案的任务额外记零。见[发布文章的 Agentic benchmarks 脚注 3](https://www.kimi.ai/blog/kimi-k3-1-pro)及[原始图表](https://statics.kimi.ai/kimi-blogs/kimi-k3-1/20261023/finance-productivity-v4.webp)。本实现使用官方答案匹配函数，但不包含对方的整套图片输入、Harness 和额外行为判零流程，因此成绩不能直接与该数值比较。

报告成绩时应注明文档格式、Solver、数据版本、容忍度、任务范围和预算，例如“OfficeQA Pro V2 / parsed-json / simpleagent / tolerance=0 / 90 题”。使用原始 PDF 时同样应注明允许文本提取。官方评分脚本一致，不代表完整评测条件一致。

## 准备与运行

先按[安装指南](../installation.zh-CN.md)安装和构建。需要可用的 Docker、支持工具调用的模型 API，以及已获得数据集访问权限的 Hugging Face token。不要把 token 写进 YAML。

在运行终端设置 `HF_TOKEN`、`MODEL_NAME`、`MODEL_ENDPOINT` 和 `MODEL_API_KEY`。项目默认使用 HF 镜像；受限数据集访问建议显式设置 `HF_ENDPOINT=https://huggingface.co`。endpoint 必须是 HTTP(S) origin，协调端和 Ray 节点保持一致。

从仓库根目录运行：

```bash
ember-evaluator benchmark info officeqa-pro-v2
ember-evaluator doctor playbook/officeqa-pro-v2/officeqa-pro-v2-parsed-json-simpleagent.yaml
ember-evaluator run playbook/officeqa-pro-v2/officeqa-pro-v2-parsed-json-simpleagent.yaml --dry-run
ember-evaluator run playbook/officeqa-pro-v2/officeqa-pro-v2-parsed-json-simpleagent.yaml
```

`doctor` 检查配置、本机依赖和网络，执行临时下载及构建探针，不下载完整题库或语料。`--dry-run` 按现有 CLI 规则查询来源、读取题目 CSV 并输出选题 ID；它需要题库访问权限，首次可能下载约 225KB 的题目 CSV，但不下载文档语料、不构建镜像、不调用模型。

Playbook 中的 JSON、PDF、单机和 Ray 配置均不设置题数限制，运行全部 90 题。以下命令使用[解析 JSON 全量配置](../../../playbook/officeqa-pro-v2/officeqa-pro-v2-parsed-json-full.yaml)：

```bash
ember-evaluator run playbook/officeqa-pro-v2/officeqa-pro-v2-parsed-json-full.yaml
```

需要先验证少量题目时，可自行添加 `run.maxTasks: 2`。指定题目可使用 `run.taskIds: ["0"]`，数字形式的 ID 需要加引号，保持字符串类型。限制题数不会缩减提供给 Agent 的文档集合；切换到全量时应新建 run。

## 文档格式和参数

```yaml
benchmark:
  name: officeqa-pro-v2
  config:
    hfToken: ${HF_TOKEN}
    corpusFormat: parsed-json
    tolerance: 0
```

| 字段 | 默认值与说明 |
| --- | --- |
| `corpusFormat` | 默认 `parsed-json`，也支持 `pdf`（原始 PDF，允许文本提取）；一次运行只提供一种格式，不支持纯图片输入协议 |
| `revision` | `65a2b315780417bc50d7bfe6e5bdb904e63fda65`，必须是完整 commit SHA |
| `cacheDir` | `${EVALUATOR_CACHE_DIR}/officeqa-pro-v2`，由 Profile 提供；相对路径以实验 YAML 所在目录为准 |
| `hfToken` | 写为 `${HF_TOKEN}`，直接读取运行终端或 SDK `env` 提供的值；不写真实 token，不注入求解容器 |
| `dockerExecutable` | `docker`，私有评分容器使用的 Docker 命令 |
| `tolerance` | `0`，数值相对误差容忍值，范围 `[0, 1]`，例如 `0.01` 表示 1% |

默认 Docker、simpleagent、本地单并发、单题 3600 秒，批量环境准备预算 3600 秒。可按[Solver 指南](../solvers.zh-CN.md)替换 Agent；不支持 local 宿主环境，也不配置额外 verifier 或裁判模型。

JSON 格式保留官方 `document.elements` 和页面结构。公开文档位于 `/corpus`，保留原始文件名，Agent 在 `/workspace` 工作；镜像提供 Python 3、ripgrep、`pdftotext` 和 `pdftoppm`。需要原始 PDF 输入时使用 [原始 PDF 示例](../../../playbook/officeqa-pro-v2/officeqa-pro-v2-original-pdf.yaml)。

两种格式分别建立公开语料镜像，重复任务使用共享镜像层；每个 attempt 有独立工作区。首次运行需要下载、准备构建目录和构建镜像，应为缓存、Docker 构建快照及镜像层预留大于原始语料大小的磁盘空间。题目 CSV、答案、相关文档提示、答案页码和评分脚本不进入公开构建目录或求解镜像。

## 评分与结果

评分直接调用官方 `databricks/officeqa@7b9a3c154ef9fb40215bb67934afc43e6799de16` 的 `reward.py`，在独立无网络 Python 容器中执行；默认零容忍度，不调用 LLM Judge。

Prompt 要求用 `<FINAL_ANSWER>…</FINAL_ANSWER>` 提交单行、简短答案，解释放在标签外。最终答案的提取、数值、货币、会计负数、单位、百分比、文本标签和列表匹配均遵循固定版本的官方脚本。`tolerance: 0` 表示数值零容忍度，不代表原始字符串逐字相等。官方函数在输入不符合其答案规则时可返回零分。

每题得分为 0 或 1；报告使用现有成功率、耗时和 token usage 指标。验证详情保存脚本 revision、SHA-256、容忍度和语料格式。Python/Docker 启动失败、超时、取消或无效评分输出不会伪装成合法零分。不同语料格式或容忍度的成绩应分别注明；PDF 和解析 JSON 评测的输入条件不同。

默认不在结果中额外保存参考答案。需要审阅时可启用 `run.includeTaskAnswer: true`，该选项只在求解结束后写入结果，不向 Solver 提供答案。`/workspace` 作为任务产物收集，轨迹沿用现有结果目录。

续跑与离线报告：

```bash
ember-evaluator run playbook/officeqa-pro-v2/officeqa-pro-v2-parsed-json-simpleagent.yaml --resume
ember-evaluator report /absolute/path/to/run-directory
```

续跑固定原始 commit、文件清单和 SHA-256，已有完整缓存时不需要访问 HF；缓存缺失或损坏时按原始地址和摘要重新下载。YAML 显式填写 `hfToken: ${HF_TOKEN}` 时，配置加载仍要求此环境变量存在。公开构建目录被修改时明确报错，不使用被修改的文档。评分脚本和发布包变化仍遵循现有插件版本检查，不绕过续跑校验。离线报告不需要模型 key、HF token 或重跑评分容器。

## Ray 与验收边界

[解析 JSON + Ray 示例](../../../playbook/officeqa-pro-v2/officeqa-pro-v2-parsed-json-ray.yaml)使用同一 Benchmark，显式提供解析 JSON。节点从锁定来源下载全部所选格式的文档，在节点本地制作语料镜像；协调端绝对路径不传给节点。各节点需预先配置固定名称的 HF_TOKEN 凭据变量、相同 endpoint、Docker 和足够的缓存空间。hfToken 在投递和 Jobs 重试配置中删除，节点从自身 HF_TOKEN 读取凭据，不会把协调端 token 放进任务消息；保存和导出的本地配置只保留环境变量引用。

受控测试不访问正式数据集、不调用真实模型。独立 Docker 验收使用自建 CSV、JSON 和 PDF，检查文档工具、评分容器、镜像复用、保存结果和离线报告：

```bash
EVALUATOR_OFFICEQA_DOCKER_TESTS=1 pnpm test --run tests/integration/officeqa-docker.test.ts
```

PowerShell 使用 `$env:EVALUATOR_OFFICEQA_DOCKER_TESTS = "1"` 后执行测试命令。受控测试通过不代表已验证真实题库下载、真实模型效果或真实 Ray 集群；这些需要对应环境另行验收。
