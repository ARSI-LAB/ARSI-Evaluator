import { spawnSync } from "node:child_process";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test, vi } from "vitest";
import { NpuKernelBackend } from "../../src/plugins/benchmarks/operator/kernel/runtime/npu.js";
import { createKernelBackend } from "../../src/plugins/benchmarks/operator/kernel/runtime/backend.js";
import type { EnvironmentSession } from "../../src/core/contracts/environment.js";

const python = process.env.PYTHON_BIN ?? (process.platform === "win32" ? "python" : "python3");
const available = spawnSync(python, ["--version"], { windowsHide: true }).status === 0;
test.skipIf(!available)("NPU timing honors the selected device and never probes CUDA or falls back to CPU", () => {
  const result = spawnSync(python, [resolve("tests/fixtures/kernel/check-npu-timing.py"), resolve("src/plugins/benchmarks/operator/kernel/runtime/timing.py")],
    { encoding: "utf8", windowsHide: true, timeout: 10000, env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
  expect(result.status, result.stderr).toBe(0);
});

const SHA = "a".repeat(64);
const request = { operation: "evaluate", candidateRoot: "data/candidate", hashes: { "data/candidate/kernel.py": SHA },
  candidateSha256: SHA, referenceKind: "pytorch" };
const response = { operation: "evaluate", candidateSha256: SHA, referenceKind: "pytorch",
  timingScope: "all-device-kernels", status: "incorrect", error: "fixture mismatch",
  referenceMs: null, candidateMs: null, speedup: null };

function fixture(root: string, output: { stdout?: string; stderr?: string; code?: number | null; signal?: string | null } = {}): EnvironmentSession {
  return { id: "fixture", workdir: root, agentOutputDir: root, verifierOutputDir: root, metadata: null,
    start: vi.fn<EnvironmentSession["start"]>(async () => ({
      stdout: (async function* () { if (output.stdout) yield Buffer.from(output.stdout); })(),
      stderr: (async function* () { if (output.stderr) yield Buffer.from(output.stderr); })(),
      done: Promise.resolve({ code: output.code ?? 0, signal: output.signal ?? null }), stop: async () => {},
    })),
    upload: async () => {}, download: async () => {}, exportState: async () => { throw new Error("unexpected export"); },
    restoreState: async () => {}, dispose: async () => {} };
}

test("NPU backend keeps device environment, packaged files and worker protocol", async () => {
  const backend = new NpuKernelBackend({ python: "fixture-python", device: 3, profiling: { enabled: false, roundNum: 1 } });
  expect(backend.environment()).toEqual({ ASCEND_VISIBLE_DEVICES: "3", ASCEND_RT_VISIBLE_DEVICES: "3", KERNEL_NPU_DEVICE: "0" });
  await Promise.all(backend.runtimeFiles().map(file => access(file.origin)));
  const root = await mkdtemp(join(tmpdir(), "kernel-npu-"));
  try {
    expect(() => createKernelBackend("gpu", { python: "must-not-start", device: 0, profiling: { enabled: false, roundNum: 1 } })).toThrow(/GPU backend is not implemented/);
    await writeFile(join(root, "kernel-result.json"), JSON.stringify(response));
    const session = fixture(root, { stdout: "native profiler noise, not JSON", stderr: "worker diagnostics" });
    expect(await backend.execute(request, session, AbortSignal.timeout(5000))).toEqual(response);
    expect(session.start).toHaveBeenCalledWith(expect.objectContaining({ executable: "fixture-python",
      args: ["runtime/precision.py", "--output", join(root, "kernel-result.json")], input: Buffer.from(JSON.stringify(request)) }), expect.any(AbortSignal));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("the result file stays authoritative even when stdout carries different JSON", async () => {
  const root = await mkdtemp(join(tmpdir(), "kernel-npu-"));
  const backend = new NpuKernelBackend({ python: "fixture-python", device: 0, profiling: { enabled: false, roundNum: 1 } });
  try {
    await writeFile(join(root, "kernel-result.json"), JSON.stringify(response));
    const stdout = JSON.stringify({ ...response, error: "stdout evidence" });
    expect(await backend.execute(request, fixture(root, { stdout }), AbortSignal.timeout(5000))).toEqual(response);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("worker protocol, identity, exit and timeout failures become retryable infrastructure results", async () => {
  const root = await mkdtemp(join(tmpdir(), "kernel-npu-"));
  const backend = new NpuKernelBackend({ python: "fixture-python", device: 0, profiling: { enabled: false, roundNum: 1 } });
  const run = async (output: Parameters<typeof fixture>[1], signal = AbortSignal.timeout(5000)) =>
    await backend.execute(request, fixture(root, output), signal) as Record<string, unknown>;
  try {
    const missing = await run({ stdout: "x".repeat(5000) });
    expect(missing).toMatchObject({ status: "infrastructure_error", code: "WORKER_PROTOCOL_INVALID",
      retryable: true, errorOwnership: "evaluation", error: expect.stringMatching(/valid result file/) });
    expect((missing.diagnostics as { message: string }[])[0]?.message).toMatch(/stdout: x{4096}$/);

    await writeFile(join(root, "kernel-result.json"), JSON.stringify({ ...response, candidateSha256: "b".repeat(64) }));
    expect(await run({})).toMatchObject({ status: "infrastructure_error", code: "WORKER_PROTOCOL_INVALID" });

    await writeFile(join(root, "kernel-result.json"), "[]");
    expect(await run({})).toMatchObject({ status: "infrastructure_error", code: "WORKER_PROTOCOL_INVALID", error: expect.stringMatching(/not an object/) });

    await writeFile(join(root, "kernel-result.json"), JSON.stringify(response));
    expect(await run({ code: 137 })).toMatchObject({ status: "infrastructure_error", code: "WORKER_EXIT", retryable: true });

    const timedOut = await run({}, AbortSignal.abort(new DOMException("timed out", "TimeoutError")));
    expect(timedOut).toMatchObject({ status: "infrastructure_error", code: "WORKER_TIMEOUT", retryable: true });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("external cancellation is propagated instead of becoming a candidate verdict", async () => {
  const root = await mkdtemp(join(tmpdir(), "kernel-npu-"));
  const backend = new NpuKernelBackend({ python: "fixture-python", device: 0, profiling: { enabled: false, roundNum: 1 } });
  try {
    const controller = new AbortController();
    const session = fixture(root);
    session.start = vi.fn<EnvironmentSession["start"]>(async (_spec, signal) => {
      controller.abort();
      signal?.throwIfAborted();
      throw new Error("unreachable");
    });
    await expect(backend.execute(request, session, controller.signal)).rejects.toThrow();
  } finally { await rm(root, { recursive: true, force: true }); }
});
