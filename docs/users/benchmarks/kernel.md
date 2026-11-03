# Evaluating Existing Kernels

> English | [中文](./kernel.zh-CN.md)

`kernel` validates existing candidates on Ascend NPUs, returning correctness, reference/candidate duration, speedup, and optional detailed hardware profiling. `kernel-replay` submits fixed artifacts without generation, repair, or model calls. Standalone use needs Evaluator, inputs, and NPU runtime. With RSI, its `kernel` evaluator generates candidates then calls the same CLI. This protocol performs correctness/timing/profiling; optimizers handle source diagnostics, model bottleneck analysis, and edits.

## Environment and Execution

Prepare dependencies through [installation](../installation.md). Current workspace requires sibling AgentBundle source/builds because static built-in imports depend on it even without that Solver.

Compatibility used AgentBundle 5ac62b4eeabec3d479a0365004966838b0c8023e (core 0.5.0). Declared tag 0.0.7 contains core 0.4.0 and lacks existing Jiuwenswarm support. Use the compatible commit for local linked builds, rebuilding core before Evaluator after updates.

Requires Linux, NPU, CANN, torch, torch_npu, triton-ascend; detailed collection also pandas/NumPy/Jinja2. Use a verified operator-capable Python and load CANN first. Only `local` environment/scheduler, concurrency 1; no competing timing workloads on the device. Built-in workers verify, so no benchmark.verifier. Local workspaces do not isolate malicious Python; evaluate trusted code only.

```bash
export KERNEL_EVAL_PYTHON=/absolute/path/to/venv/bin/python
export KERNEL_MANIFEST=/absolute/path/to/cases/tasks.json
export KERNEL_EVAL_PLACEHOLDER=unused-local-evaluation
pnpm build
node dist/cli.js run playbook/kernel/existing.yaml --dry-run
node dist/cli.js run playbook/kernel/existing.yaml
```

Example services are required placeholders with unusable URLs. The loader requires `api_key` to reference a nonempty variable; set `KERNEL_EVAL_PLACEHOLDER` to the ordinary text above, never a real key. Model usage is zero; offline `report` needs no variable.

## Task Files

Manifest paths are relative to its directory and must list reference/candidate dependencies. Absolute paths/.. are invalid. Dependencies retain relative structure in verification workspaces. Candidates must be self-contained Python or depend only on listed public helpers.

Reference/candidate remain under `data/<manifest-relative-path>`; candidates are not renamed/moved out. Same-directory helpers, relative package imports, and root-based packages are supported when all .py/__init__.py `files` are listed. Both run in one Python process; use distinct helpers and explicit package paths.

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

- `problem.py` supplies Model/get_inputs(), optionally get_init_inputs(). Reference calls `Model(*get_init_inputs())(*get_inputs())`, moved to NPU/eval.
- Candidates supply kernel_function(*inputs). In-place/stateful semantics are unsupported; parameters/weights/signatures are not guessed.
- Output equivalence is checked, not Inductor symbol substitution or full-model end-to-end regression.
- `referenceKind: pytorch` means trusted mathematical PyTorch reference; `original-kernel` establishes `original-kernel` equivalence, not independently proven math correctness. Authors choose according to source.
- Compare full nested tensor/list/tuple/dict/scalar outputs by default. Explicit `outputIndices` selects top-level list/tuple elements. For (tensor,tiling metadata...), `[0]` excludes non-computational metadata; retain all relevant multi-tensor indices.
- Fixed seeds call candidates twice each. Compare shape/dtype/device/value and finite tensors/nested floats. Reference NaN/Inf invalidates evaluation; candidate NaN/Inf fails correctness. Separate input copies preserve strides.

Source locks include SHA-256 for manifests, candidate/reference/dependencies, `precision.py`, `timing.py`, and `msprof_replay.py` (the msprof-attached operator replay). Changes require new runs; resume rejects them. Dependencies enter only after solving switches to verification; public Solver inputs exclude references.

## Detailed Profiling

Enable `benchmark.config.profiling.enabled` explicitly; default off retains correctness/timing. The original kernel semantics are ported: Python keeps only `msprof_replay.py`; TS manages collection, `msprof op`, retries/backoff, merging, ub_ratio, core utilization, L2 analysis, NPU specs/cache in `src/adapters/kernel/profile.ts` and protocols/kernel/msprof-csv.ts/msprof-analysis.ts/msprof-cache.ts. Source commit `f542552167fef844e10b865dc001e5c019f01ea5` is pinned. Only implementation language changes, not parser/cache/L2/retry rules.

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

Merge this fragment into existing experiments; services are above. Optional `msprofBin` selects profiler path; omission retains executable/CANN search. Optional `deviceName` enters original spec lookup; omission passes None and preserves defaults.

`attemptTimeoutSeconds` defaults 300 and maps directly to per-command timeout. `maxAttempts` defaults 2, maps to `max_retries` including the first. `roundNum` defaults 1 and supplies rounds/metadata. Original functions decide retry/None behavior for missing files, timeout, parse, and other exceptions.

`cacheEnabled` defaults true for this integration, using the original factory and hit/core/L2 behavior. false corresponds to `cache=None` and may omit fields. Optional `cacheDir` resolves against experiment YAML; omission uses original `default_msprof_cache`, preferring `KA_MSPROF_CACHE_DIR` then `~/.kernel_agent/msprof_cache` and respecting KA_MSPROF_CACHE_DISABLED=1. Explicit `cacheDir` directly constructs `MSProfCache`, bypassing factory disable logic. `metadata.cacheHit` records hits; original keys/reuse apply. Hits copy evidence into this attempt while returned `profile_dir` retains its original path.

`benchmark.config.timeoutSeconds` bounds whole verification, including correctness/timing/profiling, not the original algorithm's internal budget. Defaults to `maxAttempts * attemptTimeoutSeconds + 300` when profiling, otherwise 300. Set `run.timeoutSeconds` larger. Retries/backoff add time; outer termination may leave incomplete results.

Profile candidates only after correctness/standard timing. The adapter passes fixed-input `msprof_replay.py` to `msprof op`; TS spawns, extracts kernel names, merges tables, and exports. Profiler replay durations do not replace `referenceMs/candidateMs` or speedups.

Main `metrics` come directly from the original return object's metrics. This version uses `select="last"`, original merging, and three decimals. Evaluator adds no sorting/deduplication/sub-block association/missing-value filling/sign validation. Empty/zero/negative/string values remain. `metadata.outputPolicy="kernel-original-f542-v1"` and `upstreamCommit` identify source; raw `to_dict()` is `original-result.json` at metadata.originalResultJson.

Raw CSV/trace/logs/objects remain evidence. Current paths require neither `raw-metrics.json` nor selectedRawDurations. Historical `kernel-last-block-v1` retains saved LAST/raw evidence; unmarked history uses its existing block scope without reinterpretation.

| Data | Result location and units |
| --- | --- |
| AIC/AIV duration | aic_time(us)/aiv_time(us), µs |
| Cube/Vector/Scalar/MTE pipelines | aic_*_ratio/aiv_*_ratio, original CSV ratio units |
| L2 read/write hits | `aic_read_hit_rate(%)` and related columns, % |
| L2 optimization analysis | `metrics[blockId].l2_cache_analysis`, original fields/conclusions |
| Vector resource conflicts | `aiv_vec_stu_cflt_ratio` and original columns |
| UB ratio | Original `ub_ratio`; capacity/missing handling follows source |
| Vector core coverage | Conditional `core_utilization`, original denominator/result, not time utilization |
| Raw evidence | CSV/trace/log `artifacts` relative to attempt `verifier/` |

The parser also preserves these11 hardware fields:

| Source | Fields | Units and meaning |
| --- | --- | --- |
| `ResourceConflictRatio.csv` | `aiv_vec_wait_ratio`, `aiv_mte2_wait_ratio`, `aiv_mte3_wait_ratio` | Original Vector/MTE2/MTE3 wait ratios |
| `Memory.csv` | `aiv_gm_to_ub_bw(GB/s)`, `aiv_main_mem_read_bw(GB/s)` | Actual GB/s bandwidth |
| `Memory.csv` | `GM_to_UB_bw_usage_rate(%)` | Bandwidth utilization, % |
| `Memory.csv` | `read_main_memory_datas(KB)`, `write_main_memory_datas(KB)` | Original KB, not rewritten as KiB |
| `Memory.csv` | `aiv_mte2_instructions` | Original MTE2 instruction count |
| `ArithmeticUtilization.csv` | `aiv_vec_vf_ratio`, `aiv_vec_sfu_ratio` | Original arithmetic ratios, not FLOPS |

Original parsing handles missing tables/columns, empty cells, and merges. No extra required tables, positive duration, or unique-identity conditions are added; successful empty metrics still mean collection succeeded. Inspect raw tables/logs; missing fields are not measured zeros.

UB lookup/defaults use the original npu_specs/database; `deviceName` selects supported models. This version's `core_utilization` uses `ASCEND 950PR 128G` vector core counts regardless of deviceName. No additional UB/core overrides exist. Pipeline/wait/arithmetic ratios are not GB/s or FLOPS; explicit bandwidth fields retain GB/s.

Original `L2CacheAnalyzer` runs under original conditions. Reports display returned conclusions/evidence without new states/missing reasons/rules. These are optimization hints, not proof of bottlenecks or improvement. See task JSON/original-result.json.

Original None produces `profiling.status="failed"` and metadata.originalReturnedNone=true. Collection/wrapping exceptions stay local and do not change completed correctness/timing/scores/speedups. Incorrect candidates skip profiling; uncollected differs from failed.

Results require finite JSON. NaN/Inf in original output become representable text only in wrapper copies, with field paths/originals in `metadata.serializationConversions` and raw evidence intact. Algorithms remain unchanged and no zeros are substituted. Existing strings, including `"inf"`, remain. Completed means original return success, not all fields present/finite numeric.

## Metrics and Results

Type is quality. `passed/score` means output equivalence only:1 on pass,0 for candidate error/incorrectness. Correct slower candidates still pass with speedup<1.

Timing now ships as `timing.bench_kernel_ms` without external source access. Optional `benchmark.config.kernelRoot` retains external timing compatibility, locking external modules and their behavior. Both reference/candidate use `triton_only=False` for all device kernels per call, excluding CPU launch overhead. Built-in timing retains real reductions such as ReduceSum and validates finite nonnegative CSV rows. Missing columns/data, incomplete records, or nonpositive totals invalidate timing. Warmup is excluded; units ms. Timing uses the final seed's input; separate shapes into tasks.

`metrics.json` `metrics["kernel"]` contains:

| Field | Meaning |
| --- | --- |
| `selected / valid / invalid / pending` | Selected, judged, invalid, unfinished task counts |
| `passed / measured / faster` | Correct, fully timed, correct-and-faster counts |
| `passRateValid` | Correct / valid judgments |
| `passCoverage / fasterCoverage` | Correct or faster / all selected |
| `geometricMeanSpeedup` | Geometric mean for correct, fully timed tasks only |
| `profilingRequested` | Saved tasks explicitly requesting profiling |
| `profiled / profilingErrors / profilingUncollected` | Completed, failed, requested-but-uncollected |
| `profilingCoverage` | Profiled / all selected |
| `rows` | Reference kind, status, durations, speedup, profile summary/evidence per task |

Missing NPUs, reference failures, missing/invalid timing, worker protocol errors, and verification timeouts invalidate evaluation rather than candidate zero. No-data metrics are null, never NaN/Infinity. Consider coverage alongside average successful speedup.

`faster` means strictly>1, not statistically significant improvement; repeat near1 differences. Keep drivers/Python versions consistent; source locks do not manage environments.

Attempts save `verifier/kernel-result.json`, kernel-result.log, raw profiling, and candidate archives. For timeout without full results, inspect `errors`; framework stops worker process groups. Saved results rebuild offline.

`report.md` labels new original-kernel results and displays original metrics/L2/status/evidence. Historical LAST/unmarked results retain their definitions. `metrics.json` stores coverage/task summaries without recollection. RSI reads `verdict.details.profiling` from `tasks/<task-key>/attempts/<attempt-id>/result.json:`

```text
profiling.schemaVersion = 1
profiling.status / error                    # Collection status and error
profiling.kernels[].name                    # Kernel identity
profiling.kernels[].metrics[blockId]         # Original metrics, without additional validity rules
profiling.kernels[].metadata.outputPolicy   # kernel-original-f542-v1; historical results have older values or omit this field
profiling.kernels[].metadata.upstreamCommit # Pinned original implementation commit
profiling.kernels[].metadata.originalResultJson # Original to_dict() output, relative to verifier/
profiling.kernels[].metadata.originalMetadata # Original ProfilerMetadata
profiling.kernels[].metadata.cacheHit       # Original cache hit status
profiling.metadata.originalReturnedNone    # True when the original function returned None
profiling.metadata.serializationConversions # If present, records JSON-boundary conversions only
profiling.metadata                         # Source, invocation settings, and other adapter metadata
profiling.artifacts                        # Raw evidence paths relative to verifier/
```

Check executionStatus/scoreStatus/verdict.passed for correctness/timing and `profiling.status` independently for collection. Profile failure does not imply incorrectness. Numeric consumers must verify actual required finite fields, not only exit codes. Uses existing CLI/Node SDK without HTTP services; Python may subprocess the CLI and read JSON. Offline reports call neither models nor NPUs.

```bash
# Use the directory printed by run; no model credentials or operator rerun needed.
node dist/cli.js report /absolute/path/to/results/run-id
# Resume with identical configuration; referenced environment variables are still required.
node dist/cli.js run playbook/kernel/existing.yaml --resume
```

dry-run proves only configuration/source parsing, not NPU readiness. Missing torch/torch_npu/NPU during `run` returns nonzero with invalid records, not evidence of candidate correctness.

## Independent Measurement Atoms

Besides full runs, three independent atoms support external orchestration such as RSI or manual use:

```bash
# Precision gate: two runs per seed against problem.Model (defaults atol=1e-5 / rtol=1e-3)
node dist/cli.js kernel precision --problem <problem.py> --kernel <kernel.py> \
  --out <precision.json> [--seeds 0 1] [--python /usr/bin/python3]
# Timing only: same timing module as the benchmark (see Metrics and Results); no precision check
node dist/cli.js kernel bench --problem <problem.py> --kernel <kernel.py> \
  --out <bench.json> [--python /usr/bin/python3]
# msprof attaches to replay for hardware metrics, with cache/retries and roofline classification
node dist/cli.js kernel profile --problem <problem.py> --kernel <kernel.py> \
  --out <profile.json> [--round 0] [--python /usr/bin/python3]
```

Each outputs one JSON object:

| Atom | Output fields |
| --- | --- |
| `precision` | `passed`（bool）、`error`、`seeds`、`tolerance` |
| `bench` | `time_ms`（ms）、`error` |
| `profile` | `round`, `measured_by`, `metrics` (block pipelines/L2/bandwidth), `trace_analysis` (longest core/overlap/bubbles/Double Buffer, absent without trace), `roofline` (bottleneck/efficiency_rate/pipelines/warnings), `artifacts`, `error` |

Roofline: maximum pipeline utilization<0.8 yields `no` (underutilization first); otherwise pipelines>=0.4 classify bottlenecks in scalar→vec→mte2→mte3 order.

Exit contract: business failures such as compilation/precision set `error`, still write `--out`, and exit 0. Missing interpreters/timeouts/cancellation exit nonzero. `--python` defaults `python`; use torch_npu-capable interpreters. `KERNEL_ATOM_DIR` overrides executor directory, otherwise located from installation.

All atoms accept `--device <n>` for the logical NPU ID, default 0, equivalent to KERNEL_NPU_DEVICE. Full runs use benchmark.config.device. Targets must be allowed by ASCEND_RT_VISIBLE_DEVICES. Profile caches separate visible sets/target IDs; evidence is not exchanged across cards.

## RSI Integration

RSI calls measure/verify only, not atoms individually. Internally it always runs precision then bench and saves artifacts, matching original `verify`→benchmark semantics:

```ts
import { defaultKernelStepRunner } from './target-adapter/kernel/exec.js';

// Measure one candidate; skip timing if precision fails
const r = await defaultKernelStepRunner('measure',
  ['--workdir', workdir, '--problem-path', problem, '--kernel-file', kernel, '--kind', 'baseline'],
  { repoRoot, python: '/usr/bin/python3', timeoutMs: 600_000 });
// Returns { kind, time_ms, error, failure_class, failure_key }
// Saves beside the kernel: <stem>_precision.json, <stem>_bench.json, and input/output timing records

// Verify round artifacts: locate round{N}_output_kernel.py and its ancestor problem.py
await defaultKernelStepRunner('verify',
  ['--repo-root', repoRoot, '--workdir', workdir, '--round', '3'],
  { repoRoot, python: '/usr/bin/python3', timeoutMs: 600_000 });
// Pass: verify.json under <repoRoot>/rsi_runs/r3/verify/; failure: business error (exit 1)
```

`--kind`: `baseline` records input timing; `candidate` records round{N}_output artifacts. Failed verify/missing kernel is a business failure; `failure_class` distinguishes no_new_kernel/numeric/runtime/env.

RSI resolves execution through the command prefix configured by the installed RSI version, falling back to the sibling `../ember-evaluator/dist/cli.js`. Consult that RSI version for configuration details. RSI `python` forwards as --python. Subprocess contract: success exit 0/stdout one JSON; business errors exit 1/stderr text; environment faults exit 2/130. describe/read-slot/apply/restore/reflect/artifacts/render remain RSI-native without Evaluator subprocesses.
