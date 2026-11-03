# 已有 kernel 评测

> [English](./kernel.md) | 中文

`kernel` 在昇腾 NPU 上验证已有候选，输出正确性、参考耗时、候选耗时和加速比，并可采集候选的详细硬件性能指标。`kernel-replay` 仅提交固定产物，不生成或修复代码，不调用模型。独立运行只需要 Evaluator、输入样例和 NPU 运行时。与 RSI 联合使用时，由 RSI 的 `kernel` 评测器启动优化流程生成新候选，再调用同一 Evaluator CLI；正确性、计时和详细 profiling 均由本协议完成。静态源码诊断、模型分析瓶颈和修改 kernel 由优化器负责。

## 环境与运行

先按[安装指南](../installation.zh-CN.md)准备 Evaluator 依赖。当前仓库的工作区配置要求相邻目录存在 AgentBundle 源码及其构建产物；即使不使用 AgentBundle Solver，内置插件的静态导入仍依赖它。

兼容性验证使用 AgentBundle 提交 `5ac62b4eeabec3d479a0365004966838b0c8023e`（core `0.5.0`）。依赖声明中的 `0.0.7` 标签对应 core `0.4.0`，不支持 Evaluator 既有的 Jiuwenswarm 用例；本地工作区链接构建应使用上述兼容提交。更新依赖后先重建 core，再重建 Evaluator。

需要 Linux、可用 NPU、CANN、torch、torch_npu、triton-ascend；详细采集模块还依赖 pandas、NumPy 和 Jinja2。Python 应使用已验证可运行算子的解释器；启动前加载其 CANN 环境。仅支持 `local` 环境与 `local` 调度器，并发固定为 1；确保指定设备没有其他计时任务。验证由本 Benchmark 内置 worker 执行，不能另配 `benchmark.verifier`。local 工作区不隔离恶意 Python 代码，只评测可信代码。

```bash
export KERNEL_EVAL_PYTHON=/absolute/path/to/venv/bin/python
export KERNEL_MANIFEST=/absolute/path/to/cases/tasks.json
export KERNEL_EVAL_PLACEHOLDER=unused-local-evaluation
pnpm build
node dist/cli.js run playbook/kernel/existing.yaml --dry-run
node dist/cli.js run playbook/kernel/existing.yaml
```

示例 YAML 中的 service 是框架必填字段占位，地址不可用。现有配置加载器要求 `api_key` 引用非空环境变量，因此设置 `KERNEL_EVAL_PLACEHOLDER` 为上述普通文本即可，不要填写真实模型密钥。模型用量为零；离线 `report` 不需要该变量。

## 任务文件

清单中的路径相对清单目录，必须列出参考和候选依赖的文件，不能使用绝对路径或 `..`。依赖按原相对结构放入验证工作区。候选应是自包含的 Python 文件，或只依赖明确列出的公共辅助模块。

候选与参考均保留在 `data/<清单相对路径>`，不会将候选重命名后移出原目录。支持同目录辅助模块、包内相对导入，以及以清单根目录为起点的包导入；相关 `.py` 和 `__init__.py` 文件均须列入 `files`。参考与候选在同一 Python 进程中运行，辅助模块应使用不冲突的名称，优先使用明确的包路径。

```json
{
  "schemaVersion": 1,
  "tasks": [
    {
      "id": "operator-example",
      "problem": "problem.py",
      "candidate": "candidate.py",
      "files": ["input.py"],
      "referenceKind": "original-kernel",
      "outputIndices": [0]
    }
  ]
}
```

- `problem.py` 提供 `Model`、`get_inputs()`，可选 `get_init_inputs()`。参考调用为 `Model(*get_init_inputs())(*get_inputs())`，模型转到 NPU 并设为 eval。
- 候选提供 `kernel_function(*inputs)`。不支持原地修改输入或带状态的算子语义；不会猜测参数、权重或入口签名。
- 当前验证算子调用的输出等价性，不验证回填 Inductor 时的符号替换契约，也不代替整个模型的端到端回归测试。
- `referenceKind: pytorch` 表示可信的 PyTorch 数学参考；`original-kernel` 表示与原始 kernel 的输出等价，不能据此声称独立验证了数学正确性。此字段由任务作者根据参考源码选择。
- 默认比较完整输出，包括嵌套 tensor/list/tuple/dict 和标量。只有显式声明 `outputIndices` 才选择顶层 tuple/list 的指定元素。某些导出的输出含 `(tensor, tiling参数...)`，此时可用 `[0]` 排除非计算输出的元数据；多 tensor 输出须保留所有相关索引。
- 固定种子，每个种子重复调用候选两次。比较形状、dtype、设备与数值；Tensor 和嵌套 Python 浮点标量均检查有限性。参考含 NaN/Inf 属于无效评测，候选含 NaN/Inf 判为不通过。参考及候选输入分别复制并保留 stride。

来源锁包含清单、候选、参考、依赖、验证入口 `precision.py`、计时模块 `timing.py`、采集目标 `msprof_replay.py`（被 msprof 进程 attach 跑算子的重放脚本）的 SHA-256。变化后必须新建 run；续跑会拒绝变化。依赖文件在 Solver 结束并切换到验证阶段后注入，Solver 的公开输入不包含参考内容。

## 详细性能采集

在实验 YAML 中显式开启 `benchmark.config.profiling.enabled`。默认关闭，已有配置沿用正确性与计时行为。Evaluator 的采集链路按 kernel 原版语义移植：py 侧只保留被 msprof 进程 attach 跑算子的 `msprof_replay.py`，采集编排、`msprof op` 调用、重试退避、表格合并、ub_ratio、核利用率、L2 分析、NPU 规格表与缓存在 TS 层执行（`src/adapters/kernel/profile.ts` 与 `src/plugins/benchmarks/protocols/kernel/` 下 `msprof-csv.ts`/`msprof-analysis.ts`（含 NPU 规格表）/`msprof-cache.ts`）。固定来源为提交 `f542552167fef844e10b865dc001e5c019f01ea5`。移植只做语言载体替换，不重写指标解析、缓存、L2 分析或失败重试规则。

```yaml
benchmark:
  name: kernel
  config:
    manifest: ${KERNEL_MANIFEST}
    python: ${KERNEL_EVAL_PYTHON}
    timeoutSeconds: 2100
    profiling:
      enabled: true
      attemptTimeoutSeconds: 300
      maxAttempts: 2
      roundNum: 1
      cacheEnabled: true
run:
  timeoutSeconds: 2160
```

这是需合入现有实验配置的片段，service 等公共配置见上文。可选 `msprofBin` 指定 profiler 路径；省略时沿用原实现的可执行文件与 CANN 路径查找。可选 `deviceName` 传入原设备规格查询，省略时将 None 传给原构造函数，沿用原默认行为。

`attemptTimeoutSeconds` 默认 300 秒，直接对应原 profiler 单次命令超时；`maxAttempts` 默认 2，传给原函数的 `max_retries`，包含第一次执行。`roundNum` 默认 1，传给原函数的轮次参数和元数据。缺文件、超时、解析异常及其他异常是否重试、何时返回 None，均由原函数决定。

`cacheEnabled` 默认 true 是 Evaluator 对本次调用显式选择的默认值：调用原版缓存工厂，保留原缓存命中和附加 core／L2 指标行为。原构造函数允许 `cache=None`；设置 false 即采用这种行为，不能假定仍有相同的附加字段。可选 `cacheDir` 指定持久缓存目录，相对路径按实验配置解析；不指定时沿用原 `default_msprof_cache`，优先取 `KA_MSPROF_CACHE_DIR`，否则使用 `~/.kernel_agent/msprof_cache`，并遵守 `KA_MSPROF_CACHE_DISABLED=1`。显式指定 `cacheDir` 时直接构造原 `MSProfCache`，不经过默认工厂的禁用环境变量分支。命中状态记录在 `metadata.cacheHit`，缓存键、命中与复用内容按原逻辑执行；命中时将原采集目录复制到本次证据目录，原返回对象中的 `profile_dir` 保持原值。

`benchmark.config.timeoutSeconds` 是 Evaluator 对整个验证阶段设置的外层超时，包含正确性、计时和详细采集；不是原算法的内部总预算。启用 profiling 时默认值为 `maxAttempts * attemptTimeoutSeconds + 300`，关闭时为 300 秒，可按工作量覆盖。`run.timeoutSeconds` 应大于该 Benchmark 超时。原函数的重试及退避可能耗时，框架外层强制终止仍可能导致没有完整评测结果。

采集只针对候选，先完成正确性与统一计时。适配器把固定输入的重放脚本 `msprof_replay.py` 作为 `msprof op` 的被采集应用，TS 编排层负责 spawn、kernel 名称提取、表格合并和指标输出。详细 profiler 重放耗时不代替 `referenceMs/candidateMs`，也不参与加速比计算。

主 `metrics` 直接采用原函数返回对象中的 `metrics`。该版本原函数使用 `select="last"`、原表格合并和三位小数输出规则；Evaluator 不另外排序、去重、关联 sub-block、补齐缺失值或验证指标正负。空字典、零值、负值或字符串是否出现，均随原返回保留。`metadata.outputPolicy="kernel-original-f542-v1"` 与 `upstreamCommit` 标识原实现来源；原始 `to_dict()` 输出保存为 `original-result.json`，路径由 `metadata.originalResultJson` 给出。

原始 CSV、trace、日志和返回对象随证据保留。当前原版路径不要求生成 `raw-metrics.json` 或 `selectedRawDurations`。历史 `kernel-last-block-v1` 结果继续展示其已保存的 LAST 和 raw 证据；没有策略标记的历史结果仍按已有 block 范围展示，不用当前代码重解释。

| 数据 | 结果位置与单位 |
| --- | --- |
| AIC/AIV 执行时间 | `aic_time(us)` / `aiv_time(us)`，单位 µs |
| Cube、Vector、Scalar、MTE 管道 | `aic_*_ratio` / `aiv_*_ratio`，保留原始 CSV 比率单位 |
| L2 读写命中 | `aic_read_hit_rate(%)` 等原始列，单位 % |
| L2 优化空间规则分析 | 原 `metrics[blockId].l2_cache_analysis`，字段及结论沿用原函数 |
| 向量资源冲突 | `aiv_vec_stu_cflt_ratio` 等原始列 |
| UB 占比 | 原 `ub_ratio`，设备容量与缺失处理由原函数决定 |
| 向量核覆盖率 | 原流程在相应条件下附加 `core_utilization`，保留原设备分母及计算结果，并非时间利用率 |
| 原始证据 | `artifacts` 列出的 CSV、trace、日志等文件，相对本次 attempt 的 `verifier/` 目录 |

解析器也保留以下 11 个硬件字段：

| 来源 | 字段 | 单位与含义 |
| --- | --- | --- |
| `ResourceConflictRatio.csv` | `aiv_vec_wait_ratio`、`aiv_mte2_wait_ratio`、`aiv_mte3_wait_ratio` | Vector/MTE2/MTE3 等待比率，沿用 CSV 原值 |
| `Memory.csv` | `aiv_gm_to_ub_bw(GB/s)`、`aiv_main_mem_read_bw(GB/s)` | 实际带宽，GB/s |
| `Memory.csv` | `GM_to_UB_bw_usage_rate(%)` | 带宽使用率，% |
| `Memory.csv` | `read_main_memory_datas(KB)`、`write_main_memory_datas(KB)` | 主存读写数据量，保留 CSV 标注的 KB，不改写成 KiB |
| `Memory.csv` | `aiv_mte2_instructions` | MTE2 指令计数，沿用 CSV 原值 |
| `ArithmeticUtilization.csv` | `aiv_vec_vf_ratio`、`aiv_vec_sfu_ratio` | Arithmetic 比率，沿用 CSV 原值，不换算成 FLOPS |

各 CSV 是否存在、缺列、空单元以及合并行为均交给原解析函数处理。Evaluator 不增加“必需表”、正耗时、唯一执行身份等成功条件，也不另做可选字段缺失分析；原函数成功返回的空指标仍是采集成功。具体缺失情况可通过原始表格和日志复核，不能把没有字段等同于测量值为零。

UB 规格查询与默认值沿用原 `npu_specs` 和规格数据库，可用 `deviceName` 选择原实现支持的机型。该版本的 `core_utilization` 按原逻辑使用规格库中 `ASCEND 950PR 128G` 的向量核数作为分母，不随 `deviceName` 重新推算；Evaluator 不另设 UB 容量或核数覆盖参数。管道、等待和 Arithmetic 比率不能当成 GB/s 或 FLOPS，带宽字段本身保留其明确标注的 GB/s。

L2 分析由原 `L2CacheAnalyzer` 在原条件下执行，报告直接展示已返回的结论和依据，不补充新的三态判定、缺失原因或规则。它是优化提示，不能证明实际瓶颈或改写后的收益；完整内容见逐题 JSON 及 `original-result.json`。

原函数返回 None 时，适配器记录 `profiling.status="failed"` 与 `metadata.originalReturnedNone=true`。采集异常或包装失败同样局部记录，不改变已经完成的正确性、计时、评分和加速比汇总。候选数值不正确时不继续详细采集，这种“未采集”与采集失败分开记录。

框架结果必须是有限 JSON。若原始返回中出现 NaN／Inf，适配器只在包装副本中转换为可表示的文本并记录 `metadata.serializationConversions` 的字段路径和原值，原始证据保留原表示；不会修改原算法或把值补成零。原 metrics 已有的字符串（包括 `"inf"`）直接保留。报告中的“完成”表示原函数成功返回，不保证所有字段都有值或可作为有限数值使用。

## 指标与结果

评测类型为 `quality`。`passed/score` 只表示输出等价性，通过为 1，候选错误或不正确为 0。正确但更慢的候选仍为通过，`speedup < 1`。

计时模块已迁入 Evaluator，默认使用随包发布的 `timing.bench_kernel_ms`，无需访问外部源码目录。兼容已有配置时，可以显式设置 `benchmark.config.kernelRoot` 使用该外部仓库的计时模块；此时来源锁包含外部模块，且适用外部模块自身的计时行为。参考与候选均使用 `triton_only=False`，统计整个调用中所有设备 kernel 的耗时，不含 CPU 发射开销。内置计时器保留真实 ReduceSum 等归约耗时，逐行验证 CSV 耗时是否为有限非负数；缺列、空数据、记录数不完整或非正总耗时均视为无效测量。预热在有效样本之外，耗时单位为 ms。当前计时使用最后一个测试种子的输入；多种 shape 应拆成独立任务。

`metrics.json` 的 `metrics["kernel"]` 字段包含：

| 字段 | 含义 |
| --- | --- |
| `selected / valid / invalid / pending` | 所选、已判定、无效和未完成任务数 |
| `passed / measured / faster` | 正确、有完整计时、正确且加速的任务数 |
| `passRateValid` | 正确数 / 有效判定数 |
| `passCoverage / fasterCoverage` | 正确数或加速数 / 全部所选任务数 |
| `geometricMeanSpeedup` | 仅正确且完整计时任务的加速比几何均值 |
| `profilingRequested` | 已保存结果中明确请求详细采集的任务数 |
| `profiled / profilingErrors / profilingUncollected` | 详细采集完成、失败、已请求但未采集的任务数 |
| `profilingCoverage` | 详细采集完成数 / 全部所选任务数 |
| `rows` | 各任务参考种类、状态、两种耗时、加速比、详细采集摘要与证据路径 |

缺少 NPU、参考失败、计时缺失或非法、worker 协议错误以及验证超时属于无效评测，不当作候选零分。无数据的指标为 null，不写 NaN/Infinity。不要只看成功样本的平均加速比而忽略覆盖率。

`faster` 按加速比严格大于 1 计数，不代表统计显著提升；接近 1 的差异需要重复实验判断。运行前保持驱动和 Python 依赖版本一致，来源锁不替代环境版本管理。

每次 attempt 保存 `verifier/kernel-result.json`、`verifier/kernel-result.log`、profiler 原始输出，以及候选归档。超时没有完整结果时查看 attempt 的 `errors`；框架负责停止 worker 进程组。已保存结果支持离线报告重建。

`report.md` 给人阅读：新结果注明“原 kernel”，展示原返回指标、L2 结论、采集状态及证据链接；历史 LAST 或无输出策略结果保持原口径。`metrics.json` 是总体覆盖率与逐题摘要，字段值不会根据当前代码重新采集。RSI 需要性能反馈时读取 `tasks/<task-key>/attempts/<attempt-id>/result.json` 的 `verdict.details.profiling`：

```text
profiling.schemaVersion = 1
profiling.status / error                    # 采集状态与错误
profiling.kernels[].name                    # kernel 身份
profiling.kernels[].metrics[blockId]         # 原函数 metrics，不追加有效性规则
profiling.kernels[].metadata.outputPolicy   # kernel-original-f542-v1；历史结果为旧值或无此字段
profiling.kernels[].metadata.upstreamCommit # 固定的原实现提交
profiling.kernels[].metadata.originalResultJson # 原 to_dict() 输出，相对 verifier/
profiling.kernels[].metadata.originalMetadata # 原 ProfilerMetadata
profiling.kernels[].metadata.cacheHit       # 原缓存命中状态
profiling.metadata.originalReturnedNone    # 原函数返回 None 时为 true
profiling.metadata.serializationConversions # 若有，仅记录 JSON 边界转换
profiling.metadata                         # 来源、调用条件与其他适配信息
profiling.artifacts                        # 相对 verifier/ 的原始证据路径
```

调用方通过 `executionStatus`、`scoreStatus`、`verdict.passed` 判断原有正确性和计时是否有效，通过 `profiling.status` 单独判断详细采集是否返回结果；采集失败不等于候选不正确。需要消费数值指标时还应检查所需字段实际存在且为有限数值，不能仅看进程退出码。该能力沿用 Evaluator CLI 和 Node.js SDK，不新增 HTTP 服务；Python 调用方可用子进程执行 CLI 后读取上述 JSON。报告重建从已保存 JSON 计算，不调用模型或再次运行 NPU。

```bash
# 使用 run 输出的结果目录；无需模型凭证或重新执行算子。
node dist/cli.js report /absolute/path/to/results/run-id
# 沿用同一配置续跑；仍须设置配置引用的环境变量。
node dist/cli.js run playbook/kernel/existing.yaml --resume
```

`--dry-run` 通过只表示配置和任务来源可解析，不检查 NPU 是否可用。实际 `run` 缺少 torch、torch_npu 或 NPU 时会返回非零退出码，并留下无效评测记录；不能据此判断候选算子的正确性。

## 独立测量原子

除完整 `run` 外，Evaluator 提供三个可单独调用的测量原子，供外部编排（如 RSI）或人工逐项使用：

```bash
# 精度门：多 seed 双跑，对照 problem.Model 参照（默认容差 atol=1e-5 / rtol=1e-3）
node dist/cli.js kernel precision --problem <problem.py> --kernel <kernel.py> \
  --out <precision.json> [--seeds 0 1] [--python /usr/bin/python3]
# 纯计时：与基准走同一 timing 模块（口径见上文"指标与结果"），不校验精度
node dist/cli.js kernel bench --problem <problem.py> --kernel <kernel.py> \
  --out <bench.json> [--python /usr/bin/python3]
# msprof 采集：attach 重放脚本采集硬件指标，带缓存与重试；roofline 分类一体返回
node dist/cli.js kernel profile --problem <problem.py> --kernel <kernel.py> \
  --out <profile.json> [--round 0] [--python /usr/bin/python3]
```

输出均为单份 JSON：

| 原子 | 输出字段 |
| --- | --- |
| `precision` | `passed`（bool）、`error`、`seeds`、`tolerance` |
| `bench` | `time_ms`（ms）、`error` |
| `profile` | `round`、`measured_by`、`metrics`（按 block 的管道利用率/L2/带宽表）、`trace_analysis`（流水线 trace 分析：最长核/overlap/空泡/Double Buffer，无 trace 数据时缺省）、`roofline`（`bottleneck`/`efficiency_rate`/各管道利用率/`warnings`）、`artifacts`、`error` |

roofline 判定：最高管道利用率低于 0.8 直接判 `no`（欠利用优先）；否则利用率不低于 0.4 的管道按 scalar→vec→mte2→mte3 顺序归类为瓶颈。

退出码契约：业务失败（候选编译不过、精度不过等）时 `error` 字段非空、`--out` 照常落盘、进程以 0 退出；解释器缺失、超时、被取消等执行环境故障以非零退出。环境旋钮：`--python` 缺省 `python`，NPU 环境应传带 torch_npu 的解释器；`KERNEL_ATOM_DIR` 可显式指定执行体目录（缺省从安装位置自动定位）。

多卡选卡：三个原子均支持 `--device <n>` 指定 NPU 逻辑卡号（缺省 0 卡），等价于在执行体环境设置 `KERNEL_NPU_DEVICE`；完整 `run` 则通过 `benchmark.config.device` 配置。目标卡须在 `ASCEND_RT_VISIBLE_DEVICES` 允许的可见集合内，`profile` 的采集缓存按可见卡集合与目标卡号区分，不同卡的证据不互换复用。

## 与 RSI 框架对接

RSI 不逐个调用上述原子，其 kernel 链路只暴露 `measure` 与 `verify` 两个测量入口，内部固定按"先 precision 后 bench"编排并落产物（kernel 原版 verify→benchmark 语义）：

```ts
import { defaultKernelStepRunner } from './target-adapter/kernel/exec.js';

// 单候选实测：精度不过直接不计时
const r = await defaultKernelStepRunner('measure',
  ['--workdir', workdir, '--problem-path', problem, '--kernel-file', kernel, '--kind', 'baseline'],
  { repoRoot, python: '/usr/bin/python3', timeoutMs: 600_000 });
// 返回 { kind, time_ms, error, failure_class, failure_key }
// 产物落 kernel 同目录：<stem>_precision.json、<stem>_bench.json 及 input/output 口径耗时记录

// round 产物核验：自动定位 round{N}_output_kernel.py 与其上溯的 problem.py
await defaultKernelStepRunner('verify',
  ['--repo-root', repoRoot, '--workdir', workdir, '--round', '3'],
  { repoRoot, python: '/usr/bin/python3', timeoutMs: 600_000 });
// 通过：verify.json 落 <repoRoot>/rsi_runs/r3/verify/；不通过：业务失败（exit 1）
```

`--kind` 取值：`baseline` 结果记输入口径（round 输入耗时），`candidate` 记输出口径（round{N}_output 三件套）。`verify` 未通过或找不到 kernel 时以业务失败结束，`failure_class` 区分 `no_new_kernel`/`numeric`/`runtime`/`env`。

执行端定位（RSI → Evaluator 的桥）使用 RSI 侧配置的命令前缀，具体设置方式以所用 RSI 版本为准；缺省回退相邻仓 `../ember-evaluator/dist/cli.js`。RSI 的 `python` 选项透传为 Evaluator 侧 `--python`。子进程契约：成功 exit 0 + stdout 单 JSON；业务错误 exit 1 + stderr 文本；执行环境故障 exit 2/130（调用方按基础设施故障处理）。`describe`/`read-slot`/`apply`/`restore`/`reflect`/`artifacts`/`render` 为 RSI 原生实现，不经 Evaluator 子进程。
