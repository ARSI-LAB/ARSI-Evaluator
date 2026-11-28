# Load testing an inference service

[中文](./inference-workloads.zh-CN.md)

This experiment runs the first 100 TextVQA inputs at each concurrency. Each point has its own throughput and latency results.

~~~yaml
target: blue-vllm-tp2
benchmark:
  name: aisbench
  workload: { type: dataset, dataset: textvqa_gen_base64, requests: 100 }
  concurrency: [1, 8]
  collect: all
~~~

For AgentX, use `name: agentx` and `workload: {type: replay, traces: 8}`. Each point replays the first eight complete sessions. A session can produce multiple model requests.

## Configure the machines

Place `targets.yaml` beside the experiment, or point `EVALUATOR_TARGETS` at a shared file. Relative paths resolve against the experiment directory. Service credentials come from environment variables. Experiments can also declare `services` directly.

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

Install the specified AISBench version in the selected load-host Python environment. AgentX uses the evaluator environment by default. Its optional `loadNode` selects an SSH host with Python 3.11–3.13 on which evaluator caches the pinned Harness. SSH aliases must support non-interactive login, verified host keys and file transfer.

Dataset and tokenizer paths refer to the load host. `serviceNode` selects the inference host over SSH. Enable the vLLM torch profiler on startup and make its output visible there at `traceDirectory`. For SGLang, use `provider: sglang`. `devices` lists physical NPU IDs used by the service. When evaluator runs on the inference host, omit `serviceNode` and select a loopback model URL and physical devices for local sampling. Driver and CANN tool availability determine hardware counter coverage. If only the serving container has `msprof`, set `profiling.samplerPython` to an interpreter or wrapper that runs Python in that container. Mount the sampling script and output directory at the same absolute paths. `doctor` uses that interpreter to check the devices and `msprof`.

## Select the workload

| Tool | workload.type | Fields |
| --- | --- | --- |
| AgentX | time-window | `durationSeconds`, standard window 3,600 seconds |
| AgentX | replay | `traces`, number of complete sessions |
| AISBench | dataset | Native `dataset` configuration name, optional `requests` and `backend`. Select the installed dataset config for GSM8K or TextVQA |
| AISBench | synthetic-text | `inputTokens`, `outputTokens`, `requests`, optional `prefixCache` |
| AISBench | synthetic-multimodal | `images`, `textTokens`, `outputTokens`, `requests`, or `manifest` for previously prepared inputs |
| Both | native | `args` as individual CLI tokens. AISBench also accepts `file` and `files` to upload Python configs and companion modules relative to the experiment |

For example, `workload: {type: synthetic-multimodal, images: single_1080p, textTokens: 256, outputTokens: 32, requests: 100}` generates image and text requests. `images` also accepts `multi_720p_5` or a list of both presets. Use `action: prepare` to produce a manifest, or `action: validate` with `manifest` to check one. Omit concurrency and collection for data-only runs. Prefix-cache workloads require the source checkout at `aisbench.remote.aisbenchWorkPath` on the target.

A native workload can use `args: [--models, vllm_api_stream_chat, --datasets, textvqa_gen_base64, --debug]`. A switch occupies one list element. Order and repeated flags are preserved for the installed CLI. Versions that accept `--stream` can receive it directly. Versions with separate streaming templates can use `vllm_api_stream_chat`. Omit `concurrency` for native defaults and results under `configured/`. Explicit points verify the tool's concurrency. Python configs can select their own service and support `collect: performance`. Per-question GSM8K evaluation keeps its existing configuration and task directories.

## Run and read results

An existing AISBench Python configuration can run with `workload: {type: native, file: ./perf.py}` and `collect: performance`. Keep the target or service binding in the experiment. The uploaded file can read `EVALUATOR_AISBENCH_MODEL`, `EVALUATOR_AISBENCH_BASE_URL`, and `EVALUATOR_AISBENCH_API_KEY` on the load host. Omit `concurrency` to use the file's `batch_size`. For the actual command, open AISBench's `native-plan.json` or AgentX's `native-command.json`.

~~~bash
arsi-evaluator inspect experiment.yaml
arsi-evaluator doctor experiment.yaml
arsi-evaluator run experiment.yaml
arsi-evaluator report results/<run-id>
~~~

`inspect` shows the expanded configuration and native argument sources. The tool invocation is recorded with each point. `doctor` probes the model, paths on the load host, and profiling prerequisites on the serving node.

| collect | Operations at each point | Results |
| --- | --- | --- |
| performance (default) | Formal load | Latency, throughput and available KV cache and queue metrics |
| profiling | Warm up, start profiler, run bounded load, stop and export | Diagnostic evidence and categorized metrics |
| all | Run performance, then profiling after a successful formal load | Separate sources for both rounds |

## Result directory tree

For `concurrency: [1, 8]`, `collect: all` and the `full` preset, start with `report.md` to compare the points. Follow a category under `metrics/` to the raw evidence for a particular point and pass. The tree expands concurrency 1. Concurrency 8 has the same structure.

~~~text
<output.directory>/<run_id>/
├── config.yaml                  # Redacted experiment configuration saved by evaluator
├── manifest.json                # Run status, workload provenance and concurrency points
├── report.md                    # Report generated from the saved measurements
├── metrics/
│   ├── index.json               # Category paths and collection status per point
│   ├── service/requests.json    # Client measurements from the performance pass
│   ├── engine/engine.json       # Engine measurements from the performance pass
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
│   ├── measurement.json         # Saved pass results, status and errors
│   ├── files.json               # File inventory, checksums and missing items
│   ├── performance/             # Formal load-generator output and engine samples
│   │   └── outputs/             # AgentX Harness exports or native AISBench dataset reports
│   └── profiling/               # Diagnostic load-generator output and server evidence
│       ├── outputs/             # Client output for the diagnostic pass
│       └── trace/               # Rank exports and samples from the serving node
└── c8/
~~~

Each category JSON groups values by concurrency. Evidence paths are relative to the run directory. Use `metrics/index.json` to find the files produced by a particular run. Selecting only `performance` or `profiling` creates just that pass directory. A native workload that selects its own concurrency uses `configured/`. A diagnostic failure preserves completed formal results. An unconfirmed profiler stop blocks subsequent points.

| Category | Source and measurements |
| --- | --- |
| `service/` | `requests.json` uses the formal AgentX Harness or AISBench request statistics. It contains request counts, throughput, time to first token (TTFT), time per output token after the first (TPOT), and the percentiles exported by the client. |
| `engine/` | `engine.json` uses the service metrics endpoint for KV cache utilization and running and waiting requests. Window means, peaks or counter deltas appear when available. |
| `resource/` | `host.json` aggregates CPU, available memory, disk I/O and network samples from the serving node. `npu.json` includes device utilization, device memory usage and allocator statistics when available. Sources include the node sampler, configured exporters and service traces. |
| `execution/` | `operators.json` uses per-rank operator and kernel tables for counts, cumulative time, top operators and available shapes. `runtime.json` ranks Runtime calls and memory copies by time using timeline events. |
| `hardware/` | `hbm.json` records HBM bandwidth, `pmu.json` records available pipeline counters such as Cube, Vector and MTE, and `cache.json` records L2 cache events and derived hit ratios when available. Sources include service profiler databases, kernel tables and msprof exports. |
| `parallelism/` | `communication.json` uses HCCL exports and timeline events for communication time and available inter-rank link data. `timeline.json` reports per-rank compute time, communication time, overlap and communication time exposed outside compute. |

**Finding raw evidence by tool.** AgentX writes Harness logs and per-request exports to `performance/outputs/` and diagnostic warmup output to `profiling/outputs/warmup/`. Native AISBench dataset runs save the redacted command to `performance/native-plan.json` and dataset reports to `performance/outputs/`. When engine sampling is enabled, `performance/engine-series.jsonl` contains the raw readings. AISBench keeps its separate warmup job under `profiling/warmup/`. Both tools collect the service evidence under `profiling/trace/`. Inspect each rank’s `ASCEND_PROFILER_OUTPUT/` for native analysis files and `trace/msprof/` for collected hardware counters. Category coverage records explain missing evidence.
