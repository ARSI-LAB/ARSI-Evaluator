# 用同一份配置测推理服务

[English](./inference-workloads.md)

下面的实验让 AISBench 向视觉模型发送 TextVQA 的前 100 条输入。并发 1 和 8 各测这 100 条，分别输出吞吐、TTFT 和 TPOT。

~~~yaml
target: blue-vllm-tp2
benchmark:
  name: aisbench
  workload: { type: dataset, dataset: textvqa_gen_base64, requests: 100 }
  concurrency: [1, 8]
  collect: all
~~~

换成 AgentX 时，写 `name: agentx` 和 `workload: {type: replay, traces: 8}`。每档回放前 8 个完整会话，每个会话可以产生多条模型请求。

## 登记机器

把以下内容保存到实验 YAML 同级的 `targets.yaml`，或用 `EVALUATOR_TARGETS` 指定共享文件。相对路径从实验文件所在目录解析。密钥留在环境变量。也可以沿用实验中的 `services`。

~~~yaml
targets:
  blue-vllm-tp2:
    hardware: npu
    services:
      default:
        model: my-vision-model
        base_url: http://model-server:8000/v1
        api_key: ${MODEL_API_KEY}
    agentx:
      loadNode: load-host
      tokenizer: /models/my-vision-model
      pythonExecutable: /opt/python/bin/python3.12
    aisbench:
      tokenizerPath: /models/my-vision-model
      remote:
        ssh: { host: load-host }
        pythonExecutable: /opt/aisbench/bin/python
        aisbenchVersion: "3.1.0"
        workingDirectory: /opt/benchmark
    data:
      mmmuParquetDir: /data/MMMU
    serviceNode: inference-host
    profiling:
      provider: vllm
      traceDirectory: /data/vllm-traces
      devices: [0, 1]
~~~

AISBench 的指定 Python 环境需要已安装相应版本。AgentX 的 `loadNode` 是可选 SSH 别名，省略时使用 evaluator 的执行环境，指定时在发压机缓存固定版本的 Harness。远端 Python 使用 3.11–3.13。SSH 别名需支持免交互认证、已验证的主机密钥和文件传输。

数据和 tokenizer 路径属于发压机。`serviceNode` 是推理节点的 SSH 别名。vLLM 启动时需要启用 torch profiler，并将输出目录挂载到 `traceDirectory`。使用 SGLang 时选 `provider: sglang`。`devices` 取服务的物理 NPU 号。在服务节点直接运行 evaluator 时可省略 `serviceNode`，用回环地址和设备号启用本机采样。驱动和 CANN 工具的可见性决定能读取哪些硬件计数器。若 `msprof` 只装在推理容器里，可在 target 的 `profiling.samplerPython` 指向能在该容器中执行 Python 的入口。采样脚本和产物路径须在容器内以相同的绝对路径可见。`doctor` 会用该入口检查设备和 `msprof`。

## 选择负载

| 工具 | workload.type | 常用字段 |
| --- | --- | --- |
| AgentX | time-window | `durationSeconds`，标准窗口 3600 秒 |
| AgentX | replay | `traces`，前几个完整会话 |
| AISBench | dataset | `dataset` 是原生数据集配置名，可选 `requests` 和 `backend`。GSM8K 和 TextVQA 使用各自的配置名 |
| AISBench | synthetic-text | `inputTokens`、`outputTokens`、`requests`，可选 `prefixCache` |
| AISBench | synthetic-multimodal | `images`、`textTokens`、`outputTokens`、`requests`，或用 `manifest` 复用已有输入 |
| 两者 | native | `args` 逐项传给原生工具。AISBench 可用 `file` 和 `files` 上传实验目录下的 Python 配置与配套模块 |

生成图文输入时可以写 `workload: {type: synthetic-multimodal, images: single_1080p, textTokens: 256, outputTokens: 32, requests: 100}`。`images` 也支持 `multi_720p_5` 或两种规格的列表。选 `action: prepare` 只制数，结果中会给出 manifest 的路径；用 `action: validate` 和 `manifest` 校验清单。只制数或校验时省略 `collect` 和 `concurrency`。前缀缓存压测另需在 target 的 `aisbench.remote.aisbenchWorkPath` 登记工具源码目录。

原生调用可以写 `workload: {type: native, args: [--models, vllm_api_stream_chat, --datasets, textvqa_gen_base64, --debug]}`。无值开关占一个元素，重复参数按顺序写入列表。支持 `--stream` 的版本可直接传这个开关；通过模板开启流式的版本可选 `vllm_api_stream_chat`。省略并发时沿用工具配置，结果落在 `configured/`。显式分档时会核对工具实际使用的并发。原生 Python 配置可能自带服务地址，文件入口仅支持 `collect: performance`。按题测 GSM8K 延用原有 Benchmark 和结果目录。

已有 AISBench Python 配置时，可以直接上传文件。

~~~yaml
benchmark:
  name: aisbench
  workload: {type: native, file: ./perf.py}
  collect: performance
~~~

保留实验的 `target` 或 `services`。文件随每档作业上传，运行时可读取环境变量 `EVALUATOR_AISBENCH_MODEL`、`EVALUATOR_AISBENCH_BASE_URL` 和 `EVALUATOR_AISBENCH_API_KEY`。省略 `concurrency` 会使用文件中的 `batch_size`。需要核对实际调用时，查看 AISBench 的 `native-plan.json` 或 AgentX 的 `native-command.json`。

## 运行与读取结果

~~~bash
arsi-evaluator inspect experiment.yaml
arsi-evaluator doctor experiment.yaml
arsi-evaluator run experiment.yaml
arsi-evaluator report results/<run-id>
~~~

`inspect` 展示展开的配置与原生参数来源，实际 argv 随各档产物保存。`doctor` 检查发压机上的路径、模型可达性和服务节点的采集条件。

| collect | 每档并发的执行顺序 | 数据用途 |
| --- | --- | --- |
| performance（默认） | 正式压测 | 请求延迟、吞吐、服务公布的 KV Cache 和队列指标 |
| profiling | 预热、开启 profiler、有界诊断负载、停止并导出 | 诊断原始证据和分类指标 |
| all | 先正式压测，成功后执行 profiling | 保留两轮各自的来源 |

## 产物目录树

以 `concurrency: [1, 8]`、`collect: all` 和 `full` 采集为例。先看 `report.md` 比较两档成绩，再从 `metrics/` 的分类文件追到对应并发、轮次和原始文件。下图展开并发 1，并发 8 的结构相同。

~~~text
<output.directory>/<run_id>/
├── config.yaml                  # evaluator 保存的脱敏实验配置
├── manifest.json                # evaluator 记录的运行状态、负载来源和并发档位
├── report.md                    # 根据已保存的测量结果生成的汇总报告
├── metrics/
│   ├── index.json               # 分类文件路径及各档的采集状态
│   ├── service/requests.json    # 正式轮的客户端成绩
│   ├── engine/engine.json       # 正式轮的引擎指标
│   ├── resource/
│   │   ├── host.json
│   │   └── npu.json
│   ├── execution/
│   │   ├── operators.json
│   │   └── runtime.json
│   ├── hardware/
│   │   ├── hbm.json
│   │   ├── pmu.json
│   │   └── cache.json
│   └── parallelism/
│       ├── communication.json
│       └── timeline.json
├── c1/
│   ├── measurement.json         # evaluator 保存的各轮结果、状态和错误
│   ├── files.json               # 已收集的文件、校验值和缺失项
│   ├── performance/             # 正式轮的发压工具输出和引擎采样
│   │   └── outputs/             # AgentX Harness 导出或 AISBench 原生数据集报告
│   └── profiling/               # 诊断轮的发压记录和服务端证据
│       ├── outputs/             # 本轮的客户端输出
│       └── trace/               # 推理服务的 rank 导出及推理节点采样
└── c8/
~~~

每个分类 JSON 按并发列出测量值，证据路径相对运行根目录。实际生成的分类文件以 `metrics/index.json` 为准。仅选 `performance` 或 `profiling` 时，每档只创建所选轮次。原生负载自行决定并发时，对应档位使用 `configured/`。诊断失败后，可继续读取已完成的正式轮；profiler 停止状态未确认时，后续档位会暂停。

| 分类 | 文件来源与可读指标 |
| --- | --- |
| `service/` | `requests.json` 来自 AgentX Harness 或 AISBench 的正式轮请求统计，包含请求数、吞吐、首 token 时延（TTFT）、每个后续 token 的耗时（TPOT）及工具实际导出的分位数。 |
| `engine/` | `engine.json` 来自推理服务的指标端点，包含 KV Cache 使用率、运行中和等待中的请求数。可用时记录窗口均值、峰值或计数器增量。 |
| `resource/` | `host.json` 汇总推理节点的 CPU、可用内存、磁盘 I/O 和网络采样；`npu.json` 按设备记录 NPU 利用率、显存占用，以及 trace 提供的分配器统计。来源包括节点采样器、配置的 exporter 和服务端 trace。 |
| `execution/` | `operators.json` 从各 rank 的算子和 Kernel 表提取调用次数、累计耗时、最耗时的算子以及可用的 Shape。`runtime.json` 从时间线提取 Runtime 调用和 Memcpy 事件的耗时排名。 |
| `hardware/` | `hbm.json` 记录 HBM 带宽采样，`pmu.json` 记录可用的 Cube、Vector、MTE 等流水线计数器，`cache.json` 记录 L2 Cache 事件及可计算的命中比例。来源为服务 profiler 的数据库、Kernel 表和可用的 msprof 导出。 |
| `parallelism/` | `communication.json` 从 HCCL 导出和时间线提取通信耗时及可用的跨 rank 链路数据。`timeline.json` 按 rank 汇总计算、通信、二者重叠和未被计算覆盖的通信时间。 |

**按工具找原始文件。** AgentX 在 `performance/outputs/` 保存 Harness 日志和逐请求导出，诊断预热在 `profiling/outputs/warmup/`。AISBench 原生数据集运行的脱敏命令在 `performance/native-plan.json`，数据集性能文件在 `performance/outputs/`；启用引擎采样时，`performance/engine-series.jsonl` 保存原始读数。AISBench 的独立预热作业在 `profiling/warmup/`。两种工具都在 `profiling/trace/` 收集服务端的本轮证据，可在各 rank 的 `ASCEND_PROFILER_OUTPUT/` 查看原生分析文件；启用并成功采集时，`trace/msprof/` 保存硬件计数器。缺失数据的原因见对应分类的覆盖状态。
