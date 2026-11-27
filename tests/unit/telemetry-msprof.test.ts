import { expect, test } from "vitest";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { parseTelemetryMsprofConfig, TelemetryMsprofSolver } from "../../src/plugins/solvers/telemetry-msprof.js";

const config = {
  inner: { name: "aisbench-ssh", config: { remote: { ssh: { host: "fixture", user: "bench" } } } },
  target: { mode: "ssh", host: "npu-host", user: "npu", port: 22, identityFile: "/tmp/id" },
  periodSeconds: 60,
  msprof: { deviceIds: "4,5", freqHz: 10, metrics: "ArithmeticUtilization" },
};

test("telemetry msprof wrapper config validates nested solver, target and devices", () => {
  const parsed = parseTelemetryMsprofConfig(config);
  expect(parsed.inner.name).toBe("aisbench-ssh");
  expect(parsed.target).toEqual(config.target);
  expect(parsed.periodSeconds).toBe(60);
  expect(parsed.msprof.devices).toEqual([{ deviceId: 4 }, { deviceId: 5 }]);
  for (const bad of [
    { ...config, inner: { ...config.inner, name: "telemetry-msprof" } },
    { ...config, target: { mode: "docker" } },
    { ...config, periodSeconds: 0 },
    { ...config, msprof: { deviceIds: "4,,5" } },
  ]) expect(() => parseTelemetryMsprofConfig(bad)).toThrow();
});

test("telemetry msprof wrapper preserves the inner result and records collection diagnostics", async () => {
  const root = mkdtempSync(join(tmpdir(), "telemetry-msprof-"));
  let calls = 0;
  const inner = {
    requirements: () => [],
    solve: async () => {
      calls += 1;
      return { finalText: "inner completed", usage: { inputTokens: null, outputTokens: null, totalTokens: null }, observations: { ok: true } };
    },
  };
  const context = {
    key: { runId: "run", taskId: "task", attemptId: "attempt" },
    paths: { root, agent: join(root, "agent"), verifier: join(root, "verifier"), artifacts: join(root, "artifacts") },
    signal: new AbortController().signal,
  };
  const solver = new TelemetryMsprofSolver(parseTelemetryMsprofConfig(config), inner);
  const result = await solver.solve({ id: "task", prompt: "" }, {} as never, context as never);
  expect(result.finalText).toBe("inner completed");
  expect(calls).toBe(1);
  expect(existsSync(join(root, "agent", "msprof-telemetry.json"))).toBe(true);
  expect(existsSync(join(root, "agent", "profiling-diagnostic.json"))).toBe(true);
  const diagnostic = JSON.parse(readFileSync(join(root, "agent", "profiling-diagnostic.json"), "utf8"));
  expect(diagnostic.purpose).toBe("diagnostic");
  expect(diagnostic.msprof.status).toBe("error");
  rmSync(root, { recursive: true, force: true });
}, 20000);

test("helper asset is packaged next to the wrapper build", () => {
  expect(resolve("src/runtimes/agentx/assets/msprof_service.py")).toBeTruthy();
});
