"""Tolerance resolution and error statistics without an accelerator (no torch, no numpy)."""

import importlib.util
import math
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import patch

root = Path(__file__).resolve().parents[2]
RUNTIME = root / "src/plugins/benchmarks/operator/kernel/runtime"


def load_runtime(name):
    spec = importlib.util.spec_from_file_location(f"kernel_{name}_under_test", RUNTIME / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class FakeTensor:
    """Minimal elementwise tensor facade for exercising error_stats without torch."""

    def __init__(self, values, shape=None, floating=True):
        self.values = list(values)
        self.shape = tuple(shape if shape is not None else (len(self.values),))
        self.floating = floating

    def is_floating_point(self):
        return self.floating

    def detach(self):
        return self

    def to(self, *_args):
        return self

    def reshape(self, *_shape):
        return self

    def numel(self):
        return len(self.values)

    def abs(self):
        return FakeTensor([abs(value) for value in self.values])

    def clamp_min(self, minimum):
        return FakeTensor([max(value, minimum) for value in self.values])

    def max(self):
        return max(self.values)

    def mean(self):
        return sum(self.values) / len(self.values) if self.values else 0.0

    def __sub__(self, other):
        return FakeTensor([left - right for left, right in zip(self.values, other.values)])

    def __truediv__(self, other):
        if isinstance(other, FakeTensor):
            return FakeTensor([left / right for left, right in zip(self.values, other.values)])
        return FakeTensor([value / other for value in self.values])

    def __gt__(self, threshold):
        return FakeTensor([1.0 if value > threshold else 0.0 for value in self.values])

    def __getitem__(self, item):
        return FakeTensor(self.values[item])


def _quantile(tensor, q):
    data = sorted(tensor.values)
    if not data:
        return 0.0
    position = q * (len(data) - 1)
    lower, upper = math.floor(position), math.ceil(position)
    return data[lower] + (data[upper] - data[lower]) * (position - lower)


TORCH = types.SimpleNamespace(
    Tensor=FakeTensor, float32="float32",
    cat=lambda items: FakeTensor([value for item in items for value in item.values]),
    quantile=_quantile)


class ToleranceResolutionTest(unittest.TestCase):
    def setUp(self):
        self.tolerance = load_runtime("tolerance")

    def resolve(self, **kwargs):
        return self.tolerance.resolve_tolerance(**kwargs)

    def test_explicit_pair_is_carried_verbatim(self):
        self.assertEqual(self.resolve(mode="explicit", explicit=(1e-3, 2e-3)),
                         {"mode": "explicit", "rtol": 1e-3, "atol": 2e-3, "source": "explicit"})

    def test_dtype_table_covers_fused_float_and_integer_outputs(self):
        cases = {
            "float16": (1e-3, 1e-3), "torch.bfloat16": (1e-3, 1e-3),
            "fp32": (5e-4, 5e-4), "float64": (1e-6, 1e-6), "int64": (0.0, 0.0),
        }
        for dtype, (rtol, atol) in cases.items():
            with self.subTest(dtype=dtype):
                contract = {"output": {"dtype": dtype}}
                self.assertEqual(self.resolve(mode="dtype", contract=contract),
                                 {"mode": "dtype", "rtol": rtol, "atol": atol,
                                  "source": f"contract.output.dtype={self.tolerance.normalize_dtype(dtype)}"})

    def test_unknown_dtype_falls_back_to_float32_and_missing_contract_is_rejected(self):
        self.assertEqual(self.resolve(mode="dtype", contract={"output": {"dtype": "float8_e4m3fn"}})["rtol"], 5e-4)
        with self.assertRaises(ValueError):
            self.resolve(mode="dtype", contract=None)

    def test_frozen_pair_comes_from_the_preflight(self):
        self.assertEqual(self.resolve(mode="frozen", frozen=(0.01, 0.02)),
                         {"mode": "frozen", "rtol": 0.01, "atol": 0.02, "source": "frozen"})
        with self.assertRaises(ValueError):
            self.resolve(mode="frozen")

    def test_observed_scales_the_measured_distribution_by_the_safety_factor(self):
        resolved = self.resolve(mode="observed", observed={"maxAbs": 0.002, "maxRel": 1e-4}, safety_factor=10)
        self.assertEqual(resolved, {"mode": "observed", "rtol": 1e-3, "atol": 0.02,
                                    "source": "observed*safetyFactor=10", "observedMaxAbs": 0.002})
        with self.assertRaises(ValueError):
            self.resolve(mode="observed")
        with self.assertRaises(ValueError):
            self.resolve(mode="observed", observed={"maxAbs": 0.1}, safety_factor=-1)

    def test_invalid_modes_and_negative_values_are_rejected(self):
        for kwargs in ({"mode": "loose"}, {"mode": "explicit", "explicit": (-1, 0)},
                       {"mode": "explicit", "explicit": (True, 0)},
                       {"mode": "explicit", "explicit": (math.inf, 0)}):
            with self.subTest(kwargs=kwargs), self.assertRaises(ValueError):
                self.resolve(**kwargs)


class RequestToleranceTest(unittest.TestCase):
    def setUp(self):
        self.precision = load_runtime("precision")

    def request(self, **overrides):
        request = {"rtol": 0.1, "atol": 0.2,
                   "contract": {"output": {"dtype": "float16"}}, "tolerance": {"mode": "dtype"}}
        request.update(overrides)
        return request

    def test_request_resolution_uses_the_contract_dtype(self):
        self.assertEqual(self.precision.request_tolerance(self.request()),
                         {"mode": "dtype", "rtol": 1e-3, "atol": 1e-3, "source": "contract.output.dtype=float16"})

    def test_request_resolution_honours_explicit_and_frozen_config(self):
        explicit = self.precision.request_tolerance(self.request(tolerance={"mode": "explicit"}))
        self.assertEqual((explicit["rtol"], explicit["atol"]), (0.1, 0.2))
        frozen = self.precision.request_tolerance(
            self.request(tolerance={"mode": "frozen", "rtol": 0.01, "atol": 0.02}))
        self.assertEqual((frozen["rtol"], frozen["atol"], frozen["source"]), (0.01, 0.02, "frozen"))


class ErrorStatsTest(unittest.TestCase):
    def setUp(self):
        self.precision = load_runtime("precision")

    def stats(self, expected, actual):
        return self.precision.error_stats(expected, actual, TORCH)

    def test_identical_outputs_report_zero_error(self):
        stats = self.stats(FakeTensor([1.0, 2.0, 3.0]), FakeTensor([1.0, 2.0, 3.0]))
        self.assertEqual(stats["count"], 3)
        for key in ("maxAbs", "maxRel", "p50Abs", "p90Abs", "p99Abs",
                    "mismatch_gt_1e-4", "mismatch_gt_5e-4", "mismatch_gt_1e-3"):
            self.assertEqual(stats[key], 0.0, key)

    def test_absolute_relative_and_mismatch_fractions_are_aggregated(self):
        stats = self.stats(FakeTensor([1.0, 2.0, 0.0]), FakeTensor([1.1, 2.0, 0.0]))
        self.assertEqual(stats["count"], 3)
        self.assertAlmostEqual(stats["maxAbs"], 0.1)
        self.assertAlmostEqual(stats["maxRel"], 0.1)
        for label in ("1e-4", "5e-4", "1e-3"):
            self.assertAlmostEqual(stats[f"mismatch_gt_{label}"], 1 / 3)

    def test_nested_outputs_aggregate_float_leaves_and_skip_other_values(self):
        expected = {"a": FakeTensor([1.0, 2.0]), "b": [FakeTensor([3.0]), "label"]}
        actual = {"a": FakeTensor([1.05, 2.0]), "b": [FakeTensor([3.0]), "label"]}
        stats = self.stats(expected, actual)
        self.assertEqual(stats["count"], 3)
        self.assertAlmostEqual(stats["maxAbs"], 0.05)

    def test_mismatched_shapes_and_nonfloating_outputs_contribute_no_evidence(self):
        self.assertEqual(self.stats(FakeTensor([1.0, 2.0]), FakeTensor([1.0], shape=(1,)))["count"], 0)
        self.assertEqual(self.stats(FakeTensor([1, 2], floating=False), FakeTensor([1, 3]))["count"], 0)
        self.assertEqual(self.stats("scalar", "scalar")["count"], 0)

    def test_quantile_evidence_is_sampled_but_maxima_stay_exact(self):
        expected, actual = FakeTensor([0.0] * 4), FakeTensor([0.1, 0.2, 0.3, 0.4])
        with patch.object(self.precision, "_QUANTILE_SAMPLE_LIMIT", 2):
            stats = self.stats(expected, actual)
        self.assertAlmostEqual(stats["maxAbs"], 0.4)
        self.assertAlmostEqual(stats["p50Abs"], 0.2)
        self.assertAlmostEqual(stats["p90Abs"], 0.28)
        self.assertAlmostEqual(stats["p99Abs"], 0.298)


if __name__ == "__main__":
    unittest.main()
