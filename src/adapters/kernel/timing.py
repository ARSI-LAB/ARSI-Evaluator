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
NPU kernel 级基准测试模块

NPU: 使用torch_npu.profiler采集kernel_details.csv，读取Duration(us)

这是最精确的设备侧计时方式，不包含CPU launch时延。
"""

import builtins
import json
import os
import shutil
import sys
import traceback
from datetime import datetime, timezone
from pathlib import Path

import torch

# Explicit NPU execution: never probe CUDA or substitute CPU timing.
import torch_npu

# Explicit backend identity consumed by precision.py, including external timers.
IS_NPU = True


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


# ============ NPU Profiler计时 ============
def _bench_npu_profiler(fn, warmup=5, active=20, prof_dir=None, keep_res=False,
                        triton_only=False, audit=None):
    """
    NPU: 使用torch_npu.profiler采集kernel_details.csv
    返回: 平均kernel执行时间(ms)

    triton_only=True: 只统计 Triton kernel 耗时，排除 aclnn 框架算子。
        用于编排器的基准和晋升判断。
    triton_only=False: 统计 wrapper 内所有算子总耗时。
        用于 eager/inductor 基准的日志展示。
    """
    # warmup
    for _ in range(warmup):
        fn()
    device_synchronize()

    # profiler配置
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
        options['schedule'] = torch_npu.profiler.schedule(wait=0, warmup=0, active=total, repeat=1)
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
            fn()
            device_synchronize()
            if audit is not None:
                prof.step()

    # Strict callers require explicit flow association; no equal-row-count fallback.
    if audit is not None:
        from timing_evidence import collect_flow_timing
        audit.update(collect_flow_timing(prof_dir, warmup, active))
        time_cost_ms = audit['meanMs']
    elif triton_only:
        time_cost_ms = _collect_npu_prof_triton_only(prof_dir, warmup, active)
    else:
        time_cost_ms = _collect_npu_prof_result(prof_dir, warmup, active)

    # 清理
    if not keep_res and os.path.exists(prof_dir):
        shutil.rmtree(prof_dir, ignore_errors=True)

    return time_cost_ms


def _collect_npu_prof_result(base_dir, num_warmup, num_active):
    """汇总每轮全部设备算子耗时，保留真实归约；缺失或损坏的记录不生成分数。"""
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
                # 全部设备算子计时不按 Type 排除归约；非有限值也不能被求和静默忽略。
                if not math.isfinite(duration) or duration < 0:
                    return float("inf")
                durations.append(duration)
    except (csv.Error, TypeError, ValueError):
        return float("inf")

    total_iters = num_warmup + num_active
    if not durations or len(durations) % total_iters != 0:
        return float("inf")

    # 固定输入的同一图每轮具有相同记录数，跳过采集范围内的预热迭代。
    rows_per_iter = len(durations) // total_iters
    active_durations = durations[num_warmup * rows_per_iter:]
    avg_us = math.fsum(active_durations) / num_active
    return avg_us / 1e3 if math.isfinite(avg_us) and avg_us > 0 else float("inf")


def _collect_npu_prof_triton_only(base_dir, num_warmup, num_active):
    """从kernel_details.csv只采集 Triton kernel 的 Duration(us)，返回ms

    过滤掉 aclnn 前缀的框架算子（MatMulV3, Transpose, BatchMatMulV3 等），
    只保留 Triton 编译生成的 kernel（Name 不以 'aclnn' 开头）的耗时。

    这是编排器用于基准和晋升判断的唯一计时口径。
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

    # 过滤ReduceSum(L2 cache clearing)
    if "Type" in df.columns:
        df = df[~df["Type"].str.contains(r"^ReduceSum$", case=False, na=False)]

    # 只保留 Triton kernel：Name 不以 'aclnn' 开头
    if "Name" in df.columns:
        df = df[~df["Name"].str.startswith("aclnn", na=False)]

    total_iters = num_warmup + num_active
    if total_iters <= 0 or len(df) % total_iters != 0:
        print(
            f"[bench_kernel] WARNING: kernel_details 行数({len(df)}) "
            f"不是 model 推理次数({total_iters})的整数倍，无法按迭代切分"
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
                 triton_only=False, audit=None):
    """NPU profiler duration in ms; triton_only excludes framework kernels."""
    if not torch.npu.is_available():
        raise RuntimeError("NPU is required; CPU/GPU fallback is disabled")
    torch.npu.set_device(_logical_npu_device_id())
    return _bench_npu_profiler(fn, warmup=warmup, active=active,
                               prof_dir=prof_dir, keep_res=keep_res,
                               triton_only=triton_only, audit=audit)


def bench_kernel_ms(fn, **kwargs):
    """返回ms, 与time_with_triton_do_bench保持一致: 返回list[float](单元素均值列表)"""
    return bench_kernel(fn, **kwargs)


def bench_kernel_us(fn, **kwargs):
    """返回微秒(us)"""
    return bench_kernel(fn, **kwargs) * 1000


# ---------------- bench 原子入口（CLI：timing --problem --kernel --out） ----------------
# 纯计时，不做精度比对（kernel benchmark_kernel 口径：warmup+active 设备侧计时）。
def _bench_atom_main():
    import argparse

    import torch
    import torch_npu  # noqa: F401

    parser = argparse.ArgumentParser(prog="timing")
    parser.add_argument("--problem", required=True)
    parser.add_argument("--kernel", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--warmup", type=int, default=25)
    parser.add_argument("--repeat", type=int, default=100)
    args = parser.parse_args()
    payload = {"problem": args.problem, "kernel": args.kernel, "time_ms": None, "error": ""}
    out_path = Path(args.out)
    try:
        if not torch.npu.is_available():
            raise RuntimeError("NPU is required; CPU/GPU fallback is disabled")
        torch.npu.set_device(_logical_npu_device_id())
        from precision import CandidateError, clone_tree, load_module, load_task_module

        problem = load_task_module(args.problem, str(Path(args.problem).resolve().parent), "problem")
        kernel_mod = load_module(args.kernel, "kernel_atom_kernel")
        candidate = kernel_mod.kernel_function
        if not callable(candidate):
            raise CandidateError("kernel_function must be callable")
        inputs = problem.get_inputs()
        if not isinstance(inputs, (list, tuple)):
            raise TypeError("get_inputs must return a positional argument list")
        inputs = tuple(clone_tree(inputs, torch))
        with torch.inference_mode():
            ms = bench_kernel_ms(
                lambda: candidate(*inputs), warmup=args.warmup, active=args.repeat,
                prof_dir=None, keep_res=False, triton_only=True,
            )
        if ms is None or ms != ms or ms == float("inf") or ms <= 0:
            payload["error"] = "bench did not produce a finite positive duration"
        else:
            payload["time_ms"] = float(ms)
    except CandidateError as exc:
        payload["error"] = str(exc)[:4000]
    except Exception as exc:  # noqa: BLE001 - 业务失败留证据不退非零
        traceback.print_exc()
        payload["error"] = f"{type(exc).__name__}: {exc}"[:4000]
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(payload, ensure_ascii=False) + "\n", encoding="utf-8")
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")


if __name__ == "__main__":
    _bench_atom_main()
