"""Tolerance resolution primitives for kernel evaluation.

No accelerator import is performed here: the evaluator reports error statistics and a
resolution provenance, while the experiment policy decides whether to freeze a value.
"""

import math

# Dtype defaults reflect achievable fused-kernel accuracy, not a blanket 1e-6.
DTYPE_TOLERANCES = {
    "float16": (1e-3, 1e-3),
    "bfloat16": (1e-3, 1e-3),
    "float32": (5e-4, 5e-4),
    "float64": (1e-6, 1e-6),
    "int64": (0.0, 0.0),
    "int32": (0.0, 0.0),
    "int16": (0.0, 0.0),
    "int8": (0.0, 0.0),
}
DTYPE_ALIASES = {"fp16": "float16", "half": "float16", "bf16": "bfloat16",
                 "fp32": "float32", "float": "float32", "fp64": "float64", "double": "float64"}
MODES = ("explicit", "dtype", "observed", "frozen")


def normalize_dtype(value):
    if not isinstance(value, str):
        return None
    name = value.strip().lower()
    if name.startswith("torch."):
        name = name[len("torch."):]
    return DTYPE_ALIASES.get(name, name)


def _nonnegative(value, name):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0:
        raise ValueError(f"{name} must be finite and nonnegative")
    return float(value)


def resolve_tolerance(contract=None, mode="explicit", explicit=None, observed=None,
                      frozen=None, safety_factor=10.0):
    """Resolve rtol/atol with provenance.

    explicit: use the given pair (config rtol/atol).
    dtype:    pick the output dtype default from the contract.
    observed: derive from an incumbent/reference error distribution times safetyFactor.
    frozen:   use the experiment-level pair persisted by the policy preflight.
    """
    if mode not in MODES:
        raise ValueError(f"tolerance mode must be one of {MODES}")
    output = contract.get("output") if isinstance(contract, dict) else None
    dtype = normalize_dtype(output.get("dtype") if isinstance(output, dict) else None)
    observed_max = observed.get("maxAbs") if isinstance(observed, dict) else None
    if mode == "explicit":
        rtol, atol = (0.0, 0.0) if explicit is None else explicit
        source = "explicit"
    elif mode == "dtype":
        if dtype is None:
            raise ValueError("dtype tolerance mode requires a contract output dtype")
        rtol, atol = DTYPE_TOLERANCES.get(dtype, DTYPE_TOLERANCES["float32"])
        source = f"contract.output.dtype={dtype}"
    elif mode == "frozen":
        if frozen is None:
            raise ValueError("frozen tolerance mode requires rtol and atol")
        rtol, atol = frozen
        source = "frozen"
    else:
        if not isinstance(observed, dict) or observed_max is None:
            raise ValueError("observed tolerance mode requires an observed error maxAbs/maxRel")
        factor = _nonnegative(safety_factor, "safetyFactor")
        rtol = _nonnegative(observed.get("maxRel", 0.0), "observed.maxRel") * factor
        atol = _nonnegative(observed_max, "observed.maxAbs") * factor
        source = f"observed*safetyFactor={factor:g}"
    result = {"mode": mode, "rtol": _nonnegative(rtol, "rtol"), "atol": _nonnegative(atol, "atol"),
              "source": source}
    if observed_max is not None:
        result["observedMaxAbs"] = _nonnegative(observed_max, "observed.maxAbs")
    return result
