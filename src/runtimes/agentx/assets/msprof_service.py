"""msprof sample-based service profiling for AgentX runs (read-only, opt-in).

One-shot helper: collects msprof duty-cycle evidence over the measurement
window, parses mac_fp16_ratio per device, and emits a deterministic summary.
Discipline mirrors Hyperloom integration (commit 9cd4ba0):
- default off; no collection without explicit invocation
- mutually exclusive with acl_task_time and torch profiler (caller's duty)
- output lands in <artifacts>/msprof/{window.json,summary.json,SHA256SUMS}

Usage:
  python msprof_service.py --config '{"devices":[...],"freqHz":10,...}' \
      --artifacts <dir> --msprof-binary <path-or-auto>
"""
import argparse
import csv
import re
import hashlib
import json
import math
import os
from pathlib import Path
import signal
import sqlite3
import subprocess
import shutil
import sys
from datetime import datetime, timezone
import time

SCHEMA_VERSION = 1
SUMMARY_KIND = "profiling-summary"

# Fixed CANN environment preamble; program path and arguments stay separate argv.
CANN_ENV_LOADER = (
    'set +e; for f in /usr/local/Ascend/ascend-toolkit/set_env.sh'
    ' /usr/local/Ascend/cann-9.2.0/set_env.sh; do'
    ' [ -f "$f" ] && . "$f"; done; exec "$0" "$@"'
)

_COLLECTORS = []


def _terminate_collector(proc):
    """Stop the collector process group, escalating from SIGTERM to SIGKILL."""
    if proc.poll() is not None:
        return
    try:
        os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
    except (ProcessLookupError, PermissionError, AttributeError):
        proc.terminate()
    try:
        proc.wait(timeout=60)
        return
    except subprocess.TimeoutExpired:
        pass
    try:
        os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
    except (ProcessLookupError, PermissionError, AttributeError):
        proc.kill()
    try:
        proc.wait(timeout=10)
    except subprocess.TimeoutExpired:
        pass


def _forward_signal(signum, _frame):
    """Forward termination to the msprof process tree, then report the abort."""
    for proc in _COLLECTORS:
        if proc.poll() is None:
            _terminate_collector(proc)
    print(json.dumps({"status": "error", "code": "aborted", "signal": int(signum)}))
    sys.stdout.flush()
    os._exit(1)


class MsprofError(ValueError):
    def __init__(self, code, detail=""):
        super().__init__(code)
        self.code = code
        self.detail = detail


def wait_for_serving_traffic(metrics_url, poll_sec=2, trigger_polls=3, max_wait_sec=600, stop_path=None):
    """Poll the vLLM metrics endpoint until token counters increase sustainably.

    The AgentX harness spends the first ~2 minutes on warmup without serving
    traffic; starting collection immediately would sample idle devices. Single
    warmup requests only bump the counters once, so requiring consecutive
    increases filters them out.
    """
    import re
    import urllib.request
    counter_pattern = re.compile(r"^(vllm:[\w:]+)(?:\{[^}]*\})?\s+([0-9.eE+-]+)\s*$", re.M)
    tracked = ("vllm:generation_tokens_total", "vllm:prompt_tokens_total")
    previous = {}
    increases = 0
    started = time.monotonic()
    while time.monotonic() - started < max_wait_sec:
        if stop_path is not None and stop_path.exists():
            return False
        try:
            with urllib.request.urlopen(metrics_url, timeout=5) as resp:
                text = resp.read().decode("utf-8", "replace")
            current = {name: float(value) for name, value in counter_pattern.findall(text)
                       if name in tracked}
            grew = bool(previous) and any(
                current.get(name, 0.0) > value for name, value in previous.items())
            increases = increases + 1 if grew else 0
            previous = current
            if increases >= trigger_polls:
                return True
        except Exception:
            increases = 0
        time.sleep(poll_sec)
    return False


def _core_files(path):
    result = [
        item for item in path.rglob("*.csv")
        if item.is_file()
        and (
            item.stem == "ai_core_utilization"
            or item.stem.endswith("_ai_core_utilization")
            or item.stem.startswith("ai_core_utilization_")
        )
        and "idle" not in item.stem.lower()
    ]
    return sorted(result, key=lambda item: item.relative_to(path).as_posix())


def _read_csv(path):
    with path.open("r", encoding="utf-8", newline="") as handle:
        return list(csv.DictReader(handle))


def _number(value):
    if value is None:
        return None
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    return parsed if math.isfinite(parsed) else None


def _pick(row, candidates):
    lowered = {key.strip().lower(): value for key, value in row.items() if key}
    for name in candidates:
        hit = lowered.get(name.lower())
        if hit is not None and str(hit).strip() != "":
            return str(hit).strip()
    return None


DEVICE_COLUMNS = ("Device ID", "device_id", "DeviceId", "NPU ID", "npu_id")
FP16_COLUMNS = ("mac_fp16_ratio", "MAC FP16 Ratio")
INT8_COLUMNS = ("mac_int8_ratio", "MAC INT8 Ratio")


def parse_core_csv(path):
    """Parse one ai_core_utilization export into per-device sample sums."""
    rows = _read_csv(path)
    devices = {}
    for row in rows:
        device_raw = _pick(row, DEVICE_COLUMNS)
        if device_raw is None or not device_raw.isdigit():
            raise MsprofError("device_id_missing", str(path))
        device_id = int(device_raw)
        fp16_raw = _pick(row, FP16_COLUMNS)
        int8_raw = _pick(row, INT8_COLUMNS)
        fp16 = _number(fp16_raw)
        int8 = _number(int8_raw)
        if fp16 is None or not 0.0 <= fp16 <= 1.0:
            raise MsprofError("mac_fp16_ratio_out_of_range", f"{path}: {fp16_raw}")
        if int8 is not None and not 0.0 <= int8 <= 1.0:
            raise MsprofError("mac_int8_ratio_out_of_range", f"{path}: {int8_raw}")
        entry = devices.setdefault(device_id, {"samples": 0, "fp16_sum": 0.0, "int8_samples": 0, "int8_sum": 0.0})
        entry["samples"] += 1
        entry["fp16_sum"] += fp16
        if int8 is not None:
            entry["int8_sum"] += int8
            entry["int8_samples"] += 1
    result = {}
    for device_id, entry in devices.items():
        result[device_id] = {"samples": entry["samples"], "fp16_sum": entry["fp16_sum"], "int8_samples": entry["int8_samples"], "int8_sum": entry["int8_sum"]}
    return result


def parse_sqlite(path):
    """Parse MetricSummary.sqlite aic_mac_ratio_extra (source-specific-uncalibrated)."""
    result = {}
    try:
        connection = sqlite3.connect(str(path))
        try:
            cursor = connection.execute(
                "SELECT device_id, aic_mac_ratio_extra FROM MetricSummary")
            for row in cursor:
                device_id, value = row[0], row[1]
                if device_id is None or value is None:
                    continue
                number = _number(str(value))
                if number is None:
                    continue
                result[int(device_id)] = number
        finally:
            connection.close()
    except sqlite3.Error:
        return None
    return result or None


def sha256_file(path):
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 16), b""):
            digest.update(chunk)
    return digest.hexdigest()


def write_sha256sums(directory):
    lines = []
    for item in sorted(directory.rglob("*")):
        if item.is_file() and item.name != "SHA256SUMS":
            rel = item.relative_to(directory).as_posix()
            lines.append(f"{sha256_file(item)}  {rel}")
    (directory / "SHA256SUMS").write_text("\n".join(lines) + ("\n" if lines else ""), encoding="utf-8")


def resolve_msprof(explicit):
    if explicit:
        if Path(explicit).is_file():
            return explicit
        raise MsprofError("msprof_binary_missing", explicit)
    for candidate in ["/usr/local/Ascend/ascend-toolkit/latest/bin/msprof",
                      "/usr/local/Ascend/cann-9.2.0/bin/msprof",
                      "/usr/local/Ascend/cann-9.1.0/bin/msprof"]:
        if Path(candidate).is_file():
            return candidate
    found = None
    for entry in os.environ.get("PATH", "").split(os.pathsep):
        hit = Path(entry) / "msprof"
        if hit.is_file():
            found = str(hit)
            break
    if found:
        return found
    raise MsprofError("msprof_binary_missing", "PATH and known CANN locations")


def enumerate_device_mapping(run=None):
    """Map npu-smi physical NPU IDs to msprof davinci chip logic IDs."""
    runner = run or subprocess.run
    try:
        result = runner(["npu-smi", "info", "-m"], capture_output=True, text=True, timeout=10)
    except (FileNotFoundError, subprocess.TimeoutExpired) as exc:
        raise MsprofError("devices_unresolved", f"npu-smi enumeration failed: {exc}")
    if result.returncode != 0:
        raise MsprofError("devices_unresolved", f"npu-smi exited {result.returncode}")
    mapping = {}
    for line in result.stdout.splitlines():
        # npu-smi info -m rows: NPU ID, Chip ID, Chip Logic ID, Chip Name.
        row = re.fullmatch(r"\s*(\d+)\s+(\d+)\s+(\d+|-)\s+(.+?)\s*", line)
        if row and row[3] != "-" and not re.search(r"\bmcu\b", row[4], re.I):
            mapping.setdefault(int(row[1]), set()).add(int(row[3]))
    if not mapping:
        raise MsprofError("devices_unresolved", "npu-smi info -m contained no compute chips")
    return {str(device_id): sorted(chips) for device_id, chips in sorted(mapping.items())}


def resolve_device_binding(devices, run=None):
    """Resolve caller-facing npu-smi physical IDs into msprof chip logic IDs."""
    mapping = enumerate_device_mapping(run)
    if [str(item).strip().lower() for item in devices] == ["all"]:
        requested = ["all"]
    else:
        try:
            requested = sorted({int(item) for item in devices})
        except (TypeError, ValueError):
            raise MsprofError("devices_missing", "devices must contain integers or [\"all\"]")
        missing = sorted(set(map(str, requested)) - set(mapping), key=int)
        if missing:
            raise MsprofError("devices_unresolved", f"npu-smi has no physical NPU ID(s): {','.join(map(str, missing))}")
    resolved = sorted({chip for chips in mapping.values() for chip in chips}
                      if requested == ["all"]
                      else {chip for device_id in requested for chip in mapping[str(device_id)]})
    return requested, resolved, mapping


def ensure_no_existing_collector():
    """Guard against overlapping sys-period sampling before binding devices."""
    pgrep = shutil.which("pgrep")
    if not pgrep:
        return
    result = subprocess.run([pgrep, "-f", "[m]sprof --sys-period"],
                           capture_output=True, text=True, timeout=10)
    if result.returncode == 0:
        raise MsprofError("msprof_already_running", result.stdout[-200:])
    if result.returncode != 1:
        raise MsprofError("preflight_failed", result.stderr[-200:] or f"pgrep exit {result.returncode}")


def main(argv=None):
    ensure_no_existing_collector()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True, help="JSON config string")
    parser.add_argument("--artifacts", required=True, help="output directory")
    parser.add_argument("--msprof-binary", default=None, help="explicit msprof path")
    parser.add_argument("--dry-run", action="store_true", help="print plan, zero side effects")
    args = parser.parse_args(argv)

    if hasattr(signal, "SIGTERM"):
        signal.signal(signal.SIGTERM, _forward_signal)
    if hasattr(signal, "SIGINT"):
        signal.signal(signal.SIGINT, _forward_signal)

    config = json.loads(args.config)
    devices = config.get("devices")
    if not isinstance(devices, list) or not devices:
        print(json.dumps({"status": "error", "code": "devices_missing"}))
        return 1
    devices_source = "npu-smi-enumeration" if [str(item).strip().lower() for item in devices] == ["all"] else "explicit"
    try:
        requested_devices, device_ids, device_mapping = resolve_device_binding(devices)
    except MsprofError as exc:
        print(json.dumps({"status": "error", "code": exc.code, "detail": exc.detail}))
        return 1
    freq_hz = int(config.get("freqHz", 10))
    metrics = str(config.get("metrics", "ArithmeticUtilization"))
    period_sec = int(config.get("periodSec", 3600))
    include_hbm = bool(config.get("includeHbm", False))
    metrics_url = str(config.get("metricsUrl", "")).strip()
    wait_for_traffic = bool(config.get("waitForTraffic", False))

    root = Path(args.artifacts) / "msprof"
    stop_path = root / "STOP"
    traffic_wait_max = min(600, max(60, period_sec // 10))
    meta = {"tag": "agentx", "devices": device_ids, "devices_source": devices_source, "freq_hz": freq_hz,
            "requested_devices": requested_devices, "device_mapping": device_mapping,
            "metrics": metrics, "period_sec": period_sec, "include_hbm": include_hbm}
    if metrics_url:
        meta["metrics_url"] = metrics_url
    meta["wait_for_traffic"] = wait_for_traffic and bool(metrics_url)
    meta["traffic_wait_max_sec"] = traffic_wait_max

    if args.dry_run:
        flags = [f"--sys-period={period_sec}", f"--sys-devices={','.join(map(str, device_ids))}",
                 "--ai-core=on", "--aic-mode=sample-based", f"--aic-freq={freq_hz}",
                 f"--aic-metrics={metrics}"]
        if include_hbm:
            flags.append("--sys-hardware-mem=on")
        flags.append(f"--output=<remote>")
        print(json.dumps({"status": "dry-run", "config": meta, "flags": flags}))
        return 0

    binary = resolve_msprof(args.msprof_binary)
    wait_started = time.monotonic()
    traffic_wait_sec = 0.0
    traffic_triggered = False
    if meta["wait_for_traffic"]:
        traffic_triggered = wait_for_serving_traffic(
            metrics_url, poll_sec=2, trigger_polls=3, max_wait_sec=traffic_wait_max,
            stop_path=stop_path)
        traffic_wait_sec = round(time.monotonic() - wait_started, 3)
        if not traffic_triggered:
            if stop_path.exists():
                print(json.dumps({"status": "error", "code": "harness_requested_before_collection"}))
                return 1
            print(json.dumps({"status": "error", "code": "traffic_wait_timeout",
                              "detail": f"no sustained serving traffic within {traffic_wait_max}s"}))
            return 1
    meta["traffic_wait_sec"] = traffic_wait_sec
    meta["traffic_triggered_start"] = traffic_triggered
    exported = root / "exported"
    exported.mkdir(parents=True, exist_ok=True)
    remote_output = str(Path(args.artifacts) / "msprof" / "raw")
    started_at = datetime.now(timezone.utc).isoformat()

    flags = [f"--sys-period={period_sec}", f"--sys-devices={','.join(map(str, device_ids))}",
             "--ai-core=on", "--aic-mode=sample-based", f"--aic-freq={freq_hz}",
             f"--aic-metrics={metrics}"]
    if include_hbm:
        flags.append("--sys-hardware-mem=on")
    flags.append(f"--output={remote_output}")

    collect_log = root / "collect.log"
    stop_mode = "period-complete"
    try:
        collector = subprocess.Popen(
            ["bash", "-c", CANN_ENV_LOADER, binary, *flags],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
            start_new_session=sys.platform != "win32")
        _COLLECTORS.append(collector)
        deadline = time.monotonic() + period_sec + 300
        stdout = stderr = ""
        while True:
            try:
                stdout, stderr = collector.communicate(timeout=1)
                break
            except subprocess.TimeoutExpired:
                pass
            if stop_path.exists():
                stop_mode = "harness-requested"
                _terminate_collector(collector)
                stdout, stderr = collector.communicate()
                break
            if time.monotonic() > deadline:
                stop_mode = "timeout"
                _terminate_collector(collector)
                stdout, stderr = collector.communicate()
                break
        collect_log.write_text(stdout + "\n" + stderr, encoding="utf-8")
        intentionally_stopped = stop_mode != "period-complete"
        if collector.returncode != 0 and not intentionally_stopped:
            print(json.dumps({"status": "error", "code": "msprof_exit_nonzero",
                              "returncode": collector.returncode}))
            return 1
    except FileNotFoundError as exc:
        collect_log.write_text(str(exc), encoding="utf-8")
        print(json.dumps({"status": "error", "code": "msprof_launch_failed"}))
        return 1

    raw_dir = Path(remote_output)
    if not raw_dir.is_dir():
        print(json.dumps({"status": "error", "code": "msprof_output_missing"}))
        return 1
    for item in raw_dir.rglob("*"):
        if item.is_file():
            rel = item.relative_to(raw_dir)
            dest = exported / rel
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(item.read_bytes())

    csv_devices = {}
    csv_errors = []
    for csv_path in _core_files(exported):
        try:
            for device_id, values in parse_core_csv(csv_path).items():
                existing = csv_devices.setdefault(device_id, {"samples": 0, "fp16_sum": 0.0, "int8_samples": 0, "int8_sum": 0.0})
                existing["samples"] += values["samples"]
                existing["fp16_sum"] += values["fp16_sum"]
                existing["int8_samples"] += values["int8_samples"]
                existing["int8_sum"] += values["int8_sum"]
        except MsprofError as exc:
            csv_errors.append(f"{exc.code}: {exc.detail}")

    devices_summary = {}
    for device_id, entry in csv_devices.items():
        fp16_mean = entry["fp16_sum"] / entry["samples"]
        int8_mean = entry["int8_sum"] / entry["int8_samples"] if entry["int8_samples"] else None
        devices_summary[str(device_id)] = {
            "mac_fp16_ratio": round(fp16_mean, 6),
            "mac_int8_ratio": round(int8_mean, 6) if int8_mean is not None else None,
            "samples": entry["samples"],
        }

    sqlite_path = None
    for item in exported.rglob("MetricSummary.sqlite"):
        sqlite_path = item
        break
    sqlite_devices = parse_sqlite(sqlite_path) if sqlite_path else None

    aggregate_fp16 = None
    if devices_summary:
        values = [entry["mac_fp16_ratio"] for entry in devices_summary.values()]
        aggregate_fp16 = round(sum(values) / len(values), 6)

    availability = {
        "mac_fp16_ratio": "interpretable" if devices_summary else "missing",
        "mac_int8_ratio": "interpretable" if devices_summary and any(v["mac_int8_ratio"] is not None for v in devices_summary.values()) else "missing",
        "aic_mac_ratio_extra_sqlite": "present-source-specific-uncalibrated" if sqlite_devices else "missing",
        "hbm": "unit-unverified-excluded",
    }

    summary = {
        "schemaVersion": SCHEMA_VERSION,
        "kind": SUMMARY_KIND,
        "requestedDevices": requested_devices,
        "resolvedDevices": device_ids,
        "deviceMapping": device_mapping,
        "aggregate": {"device_count": len(devices_summary), "mac_fp16_ratio_mean": aggregate_fp16},
        "devices": devices_summary,
        "availability": availability,
        "csv_parse_errors": csv_errors,
    }
    if sqlite_devices is not None:
        summary["sqlite_devices"] = {str(k): round(v, 6) for k, v in sorted(sqlite_devices.items())}

    window = {
        "tag": "agentx",
        "devices_source": devices_source,
        "requested_devices": requested_devices,
        "device_mapping": device_mapping,
        "started_at": started_at,
        "period_sec": period_sec,
        "devices": ",".join(map(str, device_ids)),
        "freq_hz": freq_hz,
        "metrics": metrics,
        "include_hbm": include_hbm,
        "stop_mode": stop_mode,
        "collector_returncode": collector.returncode,
    }
    (root / "summary.json").write_text(json.dumps(summary, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    (root / "window.json").write_text(json.dumps(window, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    write_sha256sums(root)

    print(json.dumps({"status": "completed", "summary": summary, "window": window}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
