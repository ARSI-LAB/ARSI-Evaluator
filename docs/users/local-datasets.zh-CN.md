# 本地数据集

> [English](local-datasets.md) | 中文

提前下载数据后，可让 Evaluator 直接读取本地文件。指定本地来源后不请求远端题库；文件缺失、格式错误或内容变化会报错，不回退下载。未指定时继续使用题库默认下载地址。CLI 和 SDK 使用同一份实验 YAML。

## WorkBuddy、Terminal-Bench 和其他 Harbor 题库

下载并解压原始任务包，在已有实验 YAML 中增加 `benchmark.config.source`。保留原来的题库名称、版本、场景、Solver 和验证器，例如 WorkBuddy Office：

```yaml
benchmark:
  name: workbuddy
  scenario: office
  config:
    source:
      kind: local
      path: ./data/wb-bench-office-v1.0
```

路径对应解压后的 `wb-bench-office-v1.0/`，其中应有 `tasks/` 和验证器需要的公共文件。其他 WorkBuddy 场景分别使用各自发布包的根目录。

Terminal-Bench 4.0 的 Profile 直接扫描 `tasks/` 中的任务目录，因此路径应指向解压后的 `tasks/`：

```yaml
benchmark:
  name: terminalbench
  version: "4.0"
  config:
    source:
      kind: local
      path: ./data/terminalbench4/tasks
```

修改 `source.kind` 会替换原来的归档来源参数，不需要再填写 `url`、`sha256` 或归档 `root`。原 Profile 的 `tasks`、题数、评分和验证配置仍然生效。仅保留部分任务时，须明确调整 `tasks.expectedCount`；选题限制 `run.maxTasks` 不会修改完整数据集的题数校验。自定义 Harbor 结构见[Harbor 指南](benchmarks/harbor.zh-CN.md)。

## Hugging Face 记录型题库

使用 `benchmark.config.localPath` 指向下载后的数据集目录，保持下表中的相对路径和格式。例如：

```yaml
benchmark:
  name: gsm8k
  config:
    localPath: ./data/gsm8k
```

| 题库 | 本地目录需要的文件 |
| --- | --- |
| gsm8k | `main/test-*.parquet` |
| mmlu | `all/test-*.parquet`、`all/dev-*.parquet` |
| mmlu_pro | `data/test-*.parquet`、`data/validation-*.parquet` |
| math500 | `test.jsonl` |
| gpqa | `gpqa_diamond.csv` |
| mgsm | 每个语言目录下的 `test-*.parquet`，语言列表沿用内置题库定义 |
| triviaqa | `rc.nocontext/validation-*.parquet` |
| humaneval | `openai_humaneval/test-*.parquet` |
| simpleqa | `simple_qa_test_set.csv` |
| healthbench | `2025-05-07-06-14-12_oss_eval.jsonl` |

只有一个文件分区的题库，也可以让 `localPath` 直接指向一个该格式的数据文件，例如 math500 的 JSONL 或 gsm8k 的 Parquet；分片目录则会读取所有匹配文件。多分区题库必须提供目录，不会把同一个文件重复用作多个分区。字段、评分方式和隐藏答案的处理与远端来源相同，不自动转换任意 JSON 格式。

## AgentX、OfficeQA、DROP 和 Kernel

| 题库 | 本地配置 |
| --- | --- |
| AgentX | `benchmark.config.localPath` 指向 `traces.jsonl` 或包含该文件的目录，内容应匹配所选 `variant` |
| OfficeQA Pro V2 | `benchmark.config.localPath` 指向包含 `officeqa_pro_v2.csv` 和完整语料的根目录；`parsed-json` 使用 `parsed_corpus/jsons/*.json`，`pdf` 使用 `pdfs/*.pdf`；保留官方题数和文档数校验 |
| DROP | `benchmark.config.localPath` 指向发布的 `.zip`，或解压后的父目录（含 `drop_dataset/drop_dataset_train.json`、`drop_dataset/drop_dataset_dev.json`） |
| Kernel | 原有 `benchmark.config.manifest` 指向本地题目清单，`kernelRoot` 指向候选代码目录；见 [Kernel 指南](benchmarks/kernel-npu.zh-CN.md) |

AgentX 本地数据的 revision 记录为 `local:<内容摘要>`，不伪装成 Hugging Face commit。Tokenizer、Harness 和模型服务仍使用各自已有配置。

## 路径、验证和限制

- 路径可以是绝对路径；相对路径以实验 YAML 所在目录为准。管理容器内运行时，必须挂载数据并填写容器能访问的路径。
- 数据文件必须真实存在，不读取 Git LFS 指针代替真实内容，不跟随所选文件的符号链接。Hugging Face 缓存中的链接文件需先复制成普通文件。
- 本地数据会计算内容摘要，读取和续跑校验内容；修改数据后应新建 run。
- 本地数据暂用于本机调度（可使用 Docker 执行环境）。Ray 不自动上传协调端目录，收到本地数据配置会报错；Ray 继续使用可由节点访问的远端来源。
- 本地数据不等于全离线：Docker 镜像、Python/npm 依赖、Tokenizer 和模型接口仍可能联网，见[网络配置](network.zh-CN.md)。

```bash
ember-evaluator inspect experiment.yaml
ember-evaluator run experiment.yaml --dry-run
ember-evaluator warmup experiment.yaml
ember-evaluator run experiment.yaml
```

`inspect` 查看配置；`--dry-run` 实际读取来源并枚举任务；`warmup` 检查任务、镜像和依赖准备。`doctor experiment.yaml` 仍主动执行网络诊断，不把配置本地数据理解为禁止诊断联网。
