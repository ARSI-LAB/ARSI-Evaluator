"""Run locked kernel evaluation, correctness checks or timing from the stdin protocol."""

from __future__ import annotations

import argparse
import contextlib
from copy import deepcopy
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import random
import sys
import traceback
from types import ModuleType


class CandidateError(Exception):
    """Candidate loading or execution failure, distinct from reference and environment failures."""


def npu_device_id() -> int:
    """Logical NPU index selected by KERNEL_NPU_DEVICE, defaulting to 0."""
    raw = os.environ.get("KERNEL_NPU_DEVICE", "")
    return int(raw) if raw.isdigit() else 0


def load_module(path, name):
    """Load a module from its file without reusing a previous task module with the same name."""
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Cannot load module: {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def verify_hashes(hashes):
    """Reject file changes between source locking and environment copying."""
    for path, expected in hashes.items():
        source = Path(path).absolute()
        if not source.is_file() or any(item.is_symlink() for item in (source, *source.parents)):
            raise RuntimeError(f"Locked source must be a safe regular file: {path}")
        if hashlib.sha256(source.read_bytes()).hexdigest() != expected:
            raise RuntimeError(f"Locked source changed: {path}")


def load_task_module(path, root):
    """Preserve task package structure and sibling imports without renaming declared dependencies."""
    path, root = Path(path).resolve(), Path(root).resolve()
    relative = path.relative_to(root)
    namespace = "_kernel_task_" + hashlib.sha256(str(root).encode()).hexdigest()[:16]
    if namespace not in sys.modules:
        package = ModuleType(namespace)
        package.__path__ = [str(root)]
        sys.modules[namespace] = package
    # Resolve both sibling helpers and packages rooted at the manifest directory.
    sys.path.insert(0, str(root))
    sys.path.insert(0, str(path.parent))
    parent = ".".join([namespace, *relative.parts[:-1]])
    importlib.import_module(parent)
    return load_module(path, f"{parent}.{path.stem}")


def select_outputs(value, indices):
    """Exclude metadata only at explicitly declared task indices; otherwise preserve the full output."""
    if indices is None:
        return value
    if not isinstance(value, (list, tuple)):
        raise ValueError("outputIndices requires a tuple/list output")
    return tuple(value[i] for i in indices)


def clone_tree(value, torch):
    """Copy tensor storage once per tree and retain each view into that storage."""
    memo, storage_copies = {}, {}

    def clone(item):
        if isinstance(item, torch.Tensor):
            if id(item) in memo:
                return memo[id(item)]
            # Detach permits snapshots of non-leaf tensors. PyTorch's deepcopy uses the
            # shared memo for storage as well as objects, including mixed-dtype views.
            result = deepcopy(item.detach(), memo)
            if (result.shape != item.shape or result.stride() != item.stride()
                    or result.storage_offset() != item.storage_offset()
                    or result.dtype != item.dtype or result.device != item.device):
                raise RuntimeError(f"Tensor clone did not preserve view metadata on {item.device}")
            source = item.untyped_storage().data_ptr()
            target = result.untyped_storage().data_ptr()
            if source and (target == source or storage_copies.setdefault((item.device, source), target) != target):
                raise RuntimeError(f"Tensor clone did not preserve shared storage independently on {item.device}")
            memo[id(item)] = result
            return result
        if isinstance(item, tuple):
            return tuple(clone(v) for v in item)
        if isinstance(item, list):
            return [clone(v) for v in item]
        if isinstance(item, dict):
            return {k: clone(v) for k, v in item.items()}
        if item is None or isinstance(item, (bool, int, float, str)):
            return item
        raise TypeError(f"Unsupported value type: {type(item).__name__}")

    return clone(value)


def compare_tree(expected, actual, torch, rtol, atol):
    """Compare all outputs and their structure; reject nonfinite floating-point values."""
    if isinstance(expected, torch.Tensor):
        if not isinstance(actual, torch.Tensor):
            raise AssertionError("Expected tensor output")
        if not bool(torch.isfinite(expected).all()) or not bool(torch.isfinite(actual).all()):
            raise AssertionError("Non-finite tensor output")
        floating = expected.is_floating_point() or expected.is_complex()
        torch.testing.assert_close(actual, expected, rtol=rtol if floating else 0, atol=atol if floating else 0, equal_nan=False)
        return
    if type(expected) is not type(actual):
        raise AssertionError("Output structure/type mismatch")
    if isinstance(expected, float) and (not math.isfinite(expected) or not math.isfinite(actual)):
        raise AssertionError("Non-finite scalar output")
    if isinstance(expected, (list, tuple)):
        if len(expected) != len(actual):
            raise AssertionError("Output length mismatch")
        for left, right in zip(expected, actual):
            compare_tree(left, right, torch, rtol, atol)
    elif isinstance(expected, dict):
        if expected.keys() != actual.keys():
            raise AssertionError("Output keys mismatch")
        for key in expected:
            compare_tree(expected[key], actual[key], torch, rtol, atol)
    elif expected != actual:
        raise AssertionError("Scalar output mismatch")


def validate_reference(value, torch):
    """Validate reference outputs first so reference NaN/Inf values are not blamed on the candidate."""
    if isinstance(value, torch.Tensor):
        if not bool(torch.isfinite(value).all()):
            raise ValueError("Non-finite reference tensor output")
    elif isinstance(value, float):
        if not math.isfinite(value):
            raise ValueError("Non-finite reference scalar output")
    elif isinstance(value, (list, tuple)):
        for item in value:
            validate_reference(item, torch)
    elif isinstance(value, dict):
        for item in value.values():
            validate_reference(item, torch)


def candidate_call(function, inputs):
    """Convert candidate execution exceptions into explicit evaluation failures."""
    try:
        return function(*inputs)
    except Exception as exc:
        raise CandidateError(f"{type(exc).__name__}: {exc}") from exc


def positive_measurement(value):
    """Reject inf/NaN timing values produced by missing profiler data."""
    if not isinstance(value, (float, int)) or not math.isfinite(value) or value <= 0:
        raise RuntimeError("Profiler did not produce a finite positive duration")
    return float(value)


def timing_config(request):
    """Scope and launch-count settings; device timing remains mandatory for candidates."""
    config = request.get("timing") or {}
    scopes = tuple(config.get("scopes") or ("device",))
    statistics = tuple(config.get("statistics") or ("mean", "p50", "p95"))
    launch_count = request.get("launchCount", 1)
    if "device" not in scopes:
        raise ValueError("Candidate timing requires the device scope")
    return scopes, statistics, launch_count


def request_tolerance(request):
    """Resolve the effective tolerance from the request and contract dtype."""
    module = load_module(Path(__file__).with_name("tolerance.py"), "kernel_tolerance")
    config = request.get("tolerance") or {}
    explicit = (request.get("rtol", 0.0), request.get("atol", 0.0))
    frozen = (config.get("rtol", explicit[0]), config.get("atol", explicit[1]))
    return module.resolve_tolerance(request.get("contract"), mode=config.get("mode", "explicit"),
                                    explicit=explicit, frozen=frozen,
                                    safety_factor=config.get("safetyFactor", 10.0))


_ERROR_THRESHOLDS = (("1e-4", 1e-4), ("5e-4", 5e-4), ("1e-3", 1e-3))
_QUANTILE_SAMPLE_LIMIT = 2 ** 24


def _error_parts(expected, actual, torch, parts):
    if isinstance(expected, torch.Tensor):
        if not isinstance(actual, torch.Tensor) or expected.shape != actual.shape or not expected.is_floating_point():
            return
        left = expected.detach().to(torch.float32).reshape(-1)
        if left.numel():
            parts.append((left, actual.detach().to(torch.float32).reshape(-1)))
    elif isinstance(expected, (list, tuple)) and type(expected) is type(actual) and len(expected) == len(actual):
        for left, right in zip(expected, actual):
            _error_parts(left, right, torch, parts)
    elif isinstance(expected, dict) and isinstance(actual, dict) and expected.keys() == actual.keys():
        for key in expected:
            _error_parts(expected[key], actual[key], torch, parts)


def error_stats(expected, actual, torch):
    """Aggregate absolute/relative error over floating tensor leaves.

    Values are reported, not judged: the policy decides whether the distribution is
    acceptable for one tolerance mode or another.
    """
    parts = []
    _error_parts(expected, actual, torch, parts)
    stats = {"count": 0, "maxAbs": 0.0, "maxRel": 0.0,
             **{f"mismatch_gt_{label}": 0.0 for label, _ in _ERROR_THRESHOLDS}}
    if not parts:
        return stats
    abs_values = torch.cat([(right - left).abs() for left, right in parts])
    rel_values = abs_values / torch.cat([left.abs() for left, _ in parts]).clamp_min(1e-12)
    # Quantiles run on the host sample: NPU backends do not guarantee sort/quantile support.
    sample = abs_values[::max(1, -(-abs_values.numel() // _QUANTILE_SAMPLE_LIMIT))].detach().to("cpu")
    stats.update(count=int(abs_values.numel()), maxAbs=float(abs_values.max()), maxRel=float(rel_values.max()),
                 p50Abs=float(torch.quantile(sample, 0.5)),
                 p90Abs=float(torch.quantile(sample, 0.9)),
                 p99Abs=float(torch.quantile(sample, 0.99)))
    for label, threshold in _ERROR_THRESHOLDS:
        stats[f"mismatch_gt_{label}"] = float((abs_values > threshold).to(torch.float32).mean())
    return stats


def bench(request, profile_root):
    """Time candidate Triton kernels with seeded inputs, without reference execution."""
    verify_hashes(request["hashes"])
    import torch
    import torch_npu  # noqa: F401

    if not torch.npu.is_available():
        raise RuntimeError("NPU is required; CPU/GPU fallback is disabled")
    device = npu_device_id()
    torch.npu.set_device(device)
    problem = load_task_module(request["problem"], request["dataRoot"])
    try:
        candidate = load_task_module(request["candidate"], request["candidateRoot"]).kernel_function
        if not callable(candidate):
            raise TypeError("kernel_function must be callable")
    except Exception as exc:
        raise CandidateError(f"{type(exc).__name__}: {exc}") from exc
    timer = load_module(Path(__file__).with_name("timing.py"), "kernel_timer")
    scopes, statistics, launch_count = timing_config(request)
    with torch.inference_mode():
        seed = request["seeds"][0]
        random.seed(seed)
        torch.manual_seed(seed)
        torch.npu.manual_seed_all(seed)
        inputs = problem.get_inputs()
        if not isinstance(inputs, (list, tuple)):
            raise TypeError("get_inputs must return a positional argument list")
        inputs = clone_tree(inputs, torch)
        options = dict(warmup=request["warmup"], active=request["repeat"],
                       prof_dir=str(profile_root / "profile-candidate"), keep_res=True, triton_only=True,
                       scopes=scopes, statistics=statistics, launch_count=launch_count)
        if request.get("contract", {}).get("inputUnmodified", True):
            measured = timer.bench_kernel_scopes(lambda: candidate_call(candidate, inputs), **options)
        else:
            audit = {}
            measured = timer.bench_prepared_kernel_scopes(lambda trial: candidate_call(candidate, trial),
                lambda: clone_tree(inputs, torch), audit=audit, **options)
            if audit.get("stepLayout") != "prepare-then-run":
                raise RuntimeError("Mutable-input timer must emit prepare-then-run timing evidence")
        candidate_ms = positive_measurement(measured["timing"]["device"]["meanMs"])
    verify_hashes(request["hashes"])
    return {"status": "completed", "error": "", "candidateMs": candidate_ms,
            "timing": measured["timing"], "timingScope": measured["timingScope"],
            "launchCount": measured["timing"]["launchCount"]}


def evaluate(request, profile_root=Path(".")):
    """Run evaluation by default, correctness only, or candidate-only timing."""
    operation = request.get("operation", "evaluate")
    if operation == "bench":
        return bench(request, profile_root)
    if operation not in ("evaluate", "precision"):
        raise ValueError(f"Unsupported kernel operation: {operation}")
    if "contract" in request:
        strict = load_module(Path(__file__).with_name("strict.py"), "kernel_strict")
        return strict.evaluate(request, profile_root, globals())
    verify_hashes(request["hashes"])
    import torch
    import torch_npu  # noqa: F401

    if not torch.npu.is_available():
        raise RuntimeError("NPU is required; CPU/GPU fallback is disabled")
    # The environment binds visible devices; --device / KERNEL_NPU_DEVICE selects a logical device within that set.
    device = npu_device_id()
    torch.npu.set_device(device)
    problem = load_task_module(request["problem"], request["dataRoot"])
    candidate_root = request["candidateRoot"]
    try:
        candidate = load_task_module(request["candidate"], candidate_root).kernel_function
        if not callable(candidate):
            raise TypeError("kernel_function must be callable")
    except Exception as exc:
        raise CandidateError(f"{type(exc).__name__}: {exc}") from exc

    reference = None
    timing_inputs = None
    tolerance = request_tolerance(request)
    error_evidence = None
    with torch.inference_mode():
        for seed in request["seeds"]:
            random.seed(seed)
            torch.manual_seed(seed)
            torch.npu.manual_seed_all(seed)
            init = problem.get_init_inputs() if hasattr(problem, "get_init_inputs") else []
            reference = problem.Model(*init).to(f"npu:{device}").eval()
            inputs = problem.get_inputs()
            if not isinstance(inputs, (list, tuple)):
                raise TypeError("get_inputs must return a positional argument list")
            ref_inputs = clone_tree(inputs, torch)
            expected = clone_tree(select_outputs(reference(*ref_inputs), request["outputIndices"]), torch)
            torch.npu.synchronize()
            validate_reference(expected, torch)
            compare_tree(inputs, ref_inputs, torch, 0, 0)
            # Repeat in the same process to catch autotune succeeding once but leaving later outputs incomplete.
            for _ in range(2):
                trial = clone_tree(inputs, torch)
                actual = candidate_call(candidate, trial)
                try:
                    torch.npu.synchronize()
                except Exception as exc:
                    raise CandidateError(str(exc)) from exc
                outputs = select_outputs(actual, request["outputIndices"])
                error_evidence = error_stats(expected, outputs, torch)
                try:
                    compare_tree(expected, outputs, torch, tolerance["rtol"], tolerance["atol"])
                    compare_tree(inputs, trial, torch, 0, 0)
                except (AssertionError, ValueError, IndexError) as exc:
                    return {"status": "incorrect", "error": str(exc),
                            "tolerance": tolerance, "errorStats": error_evidence}
            timing_inputs = inputs

        if reference is None or timing_inputs is None:
            raise RuntimeError("No correctness cases executed")
        if operation == "precision":
            verify_hashes(request["hashes"])
            return {"status": "passed", "error": "", "tolerance": tolerance, "errorStats": error_evidence}
        timer = load_module(Path(__file__).with_name("timing.py"), "kernel_timer")
        scopes, statistics, launch_count = timing_config(request)
        reference_ms = positive_measurement(timer.bench_kernel_ms(
            lambda: reference(*timing_inputs), warmup=request["warmup"], active=request["repeat"],
            prof_dir=str(profile_root / "profile-reference"), keep_res=True, triton_only=False,
        ))
        measured = timer.bench_kernel_scopes(
            lambda: candidate_call(candidate, timing_inputs), warmup=request["warmup"], active=request["repeat"],
            prof_dir=str(profile_root / "profile-candidate"), keep_res=True, triton_only=False,
            scopes=scopes, statistics=statistics, launch_count=launch_count,
        )
        candidate_ms = positive_measurement(measured["timing"]["device"]["meanMs"])
        result = {"status": "passed", "error": "", "referenceMs": reference_ms,
                  "candidateMs": candidate_ms, "speedup": positive_measurement(reference_ms / candidate_ms),
                  "timing": measured["timing"], "timingScope": measured["timingScope"],
                  "launchCount": measured["timing"]["launchCount"],
                  "tolerance": tolerance, "errorStats": error_evidence}
        # TypeScript owns detailed profiling (adapters/kernel/profile.ts / evaluator kernel profile).
        # This acceptance path records profiling.enabled only as requested; the TypeScript
        # kernelVerdict supplies an explicit failed fallback rather than invoking a missing profiling worker.
        verify_hashes(request["hashes"])
        return result


@contextlib.contextmanager
def native_output(log):
    """Capture CANN/C++ writes to file descriptors as well, keeping logs out of the JSON channel."""
    sys.stdout.flush()
    sys.stderr.flush()
    saved = [os.dup(1), os.dup(2)]
    try:
        os.dup2(log.fileno(), 1)
        os.dup2(log.fileno(), 2)
        with contextlib.redirect_stdout(log), contextlib.redirect_stderr(log):
            yield
    finally:
        log.flush()
        for fd, backup in zip((1, 2), saved):
            os.dup2(backup, fd)
            os.close(backup)



def main():
    """Run the requested kernel operation and emit one finite JSON result."""
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    request = json.load(sys.stdin)
    operation = request.get("operation", "evaluate")
    result = {"operation": operation, "candidateSha256": request["candidateSha256"],
              "referenceKind": request["referenceKind"],
              "timingScope": "triton-kernels" if operation == "bench" else "all-device-kernels",
              "referenceMs": None, "candidateMs": None, "speedup": None}
    if "contract" in request and operation != "bench":
        strict = load_module(Path(__file__).with_name("strict.py"), "kernel_strict")
        result["assessment"] = strict.new_assessment(request)
        request["_assessment"] = result["assessment"]
    # Route external profiler output to diagnostics rather than the result channel.
    with output.with_suffix(".log").open("w") as log, native_output(log):
        try:
            result.update(evaluate(request, output.parent))
        except CandidateError as exc:
            traceback.print_exc()
            result.update(status="candidate_error", error=str(exc))
        except Exception as exc:
            traceback.print_exc()
            result.update(status="infrastructure_error", error=f"{type(exc).__name__}: {exc}")
            if "assessment" in result:
                result["assessment"]["errorOwnership"] = "evaluation"
    try:
        verify_hashes(request["hashes"])
    except Exception as exc:
        result.update(status="infrastructure_error", error=f"Locked source validation failed: {exc}",
                      referenceMs=None, candidateMs=None, speedup=None)
        if "assessment" in result:
            result["assessment"]["errorOwnership"] = "evaluation"
    encoded = json.dumps(result, allow_nan=False)
    temp = output.with_suffix(".tmp")
    temp.write_text(encoded + "\n")
    os.replace(temp, output)
    sys.stdout.write(encoded + "\n")


if __name__ == "__main__":
    sys.exit(main())
