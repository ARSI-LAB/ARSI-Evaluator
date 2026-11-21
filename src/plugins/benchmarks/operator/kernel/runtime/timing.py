# Copyright (c) Meta Platforms, Inc. and affiliates.
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

"""
NPU kernel benchmarking.

Use torch_npu.profiler to capture kernel_details.csv and read Duration(us).

Measure device execution time without CPU launch latency.
"""

import builtins
import csv
import math
import os
import shutil
import time
from datetime import datetime, timezone

import torch

# Explicit NPU execution: never probe CUDA or substitute CPU timing.
import torch_npu


def _logical_npu_device_id() -> int:
    requested = os.environ.get("KERNEL_NPU_DEVICE") or os.environ.get("ASCEND_DEVICE_ID") or os.environ.get("DEVICE_ID")
    visible = os.environ.get("ASCEND_RT_VISIBLE_DEVICES") or os.environ.get("ASCEND_VISIBLE_DEVICES")
    if visible:
        visible_ids = [item.strip() for item in visible.split(",") if item.strip()]
        if requested and requested in visible_ids:
            return visible_ids.index(requested)
        return 0
    return int(requested or "0")


def device_synchronize():
    torch.npu.synchronize()


# ============ NPU profiler timing ============
def _bench_npu_profiler(fn, warmup=5, active=20, prof_dir=None, keep_res=False,
                        triton_only=False, audit=None, prepare=None, scope_evidence=None):
    """
    Capture kernel_details.csv with torch_npu.profiler.
    Return the mean kernel execution time in milliseconds.

    triton_only=True: include only Triton kernels, excluding aclnn framework operators.
            Use this scope for orchestrator baseline and promotion decisions.
    triton_only=False: sum all operators inside the wrapper.
            Use this scope for eager/inductor baseline logging.
    """
    if prepare is not None and audit is None:
        raise ValueError("Prepared inputs require profiler-flow timing evidence")
    for _ in range(warmup):
        if prepare is None:
            fn()
        else:
            inputs = prepare()
            device_synchronize()
            fn(inputs)
            device_synchronize()
    device_synchronize()

    # Profiler configuration.
    experimental_config = torch_npu.profiler._ExperimentalConfig(
        aic_metrics=torch_npu.profiler.AiCMetrics.PipeUtilization,
        profiler_level=torch_npu.profiler.ProfilerLevel.Level1,
        l2_cache=False,
        data_simplification=False,
    )

    if prof_dir is None:
        timestamp = datetime.now(tz=timezone.utc).strftime("%Y%m%d_%H%M%S")
        prof_dir = f"/tmp/prof_bench_{timestamp}_{os.getpid()}"
    else:
        os.makedirs(prof_dir, exist_ok=True)

    print(f"[bench_kernel] warmup: {warmup} active: {active} prof_dir: {prof_dir}")
    prof_dir_rel = os.path.relpath(prof_dir)
    print(f"[bench_kernel] NPU Profiler: {prof_dir_rel}")

    total = warmup + active
    options = {}
    activities = [torch_npu.profiler.ProfilerActivity.NPU]
    if audit is not None:
        # Capture every step, then explicitly exclude our warmup steps during reduction.
        steps = total if prepare is None else 2 * total
        options['schedule'] = torch_npu.profiler.schedule(wait=0, warmup=0, active=steps, repeat=1)
        # CPU records provide ProfilerStep ranges; only device kernel durations enter the mean.
        activities.append(torch_npu.profiler.ProfilerActivity.CPU)
    with torch_npu.profiler.profile(
            activities=activities,
            on_trace_ready=torch_npu.profiler.tensorboard_trace_handler(dir_name=prof_dir_rel),
            record_shapes=False,
            profile_memory=False,
            with_stack=False,
            with_flops=False,
            with_modules=False,
            experimental_config=experimental_config,
        **options,
    ) as prof:
        for _ in builtins.range(total):
            if prepare is None:
                fn()
            else:
                # Finish all restore work in the even step. The odd step owns only the invocation.
                inputs = prepare()
                device_synchronize()
                prof.step()
                fn(inputs)
            device_synchronize()
            if audit is not None:
                prof.step()

    # Strict callers require explicit flow association; no equal-row-count fallback.
    if audit is not None:
        from timing_evidence import collect_flow_timing
        audit.update(collect_flow_timing(prof_dir, warmup, active, prepared=prepare is not None))
        if triton_only:
            # Attribute every row before filtering so preparation and framework work
            # cannot be mistaken for candidate Triton kernels.
            with open(os.path.join(prof_dir, '..', audit['csvPath']), newline='', encoding='utf-8-sig') as source:
                reductions = {row['Name'] for row in csv.DictReader(source)
                              if row.get('Type', '').lower() == 'reducesum'}
            audit['rows'] = [row for row in audit['rows']
                             if not row['name'].startswith('aclnn') and row['name'] not in reductions]
            if {row['step'] for row in audit['rows']} != set(range(total)):
                raise ValueError('Incomplete Triton timing iterations')
            audit['meanMs'] = math.fsum(row['durationUs'] for row in audit['rows'] if row['step'] >= warmup) / active / 1000
            if not math.isfinite(audit['meanMs']) or audit['meanMs'] <= 0:
                raise ValueError('Invalid Triton mean duration')
        time_cost_ms = audit['meanMs']
    elif triton_only:
        time_cost_ms = _collect_npu_prof_triton_only(prof_dir, warmup, active)
    else:
        time_cost_ms = _collect_npu_prof_result(prof_dir, warmup, active)

    # Per-iteration durations are needed for scope statistics; collect before artifacts are removed.
    if scope_evidence is not None:
        scope_evidence['deviceSamplesUs'] = _iteration_totals_us(
            prof_dir, warmup, active, triton_only=triton_only, audit=audit)

    # Remove temporary profiler artifacts unless retention was requested.
    if not keep_res and os.path.exists(prof_dir):
        shutil.rmtree(prof_dir, ignore_errors=True)

    return time_cost_ms


def _collect_npu_prof_result(base_dir, num_warmup, num_active):
    """Sum all device operators per iteration, including reductions; reject missing or corrupt records."""
    import csv
    import math

    kernel_details_file = None
    for root, _, files in os.walk(base_dir):
        for file in files:
            if file == "kernel_details.csv":
                kernel_details_file = os.path.join(root, file)
                break

    if kernel_details_file is None or num_warmup < 0 or num_active <= 0:
        return float("inf")

    durations = []
    try:
        with open(kernel_details_file, newline="", encoding="utf-8-sig") as source:
            rows = csv.DictReader(source, strict=True)
            if "Duration(us)" not in (rows.fieldnames or []):
                return float("inf")
            for row in rows:
                duration = float(row["Duration(us)"])
                # Include reductions in all-device timing; nonfinite durations must not be silently ignored.
                if not math.isfinite(duration) or duration < 0:
                    return float("inf")
                durations.append(duration)
    except (csv.Error, TypeError, ValueError):
        return float("inf")

    total_iters = num_warmup + num_active
    if not durations or len(durations) % total_iters != 0:
        return float("inf")

    # Fixed-input graph iterations have equal record counts; skip captured warmup iterations.
    rows_per_iter = len(durations) // total_iters
    active_durations = durations[num_warmup * rows_per_iter:]
    avg_us = math.fsum(active_durations) / num_active
    return avg_us / 1e3 if math.isfinite(avg_us) and avg_us > 0 else float("inf")


def _collect_npu_prof_triton_only(base_dir, num_warmup, num_active):
    """Read Triton kernel Duration(us) values from kernel_details.csv and return milliseconds.

    Exclude aclnn framework operators such as MatMulV3, Transpose and BatchMatMulV3.
    Retain timings for Triton-generated kernels whose names do not start with aclnn.

    This is the timing scope used for orchestrator baseline and promotion decisions.
    """
    import pandas as pd

    kernel_details_file = None
    for root, _, files in os.walk(base_dir):
        for file in files:
            if file == "kernel_details.csv":
                kernel_details_file = os.path.join(root, file)
                break

    if kernel_details_file is None:
        return float("inf")

    df = pd.read_csv(kernel_details_file)

    # Exclude ReduceSum used for L2 cache clearing.
    if "Type" in df.columns:
        df = df[~df["Type"].str.contains(r"^ReduceSum$", case=False, na=False)]

    # Keep Triton kernels whose names do not start with aclnn.
    if "Name" in df.columns:
        df = df[~df["Name"].str.startswith("aclnn", na=False)]

    total_iters = num_warmup + num_active
    if total_iters <= 0 or len(df) % total_iters != 0:
        print(
            f"[bench_kernel] WARNING: kernel_details row count ({len(df)}) "
            f"is not a multiple of the model iteration count ({total_iters}); cannot split rows by iteration"
        )
        return float("inf")

    rows_per_iter = len(df) // total_iters

    warmup_rows = num_warmup * rows_per_iter
    active_rows = df.iloc[warmup_rows:warmup_rows + num_active * rows_per_iter]

    if len(active_rows) == 0:
        return float("inf")

    avg_us = active_rows["Duration(us)"].sum() / num_active
    return avg_us / 1e3  # us -> ms


def bench_kernel(fn, warmup=5, active=20, prof_dir=None, keep_res=False,
                 triton_only=False, audit=None, *, prepare=None, scope_evidence=None):
    """NPU profiler duration in ms; triton_only excludes framework kernels."""
    if not torch.npu.is_available():
        raise RuntimeError("NPU is required; CPU/GPU fallback is disabled")
    torch.npu.set_device(_logical_npu_device_id())
    return _bench_npu_profiler(fn, warmup=warmup, active=active,
                               prof_dir=prof_dir, keep_res=keep_res,
                               triton_only=triton_only, audit=audit, prepare=prepare,
                               scope_evidence=scope_evidence)


def bench_kernel_ms(fn, **kwargs):
    """Return the shared benchmark result in milliseconds."""
    return bench_kernel(fn, **kwargs)


def bench_prepared_kernel_ms(fn, prepare, **kwargs):
    """Call fn(prepare()) with a fresh input tree, measuring only fn's device kernels."""
    return bench_kernel(fn, prepare=prepare, **kwargs)


def bench_kernel_us(fn, **kwargs):
    """Return the benchmark result in microseconds."""
    return bench_kernel(fn, **kwargs) * 1000


SCOPES = ("device", "host", "endToEnd")
STATISTICS = ("mean", "p50", "p95")


def _iteration_totals_us(base_dir, num_warmup, num_active, triton_only=False, audit=None):
    """Sum every included device kernel per iteration (warmup excluded).

    Uses the already-audited flow rows when present, otherwise the profiler CSV. Raises
    instead of returning inf so scope statistics cannot be silently fabricated.
    """
    if num_warmup < 0 or num_active <= 0:
        raise ValueError("Invalid timing protocol")
    if audit is not None and "rows" in audit:
        totals = {}
        for row in audit["rows"]:
            totals[row["step"]] = totals.get(row["step"], 0.0) + float(row["durationUs"])
        samples = [totals.get(step) for step in range(num_warmup, num_warmup + num_active)]
        if any(value is None for value in samples):
            raise ValueError("Incomplete timing iterations")
        if any(not math.isfinite(value) or value < 0 for value in samples):
            raise ValueError("Invalid timing duration")
        return [float(value) for value in samples]

    kernel_details_file = None
    for root, _, files in os.walk(base_dir):
        for file in files:
            if file == "kernel_details.csv":
                kernel_details_file = os.path.join(root, file)
                break
    if kernel_details_file is None:
        raise ValueError("Missing kernel_details.csv")

    durations = []
    with open(kernel_details_file, newline="", encoding="utf-8-sig") as source:
        table = csv.DictReader(source, strict=True)
        fields = table.fieldnames or []
        if "Duration(us)" not in fields:
            raise ValueError("Missing Duration(us) column")
        for row in table:
            if triton_only:
                if "Type" in fields and (row.get("Type") or "").strip().lower() == "reducesum":
                    continue
                if (row.get("Name") or "").startswith("aclnn"):
                    continue
            duration = float(row["Duration(us)"])
            if not math.isfinite(duration) or duration < 0:
                raise ValueError("Invalid timing duration")
            durations.append(duration)

    total_iters = num_warmup + num_active
    if not durations or len(durations) % total_iters != 0:
        raise ValueError("Timing records do not cover every iteration")
    rows_per_iter = len(durations) // total_iters
    samples = [math.fsum(durations[step * rows_per_iter:(step + 1) * rows_per_iter])
               for step in range(num_warmup, total_iters)]
    if any(not math.isfinite(value) or value < 0 for value in samples):
        raise ValueError("Invalid timing duration")
    return samples


def _percentile(ordered, fraction):
    """Nearest-rank percentile on a sorted sample list (no numpy dependency)."""
    index = max(0, min(len(ordered) - 1, math.ceil(fraction * len(ordered)) - 1))
    return ordered[index]


def _summarize_ms(samples_ms, statistics):
    """Return requested statistics plus the raw samples for one timing scope.

    The mean is always emitted because it backs the compatible candidate/reference
    fields; p50/p95 are emitted only when requested.
    """
    if not samples_ms:
        raise ValueError("Empty timing samples")
    ordered = sorted(samples_ms)
    summary = {"count": len(samples_ms), "samples": [float(value) for value in samples_ms],
               "meanMs": math.fsum(samples_ms) / len(samples_ms)}
    if "p50" in statistics:
        summary["p50Ms"] = _percentile(ordered, 0.5)
    if "p95" in statistics:
        summary["p95Ms"] = _percentile(ordered, 0.95)
    return summary


def _run_once(fn, prepare):
    if prepare is None:
        return fn()
    return fn(prepare())


def _host_samples_ms(fn, prepare, warmup, repeat):
    """Per-call host launch cost; devices are synchronized only outside the timed region."""
    for _ in range(warmup):
        _run_once(fn, prepare)
    device_synchronize()
    samples = []
    for _ in range(repeat):
        start = time.perf_counter()
        _run_once(fn, prepare)
        samples.append((time.perf_counter() - start) * 1e3)
    device_synchronize()
    return samples


def _end_to_end_samples_ms(fn, prepare, warmup, repeat):
    """Serial latency of one launch including device completion."""
    for _ in range(warmup):
        _run_once(fn, prepare)
    device_synchronize()
    samples = []
    for _ in range(repeat):
        if prepare is None:
            device_synchronize()
            start = time.perf_counter()
            fn()
        else:
            inputs = prepare()
            device_synchronize()
            start = time.perf_counter()
            fn(inputs)
        device_synchronize()
        samples.append((time.perf_counter() - start) * 1e3)
    return samples


def bench_kernel_scopes(fn, *, warmup=5, repeat=100, scopes=SCOPES, statistics=("mean", "p50", "p95"),
                        prof_dir=None, keep_res=False, triton_only=False, audit=None,
                        prepare=None, launch_count=1, scope_evidence=None):
    """Measure one kernel under device, host and end-to-end timing scopes.

    device:    torch_npu.profiler device Duration(us), per iteration (existing logic)
    host:      perf_counter around one launch, amortized while enqueueing back to back
    endToEnd:  one launch plus device synchronize, the deployment-facing latency

    Returns the per-scope samples with requested statistics and the per-forward launch
    count hint. ``bench_kernel_ms`` remains the device-only compatibility entry point.
    """
    requested = tuple(scopes)
    if not requested or any(scope not in SCOPES for scope in requested) or len(set(requested)) != len(requested):
        raise ValueError(f"scopes must be a nonempty subset of {SCOPES}")
    chosen = tuple(statistics)
    if not chosen or any(name not in STATISTICS for name in chosen) or len(set(chosen)) != len(chosen):
        raise ValueError(f"statistics must be a nonempty subset of {STATISTICS}")
    if not isinstance(launch_count, int) or isinstance(launch_count, bool) or launch_count < 1:
        raise ValueError("launch_count must be a positive integer")

    timing = {}
    if "device" in requested:
        evidence = scope_evidence if scope_evidence is not None else {}
        device_ms = bench_kernel(fn, warmup=warmup, active=repeat, prof_dir=prof_dir,
                                 keep_res=keep_res, triton_only=triton_only, audit=audit,
                                 prepare=prepare, scope_evidence=evidence)
        if not math.isfinite(device_ms) or device_ms <= 0:
            raise RuntimeError("Profiler did not produce a finite positive duration")
        device = _summarize_ms([value / 1e3 for value in evidence["deviceSamplesUs"]], chosen)
        # The profiler reduction stays authoritative for the compatible mean.
        device["meanMs"] = device_ms
        timing["device"] = device
    if "host" in requested:
        timing["host"] = _summarize_ms(_host_samples_ms(fn, prepare, warmup, repeat), chosen)
    if "endToEnd" in requested:
        timing["endToEnd"] = _summarize_ms(_end_to_end_samples_ms(fn, prepare, warmup, repeat), chosen)

    return {
        "timingScope": "triton-kernels" if triton_only else "all-device-kernels",
        "timing": {**timing, "launchCount": launch_count},
        "protocol": {"warmup": warmup, "repeat": repeat,
                     "scopes": list(requested), "statistics": list(chosen),
                     "aggregation": "per-iteration"},
    }


def bench_prepared_kernel_scopes(fn, prepare, **kwargs):
    """Scope measurement for mutable-input kernels; preparation stays outside the timed region."""
    return bench_kernel_scopes(fn, prepare=prepare, **kwargs)
