# Evaluating Existing Kernels on NPU (kernel-npu)

> English | [Simplified Chinese](./kernel-npu.zh-CN.md)

`kernel` validates existing candidates on Ascend NPUs, returning correctness, reference/candidate duration, speedup, and optional detailed hardware profiling. `kernel-replay` submits fixed artifacts without generation, repair, or model calls. Standalone use needs Evaluator, inputs, and NPU runtime. RSI generates candidates through its Proposer and evaluates frozen artifacts through the full SDK. This protocol performs correctness/timing/profiling; optimizers handle source diagnostics, model bottleneck analysis, and edits.

## Hardware Selection

Use top-level `hardware: npu` in experiment YAML; omission also means NPU. `hardware: gpu` fails with “Kernel GPU backend is not implemented” before reading candidates or starting Python. Built-in timing uses only the NPU profiler and fails without an NPU instead of falling back to CUDA or CPU. Existing `kernel precision/bench/profile` commands remain NPU entry points with unchanged arguments and result formats. See the [existing kernel example](../../../playbook/kernel/existing.yaml).

## Environment and Execution

Prepare dependencies through [installation](../installation.md). pnpm downloads and builds the AgentBundle SDK from GitHub automatically; no sibling source repository is required. Built-in plugin imports need this dependency even when that Solver is not selected.

Requires Linux, NPU, CANN, torch, torch_npu, triton-ascend; detailed collection also pandas/NumPy/Jinja2. Use a verified operator-capable Python and load CANN first. Only `local` environment/scheduler, concurrency 1; no competing timing workloads on the device. Built-in workers verify, so no benchmark.verifier. Local workspaces do not isolate malicious Python; evaluate trusted code only.

```bash
export KERNEL_EVAL_PYTHON=/absolute/path/to/venv/bin/python
export KERNEL_MANIFEST=/absolute/path/to/cases/tasks.json
export KERNEL_EVAL_PLACEHOLDER=unused-local-evaluation
pnpm build
ember-evaluator run playbook/kernel/existing.yaml --dry-run
ember-evaluator run playbook/kernel/existing.yaml
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

Source locks include SHA-256 for manifests, candidate/reference/dependencies, `precision.py`, `timing.py`, `strict.py`, `timing_evidence.py`, and `msprof_replay.py` (the msprof-attached operator replay). Changes require new runs; resume rejects them. Dependencies enter only after solving switches to verification; public Solver inputs exclude references.

## Strict Task Contracts and Audited Timing

A manifest task may provide `contract` with schemaVersion 1, caseId, input tensor contracts, output tensor contract, and inputUnmodified. Each tensor specifies shape, dtype (`float16`) and contiguous; output also specifies independent. Contracts are optional for existing manifests. Strict evaluation checks entry, shape, dtype, device, layout, output independence, input preservation and numerical equality twice per seed. Results contain the contract digest, per-check assessment, effective protocol and observed environment. Reference/infrastructure failures remain invalid evaluations; candidate failures remain candidate failures.

Strict timing uses schemaVersion 2 / `profiler-flow/v1` evidence and CPU-to-NPU flow associations to assign device kernels to profiler steps. Raw CSV Step Id values are retained, not rewritten or trusted as the sole association. The audit rejects incomplete/ambiguous evidence and excludes warmup steps. The reported iteration mean covers all device kernels, not host launch time. CSV and trace artifacts accompany timing results. Public SDK exports parse contracts, assessments and timing evidence, and audit each timing sample.

## Detailed Profiling

The NPU backend owns Python/msprof execution, device binding and cleanup. The benchmark owns task identity and verdict validation. Full evaluation (`operation: evaluate`, the default) can collect diagnostics after successful correctness/timing by enabling profiling. Independent `operation: profile` requires exactly one task, one seed, `profiling.enabled: true` and `cacheEnabled: false`; it skips precision/timing and returns a performance result with no candidate score.

```yaml
benchmark:
  name: kernel
  config:
    operation: profile
    manifest: ${KERNEL_MANIFEST}
    python: ${KERNEL_EVAL_PYTHON}
    device: 0
    seeds: [42]
    timeoutSeconds: 900
    profiling:
      enabled: true
      collection: Default
      warmup: 25
      attemptTimeoutSeconds: 300
      maxAttempts: 2
      cacheEnabled: false
run:
  timeoutSeconds: 960
```

Merge this fragment into an existing experiment including the placeholder service above. `benchmark.config.device` selects one physical card: both visibility variables are set to that card and the worker uses logical device 0. Inherited multi-card visibility does not expand the allocation.

Replay uses the unchanged `problem.get_inputs()` and fixed seed. Warmup completes before one call inside an MSTX range (`rsi_operator_profile`). SDK sessions own all profiler children. Cancellation propagates; unconfirmed cleanup is an infrastructure failure. Per-attempt timeout defaults to 300 seconds and maxAttempts defaults to 2; the run timeout must exceed the benchmark timeout.

Two explicit collection protocols are supported:

- `PipeTimeline,Default` (default) requires PipeUtilization, L2Cache, ResourceConflictRatio CSVs and usable trace evidence.
- `Default` requires the three CSVs and marks trace unavailable with reason `not-requested-by-default-protocol`. Pipeline overlap/bubble/Double Buffer analysis is null. It never claims the full protocol passed.

Missing required evidence produces unavailable diagnostics, distinct from incorrect candidate code. Raw CSV, trace when available, replay metadata and process logs are retained. Source identity, case, seed, warmup, collection and device context identify reusable evidence. Independent profile runs disable disk cache so the caller owns reuse; evaluation-mode caching is optional.

Parsing retains ngo-agent-style block tables and last-row selection. Pipeline ratios, wait ratios, bandwidth and L2 fields retain source units. Missing pipe values remain null. UB ratio and core utilization derived from hardcoded hardware assumptions are unavailable; hardware facts must come from verified context. Diagnostic roofline classifications are hints, not proof of speedup. Nonfinite values are serialized explicitly without substituting zero. Profiler durations do not replace referenceMs/candidateMs.

## Metrics and Results

Evaluation type is quality; independent profiling uses performance. `passed/score` means output equivalence only:1 on pass,0 for candidate error/incorrectness. Correct slower candidates still pass with speedup<1.

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
ember-evaluator report /absolute/path/to/results/run-id
# Resume with identical configuration; referenced environment variables are still required.
ember-evaluator run playbook/kernel/existing.yaml --resume
```

dry-run proves only configuration/source parsing, not NPU readiness. Missing torch/torch_npu/NPU during `run` returns nonzero with invalid records, not evidence of candidate correctness.

## Independent Measurement Atoms

Besides full runs, three independent atoms support external orchestration such as RSI or manual use:

```bash
# Precision gate: two runs per seed against problem.Model (defaults atol=1e-5 / rtol=1e-3)
ember-evaluator kernel precision --problem <problem.py> --kernel <kernel.py> \
  --out <precision.json> [--seeds 0 1] [--python /usr/bin/python3]
# Timing only: same timing module as the benchmark (see Metrics and Results); no precision check
ember-evaluator kernel bench --problem <problem.py> --kernel <kernel.py> \
  --out <bench.json> [--python /usr/bin/python3]
# msprof attaches to replay for hardware metrics, with cache/retries and roofline classification
ember-evaluator kernel profile --problem <problem.py> --kernel <kernel.py> \
  --out <profile.json> [--round 0] [--seed 42] [--warmup 25] [--python /usr/bin/python3]
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

RSI's `application.kernel` seals candidate source, `proposer.operator` generates changes, and `evaluator.operatorbench` invokes `Evaluator.run()` using the kernel benchmark and kernel-replay solver. RSI installs the pinned `ember-evaluator` SDK; it does not discover a sibling checkout or run a separate CLI bridge. Evaluation and independent profiling are separate SDK operations. Measurement evidence links to the saved native result and verifier artifacts; evidence availability and calibration label confidence separately from candidate generation.

The SDK owns runtime assets, dependencies and prepare/build. Use the SDK package exports for contract and timing validation. An installed-consumer test can prove packaging and software integration without proving NPU correctness or performance; those require a real device run.
