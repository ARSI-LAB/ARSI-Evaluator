"""CPU-only lifecycle checks using real loopback HTTP and controlled npu-smi."""
import contextlib
import io
import json
from pathlib import Path
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
import urllib.error
import urllib.request
from urllib.parse import urlparse

sys.path.insert(0, str(Path(sys.argv.pop(1)).resolve()))
import ascend_metrics as npu
from local_telemetry import LocalTelemetry, discover_chips
import runner

READINGS = """NPU Utilization(%) : 35
Aicore Usage Rate(%) : 30
HBM Usage Rate(%) : 80
HBM Bandwidth Usage Rate(%) : 25
HBM Capacity(MB) : 32768
NPU Real-time Power(W) : 180.5
NPU Temperature (C) : 49
"""
MAPPING = """NPU ID  Chip ID  Chip Logic ID  Chip Name
 4  0  0  Ascend 910B
 4  1  -  Mcu
 5  0  1  Ascend 910B
 5  1  2  Ascend 910B
 6  0  3  Ascend 910B
"""
CONFIG = {"ascend": {"mode": "local", "devices": [{"deviceId": 4}, {"deviceId": 5}]}}


def query(command, **kwargs):
    if command == ["npu-smi", "info", "-m"]:
        return subprocess.CompletedProcess(command, 0, stdout=MAPPING)
    assert command[0:2] == ["npu-smi", "info"]
    assert command[4] == "-i" and command[6] == "-c"
    assert command[5] in ("4", "5")
    assert kwargs["timeout"] == 2
    return subprocess.CompletedProcess(command, 0, stdout=READINGS)


def fetch(url):
    with urllib.request.urlopen(url, timeout=1) as response:
        return response.read()


class LocalTelemetryTests(unittest.TestCase):
    def assert_closed(self, managed):
        for target, sampler in managed.samplers:
            self.assertTrue(sampler.stop.is_set())
            address = urlparse(target["endpoint"])
            with self.assertRaises(OSError):
                socket.create_connection((address.hostname, address.port), timeout=0.15)
        self.assertFalse(any(t.name in ("npu-local-sampler", "npu-local-http") for t in threading.enumerate()))

    def test_discovers_only_requested_compute_chips(self):
        self.assertEqual(discover_chips(MAPPING, 4), [0])
        self.assertEqual(discover_chips(MAPPING, 5), [0, 1])
        with self.assertRaises(ValueError):
            discover_chips(MAPPING, 9)
        self.assertEqual(discover_chips(MAPPING + "\n-1 0 0 Ascend\n", 4), [0])

    def test_multi_device_startup_and_normal_cleanup(self):
        with tempfile.TemporaryDirectory() as directory, patch("subprocess.run", side_effect=query) as run:
            managed = LocalTelemetry(CONFIG, Path(directory))
            with managed:
                self.assertEqual([(t["deviceId"], t["chipId"]) for t in managed.targets], [(4, 0), (5, 0), (5, 1)])
                self.assertEqual(len({t["endpoint"] for t in managed.targets}), 3)
                for target in managed.targets:
                    self.assertIn(('device_id="%d",chip_id="%d"' % (target["deviceId"], target["chipId"])).encode(), fetch(target["endpoint"]))
                self.assertEqual(managed.evidence()[0]["errors"], [])
            self.assert_closed(managed)
            saved = json.loads((Path(directory) / "local-telemetry.json").read_text())
            self.assertEqual(len(saved["localAscend"]), 3)
            self.assertEqual(sum(call.args[0] == ["npu-smi", "info", "-m"] for call in run.call_args_list), 1)

    def test_explicit_chip_does_not_query_other_devices_or_mapping(self):
        with tempfile.TemporaryDirectory() as directory, patch("subprocess.run", side_effect=query) as run:
            with LocalTelemetry({"ascend": {"mode": "local", "devices": [{"deviceId": 5, "chipId": 1}]}}, Path(directory)) as managed:
                self.assertEqual(len(managed.targets), 1)
                self.assertIn(b'chip_id="1"', fetch(managed.targets[0]["endpoint"]))
            self.assertTrue(all(call.args[0][-4:] == ["-i", "5", "-c", "1"] for call in run.call_args_list))

    def test_one_device_failure_keeps_other_device_and_diagnostics(self):
        def failed_query(command, **kwargs):
            if "-i" in command and command[5] == "5":
                raise subprocess.TimeoutExpired(command, 2)
            return query(command, **kwargs)
        with tempfile.TemporaryDirectory() as directory, patch("subprocess.run", side_effect=failed_query):
            with LocalTelemetry(CONFIG, Path(directory)) as managed:
                self.assertIn(b"ascend_npu_utilization_percent", fetch(managed.targets[0]["endpoint"]))
                with self.assertRaises(urllib.error.HTTPError) as error:
                    fetch(managed.targets[1]["endpoint"])
                self.assertEqual(error.exception.code, 503)
                self.assertIn("timed out", managed.evidence()[1]["errors"][0])
            self.assert_closed(managed)

    def test_missing_executable_and_missing_device_are_saved_without_fake_chip(self):
        with tempfile.TemporaryDirectory() as directory:
            for effect, expected in [(FileNotFoundError(), "not found"),
                                     (lambda *a, **k: subprocess.CompletedProcess(a, 0, stdout=""), "No compute chips")]:
                with patch("subprocess.run", side_effect=effect):
                    with LocalTelemetry(CONFIG, Path(directory)) as managed:
                        self.assertFalse(managed.sources)
                        self.assertEqual(len(managed.targets), 2)
                        self.assertIsNone(managed.targets[0]["endpoint"])
                        self.assertNotIn("chipId", managed.targets[0])
                        self.assertIn(expected, managed.targets[0]["errors"][0])

    def test_external_and_disabled_telemetry_do_not_start_sampling(self):
        with tempfile.TemporaryDirectory() as directory, patch("subprocess.run") as run:
            for config in [{}, {"ascend": {"endpoint": "http://localhost:123/metrics", "deviceId": 4, "chipId": 0}}]:
                with LocalTelemetry(config, Path(directory)) as managed:
                    self.assertEqual(managed.sources, config)
                    self.assertFalse(managed.targets)
            run.assert_not_called()
            self.assertFalse((Path(directory) / "local-telemetry.json").exists())

    def test_exception_cancel_and_partial_thread_start_close_resources(self):
        with tempfile.TemporaryDirectory() as directory, patch("subprocess.run", side_effect=query):
            for exception in (RuntimeError("Harness failed"), KeyboardInterrupt()):
                managed = LocalTelemetry(CONFIG, Path(directory))
                with self.assertRaises(type(exception)):
                    with managed:
                        raise exception
                self.assert_closed(managed)
            original_start = threading.Thread.start
            count = 0

            def start(thread):
                nonlocal count
                count += 1
                if count == 4:
                    raise RuntimeError("HTTP thread failed")
                return original_start(thread)

            managed = LocalTelemetry(CONFIG, Path(directory))
            with patch.object(threading.Thread, "start", start), self.assertRaises(RuntimeError):
                with managed:
                    self.fail("startup should fail")
            self.assert_closed(managed)

    def test_bind_failure_preserves_per_chip_failure_and_other_endpoints(self):
        original_server = npu.create_server

        def create(sampler, host, port):
            if sampler.device_id == 5:
                raise OSError("controlled bind error")
            return original_server(sampler, host, port)

        with tempfile.TemporaryDirectory() as directory, patch("subprocess.run", side_effect=query), \
                patch("local_telemetry.create_server", side_effect=create):
            with LocalTelemetry(CONFIG, Path(directory)) as managed:
                self.assertIn(b"ascend_npu_utilization_percent", fetch(managed.targets[0]["endpoint"]))
                self.assertIsNone(managed.targets[1]["endpoint"])
                self.assertIn("Could not bind", managed.targets[1]["errors"][0])
                self.assertEqual(len(managed.sources), 1)
            self.assert_closed(managed)

    @unittest.skipIf(sys.platform == "win32", "POSIX SIGTERM lifecycle")
    def test_sigterm_unwinds_sampler_context_and_writes_diagnostics(self):
        with tempfile.TemporaryDirectory() as directory:
            code = """import sys,time,json
from pathlib import Path
sys.path.insert(0, sys.argv[1])
from local_telemetry import LocalTelemetry
from unittest.mock import patch
with patch('ascend_metrics.read_device', return_value={'ascend_npu_utilization_percent':35}):
    with LocalTelemetry({'ascend':{'mode':'local','devices':[{'deviceId':4,'chipId':0}]}}, Path(sys.argv[2])) as managed:
        print(managed.targets[0]['endpoint'], flush=True)
        time.sleep(30)
"""
            child = subprocess.Popen([sys.executable, "-B", "-c", code, str(Path(npu.__file__).parent), directory],
                                     stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
            try:
                endpoint = child.stdout.readline().strip()
                self.assertIn(b"ascend_npu_utilization_percent", fetch(endpoint))
                child.terminate()
                child.wait(timeout=4)
                self.assertTrue((Path(directory) / "local-telemetry.json").is_file())
                address = urlparse(endpoint)
                with self.assertRaises(OSError):
                    socket.create_connection((address.hostname, address.port), timeout=0.15)
            finally:
                if child.poll() is None:
                    child.kill()
                    child.wait()

    def test_bridge_starts_before_harness_and_exports_phase_evidence(self):
        with tempfile.TemporaryDirectory() as directory, patch("subprocess.run", side_effect=query):
            root = Path(directory)
            request = {"schemaVersion": 1, "telemetry": CONFIG, "artifactDir": str(root / "artifacts"),
                       "outputDir": str(root / "output"), "key": {}, "auth": {"value": "fixture-secret"},
                       "workload": {"mode": "smoke", "concurrency": 1, "loader": "fixture", "durationSeconds": 1,
                                    "seed": 42, "tracePath": "unused", "dataset": "fixture", "sha256": "fixture"},
                       "url": "http://localhost:8000", "endpoint": "/v1/chat/completions", "model": "fixture",
                       "tokenizerPath": "unused", "trustRemoteCode": False}
            endpoints = []

            class Harness:
                pid = 123
                stdout = iter(["controlled Harness\n"])

                def __init__(self, args, **_options):
                    endpoints.extend(args[args.index("--server-metrics") + 1:args.index("--server-metrics-formats")])
                    assert len(endpoints) == 3
                    self.metrics = [fetch(url).decode() for url in endpoints]
                    self.finished = False

                def wait(self, **_options):
                    start = time.time_ns()
                    records, metrics = [], {}
                    for phase, stamp in [("warmup", start), ("profiling", start + 10)]:
                        for url, text in zip(endpoints, self.metrics):
                            records.append({"endpoint_url": url, "timestamp_ns": stamp, "metrics": {}})
                            for line in text.splitlines():
                                if line.startswith("#"):
                                    continue
                                metric, value = line.rsplit(" ", 1)
                                name, tags = metric.split("{", 1)
                                labels = dict(item.split("=") for item in tags.rstrip("}").replace('"', '').split(","))
                                if phase == "profiling":
                                    metrics.setdefault(name, {"type": "gauge", "series": []})["series"].append(
                                        {"endpoint_url": url, "labels": labels, "stats": {"avg": float(value), "min": float(value), "max": float(value)}})
                    artifacts = root / "artifacts"
                    (artifacts / "profile_export_aiperf.json").write_text(json.dumps({"was_cancelled": False}))
                    raw = {"schema_version": "1.1", "metrics_phase": "profiling", "metrics": metrics,
                           "summary": {"endpoints_successful": endpoints, "phase_time_ranges": {
                               "warmup": {"start_ns": start, "end_ns": start + 1},
                               "profiling": {"start_ns": start + 9, "end_ns": start + 11}}}}
                    (artifacts / "server_metrics_export.json").write_text(json.dumps(raw))
                    (artifacts / "server_metrics_export.jsonl").write_text("\n".join(map(json.dumps, records)))
                    self.finished = True
                    return 0

                def poll(self):
                    return 0 if self.finished else None

            output = io.StringIO()
            previous = signal.getsignal(signal.SIGTERM)
            with patch.object(runner.importlib.metadata, "version", return_value="1.0.7"), \
                    patch.object(runner.sys, "stdin", io.StringIO(json.dumps(request))), \
                    patch("subprocess.Popen", Harness), contextlib.redirect_stdout(output):
                runner.run()
            self.assertEqual(signal.getsignal(signal.SIGTERM), previous)
            terminal = json.loads(output.getvalue().splitlines()[-1])
            self.assertEqual(len(terminal["telemetry"]["localAscend"]), 3)
            self.assertIsNone(terminal["telemetry"]["error"])
            self.assertTrue(all(count == {"profiling": 1, "warmup": 1} for count in terminal["telemetry"]["samples"].values()))
            for url in endpoints:
                address = urlparse(url)
                with self.assertRaises(OSError):
                    socket.create_connection((address.hostname, address.port), timeout=0.15)


unittest.main()
