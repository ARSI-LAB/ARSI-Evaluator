"""Scope timing helpers: per-iteration device samples and host/end-to-end statistics (no NPU)."""

import importlib.util
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

root = Path(__file__).resolve().parents[2]
RUNTIME = root / "src/plugins/benchmarks/operator/kernel/runtime"

HEADER = "Step Id,Device_id,Stream ID,Name,Start Time(us),Duration(us),Type\n"


def load_timer():
    torch = types.SimpleNamespace(
        npu=types.SimpleNamespace(is_available=lambda: True, set_device=lambda _: None, synchronize=lambda: None),
        cuda=types.SimpleNamespace(is_available=lambda: False))
    with patch.dict(sys.modules, {"torch": torch, "torch_npu": types.SimpleNamespace()}):
        spec = importlib.util.spec_from_file_location("kernel_timer_scopes", RUNTIME / "timing.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
    return module


class IterationTotalsTest(unittest.TestCase):
    def collect(self, rows, warmup, active, triton_only=False):
        timer = load_timer()
        with tempfile.TemporaryDirectory() as tmp:
            (Path(tmp) / "kernel_details.csv").write_text(HEADER + "".join(rows))
            return timer._iteration_totals_us(tmp, warmup, active, triton_only=triton_only)

    def test_sums_all_device_kernels_per_iteration_and_skips_warmup(self):
        rows = ["0,0,1,k,0,10,AI_CORE\n", "0,0,1,k2,10,5,AI_CORE\n",
                "1,0,1,k,100,20,AI_CORE\n", "1,0,1,k2,120,7,AI_CORE\n",
                "2,0,1,k,200,30,AI_CORE\n", "2,0,1,k2,230,3,AI_CORE\n"]
        self.assertEqual(self.collect(rows, 1, 2), [27.0, 33.0])

    def test_triton_only_excludes_framework_and_reduction_rows(self):
        rows = ["0,0,1,aclnnMatMul,0,100,AI_CORE\n", "0,0,1,clearL2,100,50,ReduceSum\n",
                "0,0,1,triton_kernel,150,20,AI_CORE\n",
                "1,0,1,aclnnMatMul,200,100,AI_CORE\n", "1,0,1,triton_kernel,300,40,AI_CORE\n"]
        self.assertEqual(self.collect(rows, 0, 2, triton_only=True), [20.0, 40.0])

    def test_rejects_incomplete_or_nonfinite_evidence(self):
        with self.assertRaises(ValueError):
            self.collect(["0,0,1,k,0,10,AI_CORE\n", "1,0,1,k,100,nan,AI_CORE\n"], 0, 2)
        with self.assertRaises(ValueError):
            self.collect(["0,0,1,k,0,10,AI_CORE\n", "1,0,1,k,100,10,AI_CORE\n", "2,0,1,k,200,10,AI_CORE\n"], 0, 2)


class StatisticsTest(unittest.TestCase):
    def test_nearest_rank_percentiles_and_requested_outputs(self):
        timer = load_timer()
        summary = timer._summarize_ms([1.0, 2.0, 3.0, 4.0], ("mean", "p50", "p95"))
        self.assertEqual(summary["meanMs"], 2.5)
        self.assertEqual(summary["p50Ms"], 2.0)
        self.assertEqual(summary["p95Ms"], 4.0)
        self.assertEqual(summary["count"], 4)
        self.assertEqual(summary["samples"], [1.0, 2.0, 3.0, 4.0])
        minimal = timer._summarize_ms([1.0, 3.0], ("mean",))
        self.assertEqual(minimal["meanMs"], 2.0)
        self.assertNotIn("p50Ms", minimal)
        self.assertNotIn("p95Ms", minimal)


class ScopeBenchmarkTest(unittest.TestCase):
    def timer(self):
        timer = load_timer()
        clock = {"value": 0}

        def perf_counter():
            clock["value"] += 1
            return clock["value"] / 1e3

        def fake_bench(fn, scope_evidence=None, **_kwargs):
            self.assertIsNotNone(scope_evidence)
            scope_evidence["deviceSamplesUs"] = [400.0, 600.0, 500.0]
            return 0.5

        timer.bench_kernel = fake_bench
        timer.device_synchronize = lambda: None
        timer.time = types.SimpleNamespace(perf_counter=perf_counter)
        return timer

    def test_collects_scope_statistics_and_launch_count(self):
        timer = self.timer()
        result = timer.bench_kernel_scopes(lambda: None, warmup=1, repeat=3,
                                           scopes=("device", "host", "endToEnd"),
                                           statistics=("mean", "p50", "p95"), launch_count=4)
        self.assertEqual(result["timingScope"], "all-device-kernels")
        self.assertEqual(result["timing"]["launchCount"], 4)
        self.assertEqual(result["timing"]["device"]["meanMs"], 0.5)
        self.assertEqual(result["timing"]["device"]["p50Ms"], 0.5)
        self.assertEqual(result["timing"]["device"]["p95Ms"], 0.6)
        self.assertEqual(result["timing"]["host"]["count"], 3)
        self.assertEqual(result["timing"]["endToEnd"]["count"], 3)
        self.assertEqual(result["protocol"], {"warmup": 1, "repeat": 3, "scopes": ["device", "host", "endToEnd"],
                                             "statistics": ["mean", "p50", "p95"], "aggregation": "per-iteration"})

    def test_device_only_skips_host_scopes_and_validates_arguments(self):
        timer = self.timer()
        result = timer.bench_kernel_scopes(lambda: None, warmup=1, repeat=2, scopes=("device",))
        self.assertEqual(list(result["timing"]), ["device", "launchCount"])
        for scopes in ((), ("device", "device"), ("gpu",)):
            with self.subTest(scopes=scopes), self.assertRaises(ValueError):
                timer.bench_kernel_scopes(lambda: None, repeat=1, scopes=scopes)
        with self.assertRaises(ValueError):
            timer.bench_kernel_scopes(lambda: None, repeat=1, launch_count=0)


if __name__ == "__main__":
    unittest.main()
