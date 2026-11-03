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
通用kernel级基准测试模块

NPU: 使用torch_npu.profiler采集kernel_details.csv，读取Duration(us)
GPU: 使用torch.profiler采集CUDA活动，从prof.events()提取self_device_time_us
CPU: 回退到time.perf_counter

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

# ============ 设备检测 ============
IS_NPU = False
try:
    IS_NPU = hasattr(torch, 'npu') and callable(getattr(torch.npu, 'is_available', None)) and torch.npu.is_available()
except Exception:
    IS_NPU = False

IS_GPU = torch.cuda.is_available()

if IS_NPU:
    try:
        import torch_npu  # noqa
    except ImportError:
        IS_NPU = False
        IS_GPU = torch.cuda.is_available()

    def _logical_npu_device_id() -> int:
        requested = os.environ.get("KERNEL_NPU_DEVICE") or os.environ.get("ASCEND_DEVICE_ID") or os.environ.get("DEVICE_ID")
        visible = os.environ.get("ASCEND_RT_VISIBLE_DEVICES") or os.environ.get("ASCEND_VISIBLE_DEVICES")
        if visible:
            visible_ids = [item.strip() for item in visible.split(",") if item.strip()]
            if requested and requested in visible_ids:
                return visible_ids.index(requested)
            return 0
        return int(requested or "0")

    NPU_DEVICE_ID = _logical_npu_device_id()
    DEVICE = f"npu:{NPU_DEVICE_ID}"
    DEVICE_NAME = "NPU"
    torch.npu.set_device(NPU_DEVICE_ID)
elif IS_GPU:
    DEVICE = "cuda:0"
    DEVICE_NAME = "GPU"
else:
    DEVICE = "cpu"
    DEVICE_NAME = "CPU"

print(f"[bench_kernel] Device: {DEVICE_NAME} ({DEVICE})")


def device_synchronize():
    if IS_NPU:
        torch.npu.synchronize()
    elif IS_GPU:
        torch.cuda.synchronize()


# ============ NPU Profiler计时 ============
def _bench_npu_profiler(fn, warmup=5, active=20, prof_dir=None, keep_res=False,
                        triton_only=False):
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
    with torch_npu.profiler.profile(
            activities=[torch_npu.profiler.ProfilerActivity.NPU],
            on_trace_ready=torch_npu.profiler.tensorboard_trace_handler(dir_name=prof_dir_rel),
            record_shapes=False,
            profile_memory=False,
            with_stack=False,
            with_flops=False,
            with_modules=False,
            experimental_config=experimental_config,
    ) as prof:
        for _ in builtins.range(total):
            fn()
            device_synchronize()

    # 从kernel_details.csv采集结果
    if triton_only:
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


# ============ GPU Profiler计时 ============
def _bench_cuda_profiler(fn, warmup=5, active=20):
    """
    GPU: 使用torch.profiler采集CUDA活动
    从prof.events()中提取kernel的self_device_time_us
    返回: 平均kernel执行时间(ms)
    """
    # warmup
    for _ in range(warmup):
        fn()
    device_synchronize()

    total = warmup + active
    with torch.profiler.profile(
            activities=[torch.profiler.ProfilerActivity.CPU, torch.profiler.ProfilerActivity.CUDA],
            record_shapes=False,
            profile_memory=False,
            with_stack=False,
            with_flops=False,
    ) as prof:
        for _ in builtins.range(total):
            fn()
            device_synchronize()

    # 从profiler events提取CUDA kernel时间
    events = prof.key_averages()
    cuda_kernel_times_us = []

    for evt in events:
        if evt.key.startswith("aten::") or evt.key.startswith(
                "triton_") or evt.device_type == torch.profiler.ProfilerActivity.CUDA:
            # device_time 是该kernel自身在设备上的时间(不含子kernel)
            if evt.device_time > 0:
                cuda_kernel_times_us.append(evt.device_time)

    if not cuda_kernel_times_us:
        # 回退: 使用events遍历
        all_events = prof.events()
        for evt in all_events:
            if evt.device_type == torch.profiler.ProfilerActivity.CUDA:
                if evt.device_time > 0:
                    cuda_kernel_times_us.append(evt.device_time)

    if not cuda_kernel_times_us:
        return float("inf")

    # 跳过warmup, 取active的平均
    # 注意: key_averages已经聚合了, 直接用
    avg_us = sum(cuda_kernel_times_us) / len(cuda_kernel_times_us)
    # 估算单次调用时间 = 总时间 / active轮次
    single_call_us = avg_us * len(cuda_kernel_times_us) / active
    # 简化: 直接用平均
    return avg_us / 1e3  # us -> ms


# ============ 通用接口 ============
def bench_kernel(fn, warmup=5, active=20, prof_dir=None, keep_res=False,
                 triton_only=False):
    """
    通用kernel级基准测试

    NPU: torch_npu.profiler -> kernel_details.csv -> Duration(us)
    GPU: torch.profiler -> CUDA events -> device_time
    CPU: time.perf_counter (回退)

    triton_only: NPU 专用，True 时只统计 Triton kernel 耗时（排除 aclnn 框架算子）。
        用于编排器的基准和晋升判断。

    返回: 平均kernel执行时间(ms)
    """
    if IS_NPU:
        return _bench_npu_profiler(fn, warmup=warmup, active=active,
                                   prof_dir=prof_dir, keep_res=keep_res,
                                   triton_only=triton_only)
    elif IS_GPU:
        return _bench_cuda_profiler(fn, warmup=warmup, active=active)
    else:
        # CPU回退
        import time
        for _ in range(warmup):
            fn()
        times = []
        for _ in range(active):
            t0 = time.perf_counter()
            fn()
            t1 = time.perf_counter()
            times.append((t1 - t0) * 1000)
        times.sort()
        return times[len(times) // 2]


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
        torch.npu.set_device(0)
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
