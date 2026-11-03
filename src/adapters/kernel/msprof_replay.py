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

"""msprof 采集目标：加载候选算子并重放（唯一被 msprof 进程 attach 的 py）。

采集编排、CSV 解析、缓存与物理量分析全部在 Evaluator TS 层
（src/plugins/benchmarks/protocols/kernel/）；本文件只负责
「把算子跑起来」这一必须持有 torch/triton 运行时的事。
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import random
import sys

from precision import load_module, load_task_module, verify_hashes


def replay(request):
    """在指定逻辑 NPU 重放候选（KERNEL_NPU_DEVICE 选卡，缺省 0）；不推断 dtype、不额外拼接模型参数。"""
    verify_hashes(request["hashes"])
    import torch
    import torch_npu  # noqa: F401  (registers the npu backend, required on Ascend)

    if not torch.npu.is_available():
        raise RuntimeError("NPU is required for detailed profiling")
    raw = os.environ.get("KERNEL_NPU_DEVICE", "")
    device = int(raw) if raw.isdigit() else 0
    torch.npu.set_device(device)
    problem = load_task_module(request["problem"], request["dataRoot"], "problem")
    try:
        candidate = load_task_module(request["candidate"], request["dataRoot"], "kernel").kernel_function
    except ValueError:
        # 协议锁形态要求候选在 dataRoot 子路径下；原子形态（problem 与 kernel 不同树）
        # 退回按路径直载，语义不变（同 file location 导入）。
        candidate = load_module(request["candidate"], "kernel_msprof_kernel").kernel_function
    if not callable(candidate):
        raise TypeError("kernel_function must be callable")
    seed = request["seeds"][-1]
    with torch.inference_mode():
        random.seed(seed)
        torch.manual_seed(seed)
        torch.npu.manual_seed_all(seed)
        init = problem.get_init_inputs() if hasattr(problem, "get_init_inputs") else []
        # 构造参考可能消耗 RNG，须与 precision.evaluate 的 get_inputs 前置步骤一致。
        reference = problem.Model(*init).to(f"npu:{device}").eval()
        inputs = problem.get_inputs()
        if not isinstance(inputs, (tuple, list)):
            raise TypeError("get_inputs must return a positional argument list")
        for _ in range(max(request["warmup"], 1)):
            candidate(*inputs)
        torch.npu.synchronize()
        candidate(*inputs)
        torch.npu.synchronize()
        del reference
    verify_hashes(request["hashes"])
    return {"seed": seed, "logicalDevice": device, "deviceName": torch.npu.get_device_name(device),
            "warmup": max(request["warmup"], 1), "inputContract": "unchanged problem.get_inputs"}


def main():
    parser = argparse.ArgumentParser(prog="msprof_replay")
    parser.add_argument("--request", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    result = replay(json.loads(Path(args.request).read_text(encoding="utf-8")))
    Path(args.output).write_text(json.dumps(result, allow_nan=False), encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
