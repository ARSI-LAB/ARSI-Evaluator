"""Exercise the real host control protocol with a strictly read-only fake driver."""
import contextlib
import json
import io
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
import urllib.request
from urllib.parse import urlsplit

sys.path.insert(0, str(Path(sys.argv.pop(1)).resolve()))
from host_telemetry import SamplingServer, sample_connection
from local_telemetry import LocalTelemetry

READINGS = """NPU Utilization(%) : 35
Aicore Usage Rate(%) : 30
HBM Usage Rate(%) : 80
HBM Bandwidth Usage Rate(%) : 25
HBM Capacity(MB) : 32768
NPU Real-time Power(W) : 180.5
NPU Temperature (C) : 49
"""


def readonly_query(command, **kwargs):
    # Any added install/set/arbitrary command makes the regression fail.
    assert len(command) == 8
    assert command[:3] == ["npu-smi", "info", "-t"]
    assert command[3] in ("usages", "memory", "power", "temp")
    assert command[4] == "-i" and command[5] in ("4", "5")
    assert command[6:] == ["-c", "0"]
    assert kwargs["timeout"] == 2
    return subprocess.CompletedProcess(command, 0, stdout=READINGS)


@contextlib.contextmanager
def running_server():
    with tempfile.TemporaryDirectory() as directory, SamplingServer("test-token", Path(directory)) as server:
        thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.05})
        thread.start()
        try:
            yield server
        finally:
            server.close_connections()
            server.shutdown()
            thread.join()


class HostTelemetryTests(unittest.TestCase):
    def test_native_stdio_sampling_without_a_management_container(self):
        for message in [b'{"schemaVersion":1,"op":"finish"}\n', b'']:
            with tempfile.TemporaryDirectory() as directory, patch("subprocess.run", side_effect=readonly_query) as run:
                reader, writer = io.BytesIO(message), io.BytesIO()
                sample_connection({"schemaVersion": 1, "op": "sample", "devices": [{"deviceId": 4, "chipId": 0}]},
                                  reader, writer, Path(directory))
                responses = [json.loads(line) for line in writer.getvalue().splitlines()]
                self.assertEqual(responses[0]["type"], "ready")
                self.assertEqual([r["type"] for r in responses], ["ready", "finished"] if message else ["ready"])
                self.assert_closed(responses[0]["targets"])
                self.assertGreaterEqual(run.call_count, 4)

    def send(self, stream, op, **values):
        stream.write((json.dumps({"schemaVersion": 1, "op": op, **values}) + "\n").encode())
        stream.flush()
        return json.loads(stream.readline())

    def connect(self, server):
        return socket.create_connection(server.server_address, timeout=3)

    def assert_closed(self, targets):
        for target in targets:
            url = urlsplit(target["endpoint"])
            with self.assertRaises(OSError):
                socket.create_connection((url.hostname, url.port), timeout=0.1)

    def test_ping_and_rejected_authentication_do_not_query_hardware(self):
        with patch("subprocess.run") as run, running_server() as server:
            for token, expected in [("bad-token", "error"), ("test-token", "pong")]:
                with self.connect(server) as connection, connection.makefile("rwb") as stream:
                    response = self.send(stream, "ping", token=token)
                    self.assertEqual(response["type"], expected)
            run.assert_not_called()

    def test_multi_card_reads_and_finish_close_all_sampling_ports(self):
        with patch("subprocess.run", side_effect=readonly_query) as run, running_server() as server:
            with self.connect(server) as connection, connection.makefile("rwb") as stream:
                ready = self.send(stream, "sample", token="test-token",
                                  devices=[{"deviceId": 4, "chipId": 0}, {"deviceId": 5, "chipId": 0}])
                self.assertEqual(ready["type"], "ready")
                self.assertEqual([t["deviceId"] for t in ready["targets"]], [4, 5])
                for target in ready["targets"]:
                    with urllib.request.urlopen(target["endpoint"], timeout=2) as response:
                        self.assertIn(('device_id="%d"' % target["deviceId"]).encode(), response.read())
                closed = self.send(stream, "finish")
                self.assertEqual(closed["type"], "finished")
                self.assert_closed(closed["targets"])
            self.assertGreaterEqual(run.call_count, 8)

    def test_client_disconnect_releases_hardware_sampling(self):
        with patch("subprocess.run", side_effect=readonly_query), running_server() as server:
            with self.connect(server) as connection, connection.makefile("rwb") as stream:
                targets = self.send(stream, "sample", token="test-token",
                                    devices=[{"deviceId": 4, "chipId": 0}])["targets"]
            deadline = time.monotonic() + 3
            while time.monotonic() < deadline:
                with server.active_lock:
                    if not server.active:
                        break
                time.sleep(0.02)
            self.assert_closed(targets)

    def test_device_input_cannot_supply_a_command_or_implicit_all_cards(self):
        with patch("subprocess.run") as run, running_server() as server:
            for devices in [[], [{"deviceId": True}], [{"deviceId": 4, "command": "npu-smi set"}],
                            [{"deviceId": 4}, {"deviceId": 4}], [{"deviceId": -1}]]:
                with self.connect(server) as connection, connection.makefile("rwb") as stream:
                    response = self.send(stream, "sample", token="test-token", devices=devices)
                    self.assertEqual(response["type"], "error")
            run.assert_not_called()

    def test_task_runner_does_not_access_devices_or_stop_host_owned_endpoints(self):
        targets = [{"deviceId": 4, "chipId": 0, "endpoint": "http://127.0.0.1:12345/metrics", "errors": []}]
        with tempfile.TemporaryDirectory() as directory, patch("subprocess.run") as run:
            with LocalTelemetry({"ascend": {"mode": "local", "devices": [{"deviceId": 4}]}},
                                Path(directory), targets) as managed:
                self.assertEqual(managed.evidence(), targets)
                self.assertEqual(managed.sources["ascend-4-0"], targets[0])
                self.assertEqual(managed.samplers, [])
            run.assert_not_called()


if __name__ == "__main__":
    unittest.main()
