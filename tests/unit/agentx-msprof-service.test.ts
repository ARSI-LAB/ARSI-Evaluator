import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

const python = process.env.PYTHON_BIN ?? (process.platform === "win32" ? "python" : "python3");

test("msprof helper maps npu-smi physical cards to msprof chip IDs", () => {
  const script = `
import importlib.util
import json
import sys
import types

spec = importlib.util.spec_from_file_location("msprof_service", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

mapping_text = """NPU ID  Chip ID  Chip Logic ID  Chip Name
0       0        0              Ascend310P
0       0        1              Ascend310P
1       0        2              Ascend310P
1       0        -              MCU
"""

def run(*_args, **_kwargs):
    return types.SimpleNamespace(returncode=0, stdout=mapping_text)

all_binding = module.resolve_device_binding(["all"], run=run)
explicit_binding = module.resolve_device_binding([0], run=run)
print(json.dumps({"all": all_binding, "explicit": explicit_binding}))
`;
  const result = spawnSync(python, ["-c", script, resolve("src/runtimes/agentx/assets/msprof_service.py")],
    { encoding: "utf8", windowsHide: true, timeout: 20000 });
  expect(result.status, result.stderr).toBe(0);
  const parsed = JSON.parse(result.stdout);
  expect(parsed.all).toEqual([
    ["all"], [0, 1, 2], { "0": [0, 1], "1": [2] },
  ]);
  expect(parsed.explicit).toEqual([
    [0], [0, 1], { "0": [0, 1], "1": [2] },
  ]);
}, 25000);

test("msprof helper distinguishes harness stop from traffic timeout", () => {
  const root = mkdtempSync(join(tmpdir(), "msprof-stop-"));
  mkdirSync(join(root, "msprof"), { recursive: true });
  writeFileSync(join(root, "msprof", "STOP"), new Date().toISOString() + "\n");
  const script = `
import importlib.util
import json
import sys

spec = importlib.util.spec_from_file_location("msprof_service", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
module.resolve_device_binding = lambda devices, run=None: ([0], [0], {"0": [0]})
module.resolve_msprof = lambda explicit: "fake-msprof"
raise SystemExit(module.main(["--config", json.dumps({"devices": [0], "metricsUrl": "http://127.0.0.1:9/metrics", "waitForTraffic": True, "periodSec": 60}), "--artifacts", sys.argv[2]]))
`;
  try {
    const result = spawnSync(python, ["-c", script, resolve("src/runtimes/agentx/assets/msprof_service.py"), root],
      { encoding: "utf8", windowsHide: true, timeout: 20000 });
    expect(result.status, result.stderr).toBe(1);
    expect(JSON.parse(result.stdout.trim())).toEqual({ status: "error", code: "harness_requested_before_collection" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 25000);

test("msprof helper exports evidence after a harness-requested nonzero stop", () => {
  const root = mkdtempSync(join(tmpdir(), "msprof-export-"));
  const raw = join(root, "msprof", "raw", "PROF_000001", "device_0");
  mkdirSync(raw, { recursive: true });
  writeFileSync(join(root, "msprof", "STOP"), new Date().toISOString() + "\n");
  writeFileSync(join(raw, "ai_core_utilization.csv"), "Device ID,mac_fp16_ratio,mac_int8_ratio\n0,0.25,\n0,0.75,\n");
  const script = `
import importlib.util
import json
import subprocess
import sys

spec = importlib.util.spec_from_file_location("msprof_service", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
module.resolve_device_binding = lambda devices, run=None: ([0], [0], {"0": [0]})
module.resolve_msprof = lambda explicit: "fake-msprof"

class Collector:
    returncode = None
    def communicate(self, timeout=None):
        if timeout is not None:
            raise subprocess.TimeoutExpired("fake-msprof", timeout)
        self.returncode = -15
        return "", ""

collector = Collector()
module.subprocess.Popen = lambda *args, **kwargs: collector
module._terminate_collector = lambda proc: setattr(proc, "returncode", -15)
raise SystemExit(module.main(["--config", json.dumps({"devices": [0], "periodSec": 60}), "--artifacts", sys.argv[2]]))
`;
  try {
    const result = spawnSync(python, ["-c", script, resolve("src/runtimes/agentx/assets/msprof_service.py"), root],
      { encoding: "utf8", windowsHide: true, timeout: 20000 });
    expect(result.status, result.stderr).toBe(0);
    const completed = JSON.parse(result.stdout.trim());
    expect(completed.status).toBe("completed");
    expect(completed.summary.requestedDevices).toEqual([0]);
    expect(completed.summary.resolvedDevices).toEqual([0]);
    expect(completed.summary.devices["0"]).toMatchObject({ mac_fp16_ratio: 0.5, samples: 2 });
    expect(completed.window.stop_mode).toBe("harness-requested");
    expect(completed.window.collector_returncode).toBe(-15);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 25000);
