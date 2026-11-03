"""CPU-only regressions for the Ascend command adapter and AgentX evidence reader."""
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

sys.path.insert(0, str(Path(sys.argv.pop(1)).resolve()))
import ascend_metrics as npu
from server_metrics import CounterWindow, read_server_metrics

READINGS = """NPU Utilization(%) : 35
Aicore Usage Rate(%) : 30
HBM Usage Rate(%) : 80
HBM Bandwidth Usage Rate(%) : 25
HBM Capacity(MB) : 32768
NPU Real-time Power(W) : 180.5
NPU Temperature (C) : 49
"""


class TelemetryTests(unittest.TestCase):
    def test_exact_device_queries_and_units(self):
        commands = []

        def run(command, **options):
            commands.append(command)
            self.assertEqual(command[-4:], ["-i", "4", "-c", "0"])
            self.assertEqual(options["timeout"], 2.0)
            return subprocess.CompletedProcess(command, 0, stdout=READINGS)

        values = npu.read_device(4, 0, run=run)
        self.assertEqual(len(commands), 4)
        self.assertEqual(values["ascend_npu_hbm_capacity_megabytes"], 32768)
        self.assertEqual(values["ascend_npu_utilization_percent"], 35)

    def test_invalid_missing_and_failed_commands_never_produce_zero(self):
        for value in ["N/A", "NaN", "Infinity", "-1", "101"]:
            with self.assertRaises(ValueError):
                npu.parse_readings("NPU Utilization(%) : " + value)
        with self.assertRaises(ValueError):
            npu.read_device(4, 0, run=lambda *a, **k: subprocess.CompletedProcess(a, 0, stdout=""))
        with self.assertRaises(subprocess.TimeoutExpired):
            npu.read_device(4, 0, run=lambda *a, **k: (_ for _ in ()).throw(subprocess.TimeoutExpired(a, 2)))
        sampler = npu.DeviceSampler(4, 0, reader=lambda *_a: (_ for _ in ()).throw(OSError()))
        sampler.sample()
        self.assertIsNone(sampler.snapshot())

    def test_stale_snapshot_and_failed_refresh_are_unavailable(self):
        sampler = npu.DeviceSampler(4, 0, reader=lambda *_a: npu.parse_readings(READINGS))
        sampler.sample()
        self.assertIn(b'device_id="4",chip_id="0"', sampler.snapshot())
        self.assertEqual(sampler.max_age, 9)
        with patch.object(npu.time, "monotonic", return_value=sampler.updated + 3.25):
            self.assertIsNotNone(sampler.snapshot())
        with patch.object(npu.time, "monotonic", return_value=sampler.updated + sampler.max_age + 0.01):
            self.assertIsNone(sampler.snapshot())
        self.assertIn("NPU sample expired", sampler.errors)
        sampler.reader = lambda *_a: (_ for _ in ()).throw(OSError())
        sampler.sample()
        self.assertIsNone(sampler.snapshot())
        sampler.reader = lambda *_a: npu.parse_readings(READINGS)
        sampler.sample()
        self.assertIsNotNone(sampler.snapshot())
        self.assertIn("NPU sample expired", sampler.errors)

    def test_freshness_budget_tracks_configured_query_timeout_and_interval(self):
        self.assertEqual(npu.DeviceSampler(4, 0, interval=1, timeout=0.5).max_age, 3)
        self.assertEqual(npu.DeviceSampler(4, 0, interval=5, timeout=2).max_age, 15)
        self.assertEqual(npu.DeviceSampler(4, 0, interval=1, timeout=3).max_age, 13)

    def test_http_endpoint_recovers_after_expired_and_failed_samples(self):
        sampler = npu.DeviceSampler(4, 0, reader=lambda *_a: npu.parse_readings(READINGS))
        sampler.sample()
        server = npu.create_server(sampler, "127.0.0.1", 0)
        thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.01})
        thread.start()
        endpoint = "http://127.0.0.1:%d/metrics" % server.server_port
        try:
            sampler.updated -= 3.25
            with urllib.request.urlopen(endpoint, timeout=2) as response:
                self.assertEqual(response.status, 200)
            sampler.updated -= sampler.max_age
            with self.assertRaises(urllib.error.HTTPError) as error:
                urllib.request.urlopen(endpoint, timeout=2)
            self.assertEqual(error.exception.code, 503)
            sampler.reader = lambda *_a: (_ for _ in ()).throw(subprocess.TimeoutExpired("npu-smi", 2))
            sampler.sample()
            with self.assertRaises(urllib.error.HTTPError) as error:
                urllib.request.urlopen(endpoint, timeout=2)
            self.assertEqual(error.exception.code, 503)
            sampler.reader = lambda *_a: npu.parse_readings(READINGS)
            sampler.sample()
            with urllib.request.urlopen(endpoint, timeout=2) as response:
                self.assertIn(b'chip_id="0"', response.read())
            self.assertIn("npu-smi query timed out", sampler.errors)
        finally:
            server.shutdown()
            server.server_close()
            thread.join()

    def test_cancel_does_not_start_more_device_commands(self):
        stop = threading.Event()
        commands = []

        def run(command, **_options):
            commands.append(command)
            stop.set()
            return subprocess.CompletedProcess(command, 0, stdout=READINGS)

        with self.assertRaises(InterruptedError):
            npu.read_device(4, 0, run=run, stop=stop)
        self.assertEqual(len(commands), 1)

    def test_sampling_is_serial_and_stops(self):
        active = 0
        maximum = 0

        def read(*_args):
            nonlocal active, maximum
            active += 1
            maximum = max(maximum, active)
            time.sleep(0.03)
            active -= 1
            return npu.parse_readings(READINGS)

        sampler = npu.DeviceSampler(4, 0, interval=0.01, reader=read)
        worker = threading.Thread(target=sampler.run)
        worker.start()
        time.sleep(0.12)
        sampler.stop.set()
        worker.join(2)
        self.assertFalse(worker.is_alive())
        self.assertEqual(maximum, 1)

    def test_profiling_counts_exclude_warmup_and_preserve_ns(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            url = "http://localhost:1/metrics"
            raw = {"summary": {"phase_time_ranges": {
                "warmup": {"start_ns": 1, "end_ns": 3},
                "profiling": {"start_ns": 1700000000000000001, "end_ns": 1700000000000000010}}}}
            (root / "server_metrics_export.json").write_text(json.dumps(raw))
            (root / "server_metrics_export.jsonl").write_text("\n".join(json.dumps({"endpoint_url": url, "timestamp_ns": stamp})
                for stamp in [0, 2, 5, 1700000000000000002, 1700000000000000011]))
            evidence = read_server_metrics(root, {"vllm": {"endpoint": url}})
            self.assertEqual(evidence["samples"][url], {"profiling": 1, "warmup": 1})
            self.assertEqual(evidence["export"]["summary"]["phase_time_ranges"]["profiling"]["start_ns"], "1700000000000000001")
            (root / "server_metrics_export.json").unlink()
            self.assertIsNotNone(read_server_metrics(root, {"vllm": {"endpoint": url}})["error"])

    def test_large_time_series_stay_in_artifacts_not_bridge_output(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            url = "http://localhost:1/metrics"
            stats = {"avg": 0.2, "min": 0.0, "max": 0.5, "p99": 0.4}
            counter = {"total": 250, "rate": 25}
            # A long real run exceeds the 16 MiB stdout protocol limit with slices.
            slices = [{"start_ns": n, "end_ns": n + 1, "avg": 0.2} for n in range(350000)]
            raw = {"schema_version": "1.1", "metrics_phase": "profiling", "evaluator_collection_error_count": 0,
                   "summary": {"endpoints_successful": [url], "phase_time_ranges": {
                       "profiling": {"start_ns": 1, "end_ns": 20}}},
                   "metrics": {"kv": {"type": "gauge", "series": [
                       {"endpoint_url": url, "labels": {"model_name": "test"}, "stats": stats, "timeslices": slices}]},
                       "tokens": {"type": "counter", "series": [
                       {"endpoint_url": url, "labels": {}, "stats": counter, "timeslices": slices}]}},
                   "warmup_metrics": {"kv": {"type": "gauge", "series": [
                       {"endpoint_url": url, "labels": {}, "stats": stats, "timeslices": slices}]}}}
            content = json.dumps(raw)
            self.assertGreater(len(content), 16 * 1024 * 1024)
            path = root / "server_metrics_export.json"
            path.write_text(content)
            (root / "server_metrics_export.jsonl").write_text("\n".join(json.dumps({
                "endpoint_url": url, "timestamp_ns": stamp,
                "metrics": {"tokens": [{"labels": {}, "value": value}]}})
                for stamp, value in [(0, 100), (10000000000, 350)]))
            # Use nanoseconds so the observed 250-token increment has rate 25/s.
            raw["summary"]["phase_time_ranges"]["profiling"]["end_ns"] = 20000000000
            content = json.dumps(raw)
            path.write_text(content)
            evidence = read_server_metrics(root, {"vllm": {"endpoint": url}})
            self.assertIsNone(evidence["error"])
            self.assertLess(len(json.dumps(evidence)), 4096)
            exported = evidence["export"]
            self.assertEqual(exported["metrics"]["kv"]["series"][0], {
                "endpoint_url": url, "labels": {"model_name": "test"},
                "stats": {"avg": 0.2, "min": 0.0, "max": 0.5}})
            self.assertEqual(exported["metrics"]["tokens"]["series"][0]["stats"], counter)
            self.assertEqual(exported["warmup_metrics"]["kv"]["series"][0]["stats"]["avg"], 0.2)
            self.assertEqual(exported["evaluator_collection_error_count"], 0)
            self.assertEqual(path.read_text(), content)

    def test_counter_capture_order_keeps_real_resets_and_clock_rollbacks(self):
        cases = [
            ([(0, 100), (12, 110), (20, 120), (30, 130)], 30),
            ([(0, 100), (12, 110), (11, 120), (30, 130)], 30),
            ([(0, 100), (12, 110), (11, 5), (30, 8)], 18),
            ([(0, 100), (12, 110), (13, 5), (14, 8), (15, 2), (30, 3)], 21),
            ([(12, 110), (11, 120), (30, 130)], 20),
            ([(0, 100), (12, 100), (11, 100), (30, 100)], 0),
        ]
        for samples, expected in cases:
            with self.subTest(samples=samples):
                # Window and sample timestamps use the same nanosecond scale.
                counter = CounterWindow({"start_ns": 10 * 1000000000, "end_ns": 30 * 1000000000})
                for stamp, value in samples:
                    counter.add(stamp * 1000000000, value)
                stats = counter.stats()
                self.assertEqual(stats["total"], expected)
                self.assertEqual(stats["rate"], expected / (samples[-1][0] - samples[0][0]))
        counter = CounterWindow({"start_ns": 1, "end_ns": 5})
        self.assertIsNone(counter.stats())
        counter.add(3, 4)
        self.assertIsNone(counter.stats()["rate"])
        for value in [float("nan"), float("inf"), -1, True]:
            with self.assertRaises(ValueError):
                counter.add(4, value)

    def test_counter_windows_labels_and_endpoints_do_not_mix(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            endpoints = ["http://localhost:1/metrics", "http://localhost:2/metrics"]
            series = [{"endpoint_url": url, "labels": {"model_name": label}, "stats": {"total": 9999}}
                      for url, label in [(endpoints[0], "a"), (endpoints[0], "b"), (endpoints[1], "a")]]
            raw = {"summary": {"phase_time_ranges": {
                "warmup": {"start_ns": 1, "end_ns": 3}, "profiling": {"start_ns": 10, "end_ns": 30}}},
                "metrics": {"tokens": {"type": "counter", "series": series}},
                "warmup_metrics": {"tokens": {"type": "counter", "series": series}}}
            (root / "server_metrics_export.json").write_text(json.dumps(raw))
            records = []
            for stamp, values in [(0, [100, 200, 300]), (2, [103, 205, 307]),
                                  (12, [113, 225, 337]), (11, [123, 245, 367]), (30, [133, 265, 397]),
                                  (31, [1000, 2000, 3000])]:
                for i, (url, label) in enumerate([(endpoints[0], "a"), (endpoints[0], "b"), (endpoints[1], "a")]):
                    records.append({"endpoint_url": url, "timestamp_ns": stamp,
                                    "metrics": {"tokens": [{"labels": {"model_name": label}, "value": values[i]}]}})
            (root / "server_metrics_export.jsonl").write_text("\n".join(map(json.dumps, records)))
            evidence = read_server_metrics(root, {"vllm": {"endpoint": endpoints[0]}, "ascend": {"endpoint": endpoints[1]}})
            self.assertIsNone(evidence["error"])
            self.assertEqual([s["stats"]["total"] for s in evidence["export"]["metrics"]["tokens"]["series"]], [30, 60, 90])
            self.assertEqual([s["stats"]["total"] for s in evidence["export"]["warmup_metrics"]["tokens"]["series"]], [3, 5, 7])
            (root / "server_metrics_export.jsonl").unlink()
            missing = read_server_metrics(root, {"vllm": {"endpoint": endpoints[0]}})
            self.assertIsNone(missing["export"]["metrics"]["tokens"]["series"][0]["stats"])
            self.assertEqual(missing["samples"][endpoints[0]]["profiling"], 0)

    @unittest.skipIf(sys.platform == "win32", "POSIX SIGTERM lifecycle")
    def test_sigterm_closes_http_and_sampler(self):
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        code = ("import sys,signal;sys.path.insert(0,sys.argv[1]);import ascend_metrics as n;"
                "s=n.DeviceSampler(4,0,reader=lambda *a:{'ascend_npu_utilization_percent':30});"
                "signal.signal(signal.SIGTERM,lambda *a:s.stop.set());n.serve(s,'127.0.0.1',int(sys.argv[2]))")
        child = subprocess.Popen([sys.executable, "-c", code, str(Path(npu.__file__).parent), str(port)])
        try:
            for _ in range(60):
                try:
                    with urllib.request.urlopen("http://127.0.0.1:%d/metrics" % port, timeout=1) as response:
                        self.assertIn(b'device_id="4"', response.read())
                    break
                except (urllib.error.URLError, OSError):
                    time.sleep(0.03)
            else:
                self.fail("Exporter did not become ready")
            child.terminate()
            self.assertEqual(child.wait(timeout=4), 0)
            with self.assertRaises(urllib.error.URLError):
                urllib.request.urlopen("http://127.0.0.1:%d/metrics" % port, timeout=1)
        finally:
            if child.poll() is None:
                child.kill()
                child.wait()


unittest.main()
