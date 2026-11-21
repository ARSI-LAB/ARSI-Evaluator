import { expect, test, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyProfileFailure, parseMsprofVersion, probeKernelProfile } from "../../src/plugins/benchmarks/operator/kernel/runtime/profile.js";
import { NpuKernelBackend } from "../../src/plugins/benchmarks/operator/kernel/runtime/npu.js";
import { kernelProbeVerdict } from "../../src/plugins/benchmarks/operator/kernel/result.js";
import { KernelBenchmark, parseKernelConfig } from "../../src/plugins/benchmarks/operator/kernel/index.js";
import type { EnvironmentSession } from "../../src/core/contracts/environment.js";

const sha = "a".repeat(64);

test("msprof version parsing keeps labels and tolerates loose output", () => {
  expect(parseMsprofVersion("msprof version: 7.0.RC1\n")).toBe("7.0.RC1");
  expect(parseMsprofVersion("Version 6.3.0")).toBe("6.3.0");
  expect(parseMsprofVersion("tooling build v8.1.2-beta\n")).toBe("8.1.2-beta");
  expect(parseMsprofVersion("msprof\n")).toBe("msprof");
  expect(parseMsprofVersion("\n\n")).toBeNull();
});

test("profile failures map to stable reasons", () => {
  expect(classifyProfileFailure("anything", true)).toBe("timeout");
  expect(classifyProfileFailure("spawn msprof ENOENT")).toBe("msprof-missing");
  expect(classifyProfileFailure("msprof binary not found: /opt/msprof")).toBe("msprof-missing");
  expect(classifyProfileFailure("msprof exited with 126: Permission denied")).toBe("permission-denied");
  expect(classifyProfileFailure("msprof did not create OPPROF_* directory")).toBe("collection-empty");
  expect(classifyProfileFailure("No valid core pipe metrics")).toBe("collection-empty");
  expect(classifyProfileFailure("unexpected failure")).toBe("msprof-error");
});

function execution(root: string, output: { stdout?: string; stderr?: string; code?: number | null; failure?: Error }) {
  const start = vi.fn<EnvironmentSession["start"]>(async () => {
    if (output.failure) throw output.failure;
    return {
      stdout: (async function* () { if (output.stdout) yield Buffer.from(output.stdout); })(),
      stderr: (async function* () { if (output.stderr) yield Buffer.from(output.stderr); })(),
      done: Promise.resolve({ code: output.code ?? 0, signal: null }), stop: async () => {},
    };
  });
  return { session: { start, workdir: root }, atomDirectory: join(root, "runtime") };
}

test("probe reports an executable profiler and its version", async () => {
  const root = await mkdtemp(join(tmpdir(), "kernel-probe-"));
  try {
    const result = await probeKernelProfile({ collection: "Default" }, {}, execution(root, { stdout: "msprof version: 7.0.RC1\n" }));
    expect(result).toMatchObject({ status: "available", reason: null, collection: "Default", msprofVersion: "7.0.RC1", error: "" });
    expect(result.msprofPath).not.toBeNull();
    expect(result.durationSeconds).toBeGreaterThanOrEqual(0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("probe returns diagnosable outcomes instead of throwing", async () => {
  const root = await mkdtemp(join(tmpdir(), "kernel-probe-"));
  try {
    expect(await probeKernelProfile({}, {}, execution(root, { code: 126, stderr: "Permission denied" })))
      .toMatchObject({ status: "unavailable", reason: "permission-denied", msprofVersion: null });
    expect(await probeKernelProfile({}, {}, execution(root, { code: 1, stderr: "boom" })))
      .toMatchObject({ status: "unavailable", reason: "msprof-error", error: expect.stringContaining("boom") });
    const missing = Object.assign(new Error("spawn msprof ENOENT"), { code: "ENOENT" });
    expect(await probeKernelProfile({}, {}, execution(root, { failure: missing })))
      .toMatchObject({ status: "unavailable", reason: "msprof-missing" });
    expect(await probeKernelProfile({ msprofBin: join(root, "absent-msprof") }, {}, execution(root, {})))
      .toMatchObject({ status: "unavailable", reason: "msprof-missing" });
    expect(await probeKernelProfile({}, {}, execution(root, { stdout: "" })))
      .toMatchObject({ status: "unavailable", reason: "msprof-error", error: expect.stringMatching(/no version/) });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("probe timeouts are evidence while external cancellation propagates", async () => {
  const root = await mkdtemp(join(tmpdir(), "kernel-probe-"));
  try {
    const timedOut = AbortSignal.abort(new DOMException("timed out", "TimeoutError"));
    expect(await probeKernelProfile({}, { signal: timedOut }, execution(root, {})))
      .toMatchObject({ status: "unavailable", reason: "timeout" });
    const cancelled = new AbortController();
    cancelled.abort();
    await expect(probeKernelProfile({}, { signal: cancelled.signal }, execution(root, {}))).rejects.toThrow();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("probe verdicts stay diagnostic and bind identity, collection and reasons", () => {
  const available = { operation: "probe-profile", candidateSha256: sha, referenceKind: "pytorch", timingScope: "all-device-kernels",
    status: "available", reason: null, collection: "Default", msprofVersion: "7.0.RC1", msprofPath: "/opt/msprof",
    durationSeconds: 0.2, error: "" };
  expect(kernelProbeVerdict(available, sha, "pytorch", "Default")).toMatchObject({ passed: null,
    details: { protocol: "kernel-probe/v1", status: "available", msprofVersion: "7.0.RC1" } });
  const unavailable = { ...available, status: "unavailable", reason: "timeout", msprofVersion: null, error: "probe timed out" };
  expect(kernelProbeVerdict(unavailable, sha, "pytorch", "Default")).toMatchObject({ passed: null, details: { reason: "timeout" } });
  for (const value of [
    { ...available, operation: "profile" },
    { ...available, candidateSha256: "b".repeat(64) },
    { ...available, referenceKind: "problem-model" },
    { ...available, collection: "PipeTimeline,Default" },
    { ...available, status: "maybe" },
    { ...available, reason: "timeout" },
    { ...available, msprofVersion: "" },
    { ...available, durationSeconds: -1 },
    { ...unavailable, reason: "unknown" },
    { ...unavailable, msprofVersion: "7.0" },
    { ...unavailable, error: "" },
  ]) expect(() => kernelProbeVerdict(value, sha, "pytorch", "Default")).toThrow();
});

test("profile probe configuration and evaluation kind are explicit", () => {
  const config = parseKernelConfig({ manifest: "m", operation: "probe-profile" });
  expect(config).toMatchObject({ operation: "probe-profile", seeds: [0], profiling: { enabled: false, collection: "PipeTimeline,Default" } });
  expect(new KernelBenchmark(config, "npu").evaluationKind).toBe("performance");
  expect(() => parseKernelConfig({ manifest: "m", operation: "probe-profile", profiling: { enabled: true } })).toThrow(/probe-profile requires profiling.enabled=false/);
  expect(() => parseKernelConfig({ manifest: "m", operation: "probe-profile", seeds: [0, 1] })).toThrow(/single seed/);
  expect(() => parseKernelConfig({ manifest: "m", operation: "dry-run" })).toThrow(/probe-profile/);
});

test("NPU backend serves probe-profile without running the worker", async () => {
  const root = await mkdtemp(join(tmpdir(), "kernel-probe-"));
  const start = vi.fn<EnvironmentSession["start"]>(async () => ({
    stdout: (async function* () { yield Buffer.from("msprof version: 7.0.RC1\n"); })(),
    stderr: (async function* () {})(), done: Promise.resolve({ code: 0, signal: null }), stop: async () => {},
  }));
  const session: EnvironmentSession = { id: "fixture", workdir: root, agentOutputDir: root, verifierOutputDir: root, metadata: null,
    start, upload: async () => {}, download: async () => {}, exportState: async () => { throw new Error("unexpected export"); },
    restoreState: async () => {}, dispose: async () => {} };
  try {
    const backend = new NpuKernelBackend({ python: "fixture", device: 0, profiling: { enabled: false, roundNum: 1, collection: "Default" } });
    const value = await backend.execute({ operation: "probe-profile", candidateSha256: sha, referenceKind: "pytorch",
      candidateRoot: "data/candidate", hashes: {} }, session, AbortSignal.timeout(5000)) as Record<string, unknown>;
    expect(value).toMatchObject({ operation: "probe-profile", candidateSha256: sha, referenceKind: "pytorch",
      timingScope: "all-device-kernels", status: "available", collection: "Default", msprofVersion: "7.0.RC1" });
    expect(start).toHaveBeenCalledTimes(1);
  } finally { await rm(root, { recursive: true, force: true }); }
});
