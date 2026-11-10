import { expect, test, vi } from "vitest";
import { cp, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { kernelProfile } from "../../src/adapters/kernel/profile.js";
import { KernelBenchmark, parseKernelConfig } from "../../src/plugins/benchmarks/protocols/kernel/index.js";
import type { EnvironmentSession, CommandSpec, ProcessHandle } from "../../src/core/contracts/environment.js";

async function fixture(
  mode: "complete" | "missing" | "cleanup" | "no-trace" | "missing-l2" | "wrong-seed" | "wrong-capture" = "complete",
  device = 0,
  operation: "evaluate" | "profile" = "profile",
  collection?: "Default" | "PipeTimeline,Default",
  processOptions: {
    attempts?: { writeEvidence: boolean; code: number }[];
    outputBytes?: number;
    exitCode?: number;
    outputLimitBytes?: number;
    cleanupGraceMs?: number;
    cleanupTimeoutMs?: number;
    inputUnmodified?: boolean;
    candidateTree?: boolean;
    helperKernel?: boolean;
    nestedReference?: boolean;
  } = {},
) {
  const { attempts, outputBytes = 0, exitCode = 0, inputUnmodified, candidateTree, helperKernel, nestedReference, ...limits } = processOptions;
  const dir = await mkdtemp(join(tmpdir(), "kernel-profile-sdk-"));
  const manifest = join(dir, "manifest.json");
  await writeFile(join(dir, "problem.py"), "class Model: pass\n");
  await writeFile(join(dir, "candidate.py"), "def kernel_function(x): return x\n");
  if (candidateTree) {
    await mkdir(join(dir, "candidate/kernels"), { recursive: true });
    await writeFile(join(dir, "candidate/kernels/problem.py"), "from .tiling import run\ndef kernel_function(x): return run(x)\n");
    await writeFile(join(dir, "candidate/kernels/__init__.py"), "");
    await writeFile(join(dir, "candidate/kernels/tiling.py"), "def run(x): return x\n");
    if (helperKernel) await writeFile(join(dir, "candidate/kernels/tiling.py"), "import triton\n@triton.jit\ndef vector_add_impl(x): pass\ndef run(x): return x\n");
  }
  if (nestedReference) {
    await mkdir(join(dir, "refs/pkg"), { recursive: true });
    await writeFile(join(dir, "refs/__init__.py"), "");
    await writeFile(join(dir, "refs/pkg/__init__.py"), "");
    await writeFile(join(dir, "refs/inputs.py"), "def make_inputs(): return [1]\n");
    await writeFile(join(dir, "refs/pkg/problem.py"), "from ..inputs import make_inputs\nclass Model: pass\nget_inputs = make_inputs\n");
  }
  const tensor = { dtype: "float16", shape: [1], contiguous: true };
  const contract = { schemaVersion: 1, caseId: "fixed", inputs: [tensor], output: { ...tensor, independent: true }, inputUnmodified };
  await writeFile(manifest, JSON.stringify({ schemaVersion: 1, tasks: [{ id: "fixed", problem: "problem.py", candidate: "candidate.py", referenceKind: "pytorch",
    ...(candidateTree ? { candidate: "candidate/kernels/problem.py", candidateRoot: "candidate",
      files: ["candidate/kernels/__init__.py", "candidate/kernels/tiling.py",
        ...(nestedReference ? ["refs/__init__.py", "refs/pkg/__init__.py", "refs/inputs.py"] : [])] } : {}),
    ...(nestedReference ? { problem: "refs/pkg/problem.py" } : {}),
    ...(inputUnmodified === undefined ? {} : { contract }) }] }));
  const workdir = join(dir, "work");
  const verifierOutputDir = join(workdir, "verifier");
  await mkdir(verifierOutputDir, { recursive: true });
  const commands: CommandSpec[] = [];
  let stopped = 0;
  const stopGrace: number[] = [];
  let replayRequest: unknown;
  const session: EnvironmentSession = {
    id: "session", workdir, verifierOutputDir, agentOutputDir: join(workdir, "agent"), metadata: null,
    async upload(source, target) { await mkdir(dirname(join(workdir, target)), { recursive: true }); await cp(source, join(workdir, target)); },
    async download(source, target) { await cp(join(workdir, source), target); },
    async exportState() { throw new Error("unused"); }, async restoreState() {}, async dispose() {},
    async start(command, signal): Promise<ProcessHandle> {
      signal.throwIfAborted(); commands.push(command);
      if (!command.args.includes("op")) throw new Error("profile unexpectedly ran precision or benchmark");
      const outArg = command.args.find(arg => arg.startsWith("--output="));
      const appArg = command.args.find(arg => arg.startsWith("--application="));
      if (!outArg || !appArg) throw new Error("missing msprof args");
      const requestPath = appArg.match(/--request ([^ ]+)/)?.[1];
      const resultPath = appArg.match(/--output ([^ ]+)/)?.[1];
      if (!requestPath || !resultPath) throw new Error("missing replay args");
      replayRequest = JSON.parse(await readFile(requestPath, "utf8"));
      const attempt = attempts?.[commands.length - 1];
      if (mode !== "missing" && mode !== "cleanup" && attempt?.writeEvidence !== false) {
        const profile = join(outArg.slice("--output=".length), "OPPROF_fixture");
        await mkdir(profile, { recursive: true });
        await writeFile(join(profile, "PipeUtilization.csv"), "block_id,sub_block_id,aiv_vec_ratio,aiv_scalar_ratio,aiv_mte2_ratio,aiv_mte3_ratio,aiv_time(us)\n0,vector,0.7,0.2,0.4,0.1,10\n");
        if (mode !== "missing-l2") await writeFile(join(profile, "L2Cache.csv"), "block_id,sub_block_id\n0,vector\n");
        await writeFile(join(profile, "ResourceConflictRatio.csv"), "block_id,aiv_vec_wait_ratio\n0,0.1\n");
        if (mode === "complete") await writeFile(join(profile, "trace.json"), JSON.stringify({ traceEvents: [{ pid: "core0.veccore0", tid: "VECTOR", ts: 0, dur: 10 }] }));
        await writeFile(resultPath, JSON.stringify({ inputUnmodified: (replayRequest as { inputUnmodified?: boolean }).inputUnmodified,
          seed: mode === "wrong-seed" ? 41 : 42, warmup: 7, requestedLogicalDevice: 0, logicalDevice: 0, deviceCount: 1, capture: { method: "mstx", range: "rsi_operator_profile", toolId: 4097, rangeId: 0, warmupCompleted: mode === "wrong-capture" ? 6 : 7, callsInRange: 1 }, deviceName: "Ascend950PR", inputContract: "unchanged problem.get_inputs", environment: { device: "fixture950 logical=0", visibleDevices: "0" } }));
      }
      return { stdout: (async function* () { if (outputBytes) yield Buffer.from("x".repeat(outputBytes)); })(), stderr: (async function* () {})(), done: Promise.resolve({ code: attempt?.code ?? exitCode, signal: null }),
        async stop(grace) { stopped++; stopGrace.push(grace); if (mode === "cleanup") throw new Error("cannot stop"); } };
    },
  };
  const benchmark = new KernelBenchmark(parseKernelConfig({ operation, device, manifest, seeds: [42], timeoutSeconds: 20, ...limits,
    profiling: {
      enabled: true, warmup: 7, cacheEnabled: false, maxAttempts: attempts?.length ?? 1,
      attemptTimeoutSeconds: 10, retryDelayMs: 0, ...(collection === undefined ? {} : { collection }),
    },
  }));
  const signal = new AbortController().signal;
  const source = await benchmark.resolveSource(null, signal);
  const task = await benchmark.prepare({ id: "fixed", recordKey: "fixed" }, source, signal);
  for (const file of task.solveEnv.initialFiles) await session.upload(file.source, file.target, signal);
  const payload = task.input.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload) || typeof payload.candidateSha256 !== "string") throw new Error("missing candidate hash");
  const solve = { finalText: payload.candidateSha256, usage: { inputTokens: null, outputTokens: null, totalTokens: null } };
  return { dir, commands, benchmark, task, session, signal, solve, stopGrace, request: () => replayRequest, stopped: () => stopped };
}

test("profiling honors configured output capacity and cleanup grace", async () => {
  const f = await fixture("complete", 0, "profile", "Default", { outputBytes: 1024, outputLimitBytes: 8, cleanupGraceMs: 43 });
  try {
    const verdict = await f.benchmark.verify(f.task, f.solve, f.session, f.signal);
    expect(verdict).toMatchObject({ passed: null, details: { status: "unavailable", profiling: { error: expect.stringContaining("output exceeds limit") } } });
    expect(f.stopGrace).toEqual([43, 43]);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test("failed profiler preserves complete native console output", async () => {
  const f = await fixture("complete", 0, "profile", "Default", { outputBytes: 5000, exitCode: 1 });
  try {
    const verdict = await f.benchmark.verify(f.task, f.solve, f.session, f.signal);
    expect(verdict).toMatchObject({ passed: null, details: { status: "unavailable" } });
    const consoleText = await readFile(join(f.session.verifierOutputDir, "kernel-profile_profiling_root/profiling/logs/console.log"), "utf8");
    expect(consoleText).toBe("x".repeat(5000));
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test("independent profile uses the SDK session and frozen seed without running precision or benchmark", async () => {
  const f = await fixture();
  try {
    expect(f.benchmark.evaluationKind).toBe("performance");
    const verdict = await f.benchmark.verify(f.task, f.solve, f.session, f.signal);
    expect(verdict.passed).toBeNull(); expect(verdict).not.toHaveProperty("score");
    expect(verdict.details).toMatchObject({ operation: "profile", protocol: "kernel-profile/v1", status: "completed", cleanup: "confirmed",
      diagnosticProtocol: { caseId: "fixed", seeds: [42], warmup: 7, collection: "PipeTimeline,Default", capture: "after-warmup-mstx-range", selectionPolicy: "last" },
      profiling: { status: "completed", metadata: { attempts: 1, retryPolicy: { retryDelayMs: 0 }, trace: { status: "available", artifact: "trace.json" }, hardwareDerived: { ubRatio: "unavailable", coreUtilization: "unavailable" } } } });
    expect(verdict.details).not.toHaveProperty("candidateMs");
    expect(f.request()).toMatchObject({ seeds: [42], warmup: 7 });
    expect(f.request()).not.toHaveProperty("repeat"); expect(f.request()).not.toHaveProperty("rtol");
    expect(f.commands).toHaveLength(1); expect(f.stopped()).toBeGreaterThanOrEqual(1);
    expect(f.commands[0]?.args).toContain("--mstx=on");
    expect(f.commands[0]?.args).toContain("--mstx-include=rsi_operator_profile");
    const raw = await readFile(join(f.session.verifierOutputDir, "kernel-profile.raw.json"), "utf8");
    expect(raw).not.toContain('"core_utilization"'); expect(raw).not.toContain('"ub_ratio"');
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test("a successful retry with no output cannot claim the failed attempt's capture", async () => {
  const f = await fixture("complete", 0, "profile", "Default", {
    attempts: [{ writeEvidence: true, code: 1 }, { writeEvidence: false, code: 0 }],
  });
  try {
    const verdict = await f.benchmark.verify(f.task, f.solve, f.session, f.signal);
    expect(f.commands).toHaveLength(2);
    expect(verdict.details).toMatchObject({
      status: "unavailable",
      profiling: { status: "failed", kernels: [], metadata: { attempts: 2 } },
    });
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test("a retry publishes evidence from the successful attempt and retains both logs", async () => {
  const f = await fixture("complete", 0, "profile", "Default", {
    outputBytes: 5, attempts: [{ writeEvidence: true, code: 1 }, { writeEvidence: true, code: 0 }],
  });
  try {
    const verdict = await f.benchmark.verify(f.task, f.solve, f.session, f.signal);
    expect(verdict.details).toMatchObject({ profiling: {
      status: "completed",
      artifacts: expect.arrayContaining([
        expect.stringMatching(/logs\/console\.log$/), expect.stringMatching(/logs\/console-attempt-2\.log$/),
      ]),
      kernels: [{ artifacts: expect.not.arrayContaining([expect.stringContaining("/attempt-1/")]),
        metadata: { profileDir: expect.stringContaining("/attempt-2/") } }],
    } });
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test("a repeated capture links evidence from its own output directory", async () => {
  const f = await fixture();
  try {
    const firstRoot = join(f.session.verifierOutputDir, "kernel-profile_profiling_root");
    await mkdir(firstRoot);
    const verdict = await f.benchmark.verify(f.task, f.solve, f.session, f.signal);
    expect(verdict.details).toMatchObject({ profiling: {
      artifacts: expect.arrayContaining(["kernel-profile_profiling_root_1/profiling/result.json"]),
    } });
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test("missing diagnostic artifacts are unavailable, not candidate failure, and retain raw evidence", async () => {
  const f = await fixture("missing");
  try {
    const verdict = await f.benchmark.verify(f.task, f.solve, f.session, f.signal);
    expect(verdict).toMatchObject({ passed: null, details: { status: "unavailable", cleanup: "confirmed", profiling: { status: "failed" } } });
    expect(verdict).not.toHaveProperty("score");
    expect(await readFile(join(f.session.verifierOutputDir, "kernel-profile.raw.json"), "utf8")).toContain("msprof did not create");
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test("profile replays receive the manifest's mutable input policy", async () => {
  const f = await fixture("complete", 0, "profile", "Default", { inputUnmodified: false });
  try {
    const verdict = await f.benchmark.verify(f.task, f.solve, f.session, f.signal);
    expect(verdict.details).toMatchObject({ status: "completed" });
    expect(f.request()).toMatchObject({ inputUnmodified: false });
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test("unconfirmed profile cleanup remains an infrastructure error", async () => {
  const f = await fixture("cleanup");
  try { await expect(f.benchmark.verify(f.task, f.solve, f.session, f.signal)).rejects.toThrow(/cleanup unconfirmed/i); }
  finally { await rm(f.dir, { recursive: true, force: true }); }
});

test("independent profile defaults to fresh evidence and a single deterministic seed", () => {
  const base = { operation: "profile", manifest: "m" };
  expect(parseKernelConfig(base)).toMatchObject({ seeds: [0], profiling: { enabled: true, cacheEnabled: false } });
  expect(parseKernelConfig({ ...base, seeds: [42] }).seeds).toEqual([42]);
  expect(() => parseKernelConfig({ ...base, seeds: [1, 2] })).toThrow(/single seed/i);
  expect(() => parseKernelConfig({ ...base, profiling: { enabled: false } })).toThrow(/enabled/i);
  expect(() => parseKernelConfig({ ...base, profiling: { cacheEnabled: true } })).toThrow(/cache/i);
});


test("cancelling an SDK diagnostic propagates without starting precision or another replay", async () => {
  const f = await fixture();
  try {
    const controller = new AbortController(); controller.abort(new Error("cancelled diagnostic"));
    await expect(f.benchmark.verify(f.task, f.solve, f.session, controller.signal)).rejects.toThrow(/cancelled diagnostic/);
    expect(f.commands).toHaveLength(0);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});


test.each([
  { device: 0, visible: "0" },
  { device: 3, visible: "3" },
])("profile binds only configured device $device despite inherited multi-card visibility", async ({ device, visible }) => {
  vi.stubEnv("ASCEND_VISIBLE_DEVICES", "0,1");
  vi.stubEnv("ASCEND_RT_VISIBLE_DEVICES", "0,1");
  const f = await fixture("complete", device);
  try {
    const verdict = await f.benchmark.verify(f.task, f.solve, f.session, f.signal);
    expect(verdict.details).toMatchObject({ status: "completed" });
    expect(f.commands).toHaveLength(1);
    expect(f.commands[0]?.env).toMatchObject({
      ASCEND_VISIBLE_DEVICES: visible,
      ASCEND_RT_VISIBLE_DEVICES: visible,
      KERNEL_NPU_DEVICE: "0",
    });
    expect(f.task.solveEnv.env).toMatchObject({
      ASCEND_VISIBLE_DEVICES: visible,
      ASCEND_RT_VISIBLE_DEVICES: visible,
      KERNEL_NPU_DEVICE: "0",
    });
    expect(f.commands[0]?.env?.PRESERVE_ENV?.split(",")).toEqual(expect.arrayContaining([
      "ASCEND_VISIBLE_DEVICES", "ASCEND_RT_VISIBLE_DEVICES", "KERNEL_NPU_DEVICE",
    ]));
  } finally {
    vi.unstubAllEnvs();
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("evaluate prepares a single configured card with logical device zero", async () => {
  vi.stubEnv("ASCEND_VISIBLE_DEVICES", "0,1");
  vi.stubEnv("ASCEND_RT_VISIBLE_DEVICES", "0,1");
  const f = await fixture("complete", 0, "evaluate");
  try {
    expect(f.task.solveEnv.env).toMatchObject({
      ASCEND_VISIBLE_DEVICES: "0",
      ASCEND_RT_VISIBLE_DEVICES: "0",
      KERNEL_NPU_DEVICE: "0",
    });
    expect(f.commands).toHaveLength(0);
  } finally {
    vi.unstubAllEnvs();
    await rm(f.dir, { recursive: true, force: true });
  }
});


test.each(["no-trace", "complete"] as const)("explicit Default diagnostics use PMU evidence and ignore pipeline trace (%s)", async (mode) => {
  const f = await fixture(mode, 0, "profile", "Default");
  try {
    const verdict = await f.benchmark.verify(f.task, f.solve, f.session, f.signal);
    expect(verdict).toMatchObject({ passed: null, details: {
      status: "completed", cleanup: "confirmed", diagnosticProtocol: { collection: "Default", capture: "after-warmup-mstx-range" },
      profiling: { metadata: { collection: "Default",
        trace: { status: "unavailable", reason: "not-requested-by-default-protocol" },
        replay: { seed: 42, warmup: 7, environment: { device: "fixture950 logical=0", visibleDevices: "0" } } },
        analysis: { trace: null, roofline: { vec_rate: 0.7 } } },
    } });
    expect(verdict).not.toHaveProperty("score");
    expect(f.commands).toHaveLength(1);
    expect(f.commands[0]?.args).toContain("--aic-metrics=Default");
    expect(f.stopped()).toBeGreaterThanOrEqual(1);
    const output: unknown = JSON.parse(await readFile(join(f.session.verifierOutputDir, "kernel-profile.json"), "utf8"));
    expect(output).toMatchObject({ trace_analysis: null, roofline: { vec_rate: 0.7 } });
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test("full diagnostics still require trace and never retry as Default", async () => {
  const f = await fixture("no-trace");
  try {
    const verdict = await f.benchmark.verify(f.task, f.solve, f.session, f.signal);
    expect(verdict).toMatchObject({ passed: null, details: {
      status: "unavailable", diagnosticProtocol: { collection: "PipeTimeline,Default" },
      profiling: { status: "failed", error: expect.stringContaining("No trace.json") },
    } });
    expect(f.commands).toHaveLength(1);
    expect(f.commands[0]?.args).toContain("--aic-metrics=PipeTimeline,Default");
    expect(f.commands[0]?.args).not.toContain("--aic-metrics=Default");
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test("Default diagnostics still require the complete PMU CSV set", async () => {
  const f = await fixture("missing-l2", 0, "profile", "Default");
  try {
    const verdict = await f.benchmark.verify(f.task, f.solve, f.session, f.signal);
    expect(verdict).toMatchObject({ passed: null, details: { status: "unavailable", diagnosticProtocol: { collection: "Default" },
      profiling: { error: expect.stringContaining("No L2Cache.csv") } } });
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test("profiling collection is explicit, defaults to full, and rejects unsupported values", () => {
  expect(parseKernelConfig({ manifest: "m" }).profiling).toMatchObject({ collection: "PipeTimeline,Default" });
  expect(parseKernelConfig({ manifest: "m", profiling: { collection: "Default" } }).profiling).toMatchObject({ collection: "Default" });
  for (const collection of [null, "default", "PipeTimeline", "Default,PipeTimeline", ["Default"], 0])
    expect(() => parseKernelConfig({ manifest: "m", profiling: { collection } })).toThrow(/profiling.collection/);
});


test("Default diagnostics retain the actual replay seed check", async () => {
  const f = await fixture("wrong-seed", 0, "profile", "Default");
  try {
    const verdict = await f.benchmark.verify(f.task, f.solve, f.session, f.signal);
    expect(verdict).toMatchObject({ passed: null, details: { status: "unavailable", diagnosticProtocol: { collection: "Default" },
      profiling: { error: expect.stringContaining("Replay effective input protocol mismatch") } } });
    expect(f.commands).toHaveLength(1);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});


test.each(["Default", "PipeTimeline,Default"] as const)("diagnostics require actual capture receipts (%s)", async (collection) => {
  const f = await fixture("wrong-capture", 0, "profile", collection);
  try {
    const verdict = await f.benchmark.verify(f.task, f.solve, f.session, f.signal);
    expect(verdict).toMatchObject({ passed: null, details: { status: "unavailable", diagnosticProtocol: { collection },
      profiling: { error: expect.stringContaining("Replay effective capture protocol mismatch") } } });
    expect(f.commands).toHaveLength(1);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});


test("capture cache preserves receipts and separates collection and seed protocols", async () => {
  const f = await fixture();
  try {
    const args = { problem: join(f.dir, "problem.py"), kernel: join(f.dir, "candidate.py"),
      round: 1, seed: 42, warmup: 7, caseId: "fixed", cacheEnabled: true, cacheDir: join(f.dir, "cache") };
    const options = { env: { ASCEND_RT_VISIBLE_DEVICES: "0", KERNEL_NPU_DEVICE: "0" } };
    const execution = { session: f.session, atomDirectory: join(f.session.workdir, "runtime") };
    const first = await kernelProfile({ ...args, collection: "Default", out: join(f.dir, "first.json") }, options, execution);
    expect(first.error).toBe("");
    const cached = await kernelProfile({ ...args, collection: "Default", out: join(f.dir, "cached.json") }, options, execution);
    expect(cached.error).toBe("");
    const cachedRaw: unknown = JSON.parse(await readFile(join(f.dir, "cached.raw.json"), "utf8"));
    expect(cachedRaw).toMatchObject({ status: "completed", metadata: { cacheHit: true,
      replay: { seed: 42, capture: { method: "mstx", warmupCompleted: 7, callsInRange: 1 } } } });
    expect(f.commands).toHaveLength(1);
    const full = await kernelProfile({ ...args, collection: "PipeTimeline,Default", out: join(f.dir, "full.json") }, options, execution);
    expect(full.error).toBe("");
    expect(f.commands).toHaveLength(2);
    expect(f.commands[0]?.args).toContain("--aic-metrics=Default");
    expect(f.commands[1]?.args).toContain("--aic-metrics=PipeTimeline,Default");
    const differentSeed = await kernelProfile({ ...args, seed: 43, collection: "Default", out: join(f.dir, "seed43.json") }, options, execution);
    expect(differentSeed.error).toContain("Replay effective input protocol mismatch");
    expect(f.commands).toHaveLength(3);
    const mutable = await kernelProfile({ ...args, inputUnmodified: false, collection: "Default", out: join(f.dir, "mutable.json") }, options, execution);
    expect(mutable.error).toBe("");
    expect(f.commands).toHaveLength(4);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test("SDK profiling stages the declared candidate tree and binds every helper hash", async () => {
  const f = await fixture("complete", 0, "profile", "Default", { candidateTree: true });
  try {
    const verdict = await f.benchmark.verify(f.task, f.solve, f.session, f.signal);
    expect(verdict).toMatchObject({ details: { status: "completed" } });
    const request = f.request() as { candidateRoot: string; candidate: string; hashes: Record<string, string>; problem: string };
    expect(request.candidate).toBe(join(request.candidateRoot, "kernels/problem.py"));
    expect(request.candidate).not.toBe(request.problem);
    expect(await readFile(join(request.candidateRoot, "kernels/tiling.py"), "utf8")).toBe("def run(x): return x\n");
    expect(Object.keys(request.hashes).sort()).toEqual([
      ...["data/problem.py", "data/candidate/kernels/__init__.py", "data/candidate/kernels/problem.py", "data/candidate/kernels/tiling.py",
        "runtime/precision.py", "runtime/timing.py", "runtime/strict.py", "runtime/timing_evidence.py", "runtime/msprof_replay.py"]
        .map(path => join(f.session.workdir, path)),
      join(request.candidateRoot, "kernels/__init__.py"), request.candidate, join(request.candidateRoot, "kernels/tiling.py")].sort());
    const raw = JSON.parse(await readFile(join(f.session.verifierOutputDir, "kernel-profile.raw.json"), "utf8"));
    expect(raw.metadata.sources.candidateFiles).toEqual(await treeFiles(join(f.dir, "candidate")));
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

async function treeFiles(root: string) {
  return Promise.all(["kernels/__init__.py", "kernels/problem.py", "kernels/tiling.py"].map(async path => ({ path,
    sha256: createHash("sha256").update(await readFile(join(root, path))).digest("hex") })));
}

test("profile cache invalidates when only a helper changes and preserves tree evidence on hits", async () => {
  const f = await fixture("complete", 0, "profile", "Default", { candidateTree: true });
  try {
    const candidateRoot = join(f.dir, "candidate");
    const args = { problem: join(f.dir, "problem.py"), kernel: join(candidateRoot, "kernels/problem.py"), candidateRoot,
      round: 1, seed: 42, warmup: 7, caseId: "fixed", collection: "Default" as const, cacheEnabled: true, cacheDir: join(f.dir, "tree-cache") };
    const options = { env: { ASCEND_RT_VISIBLE_DEVICES: "0", KERNEL_NPU_DEVICE: "0" } };
    const execution = { session: f.session, atomDirectory: join(f.session.workdir, "runtime") };
    const firstFiles = await treeFiles(candidateRoot);
    for (const out of ["tree-first", "tree-hit"]) {
      expect((await kernelProfile({ ...args, candidateFiles: firstFiles, out: join(f.dir, `${out}.json`) }, options, execution)).error).toBe("");
    }
    expect(f.commands).toHaveLength(1);
    await writeFile(join(candidateRoot, "kernels/tiling.py"), "def run(x): return x + 1\n");
    const changedFiles = await treeFiles(candidateRoot);
    expect((await kernelProfile({ ...args, candidateFiles: changedFiles, out: join(f.dir, "tree-changed.json") }, options, execution)).error).toBe("");
    expect(f.commands).toHaveLength(2);
    const raw = JSON.parse(await readFile(join(f.dir, "tree-changed.raw.json"), "utf8"));
    expect(raw.metadata.sources.candidateFiles).toEqual(changedFiles);
    expect(raw.metadata.sources.candidate.sha256).toBe(firstFiles[1]?.sha256);
    const hit = JSON.parse(await readFile(join(f.dir, "tree-hit.raw.json"), "utf8"));
    expect(hit.metadata).toMatchObject({ cacheHit: true, sources: { candidateFiles: firstFiles } });
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test("explicit profile trees reject unsafe, changed, missing and incomplete source inventories", async () => {
  const f = await fixture("complete", 0, "profile", "Default", { candidateTree: true });
  try {
    const candidateRoot = join(f.dir, "candidate");
    const candidateFiles = await treeFiles(candidateRoot);
    const args = { problem: join(f.dir, "problem.py"), kernel: join(candidateRoot, "kernels/problem.py"), candidateRoot,
      round: 1, seed: 42, warmup: 7, cacheEnabled: false, out: join(f.dir, "unsafe.json") };
    for (const files of [undefined, [], candidateFiles.slice(0, 1), [...candidateFiles, ...candidateFiles],
      [...candidateFiles, { path: "../escape.py", sha256: "a".repeat(64) }],
      candidateFiles.map(file => ({ ...file, sha256: "b".repeat(64) })),
      [...candidateFiles, { path: "missing.py", sha256: "a".repeat(64) }]]) {
      await expect(kernelProfile({ ...args, ...(files === undefined ? {} : { candidateFiles: files }) }, {},
        { session: f.session, atomDirectory: join(f.session.workdir, "runtime") })).rejects.toThrow();
    }
    const helper = join(candidateRoot, "kernels/tiling.py");
    const target = join(f.dir, "linked-helper.py");
    await cp(helper, target);
    await rm(helper);
    await symlink(target, helper);
    await expect(kernelProfile({ ...args, candidateFiles }, {},
      { session: f.session, atomDirectory: join(f.session.workdir, "runtime") })).rejects.toThrow(/regular/);
    await rm(helper);
    await mkdir(helper);
    await expect(kernelProfile({ ...args, candidateFiles }, {},
      { session: f.session, atomDirectory: join(f.session.workdir, "runtime") })).rejects.toThrow(/regular/);
    expect(f.commands).toHaveLength(0);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test("explicit tree profiling selects the declared helper Triton kernel in the actual msprof argv", async () => {
  const f = await fixture("complete", 0, "profile", "Default", { candidateTree: true, helperKernel: true });
  try {
    const verdict = await f.benchmark.verify(f.task, f.solve, f.session, f.signal);
    expect(verdict).toMatchObject({ details: { status: "completed" } });
    expect(f.commands[0]?.args).toContain("--kernel-name=vector_add_impl");
    const raw = JSON.parse(await readFile(join(f.session.verifierOutputDir, "kernel-profile.raw.json"), "utf8"));
    expect(raw.metadata.kernelSelection).toMatchObject({ policy: "entry-first-then-declared-python/v1", sourcePath: "kernels/tiling.py", kernelName: "vector_add_impl" });
    const candidateRoot = join(f.dir, "candidate");
    const kernel = join(candidateRoot, "kernels/problem.py");
    await writeFile(kernel, "import triton\n@triton.jit\ndef entry_impl(x): pass\ndef kernel_function(x): return x\n");
    const args = { problem: join(f.dir, "problem.py"), kernel, candidateRoot, round: 1, seed: 42, warmup: 7,
      cacheEnabled: false, collection: "Default" as const };
    const execution = { session: f.session, atomDirectory: join(f.session.workdir, "runtime") };
    expect((await kernelProfile({ ...args, candidateFiles: await treeFiles(candidateRoot), out: join(f.dir, "entry-first.json") }, {}, execution)).error).toBe("");
    expect(f.commands[1]?.args).toContain("--kernel-name=entry_impl");
    await writeFile(kernel, "from .tiling import run\ndef kernel_function(x): return run(x)\n");
    await writeFile(join(candidateRoot, "kernels/__init__.py"), "import triton\n@triton.jit\ndef first_path_impl(x): pass\n");
    expect((await kernelProfile({ ...args, candidateFiles: await treeFiles(candidateRoot), out: join(f.dir, "helper-order.json") }, {}, execution)).error).toBe("");
    expect(f.commands[2]?.args).toContain("--kernel-name=first_path_impl");
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test("SDK profile replay retains the reference import root and all locked dependency hashes", async () => {
  const f = await fixture("complete", 0, "profile", "Default", { candidateTree: true, nestedReference: true });
  try {
    const verdict = await f.benchmark.verify(f.task, f.solve, f.session, f.signal);
    expect(verdict).toMatchObject({ details: { status: "completed" } });
    const request = f.request() as { dataRoot: string; problem: string; hashes: Record<string, string> };
    expect(request.dataRoot).toBe(join(f.session.workdir, "data"));
    expect(request.problem).toBe(join(request.dataRoot, "refs/pkg/problem.py"));
    expect(request.hashes[join(request.dataRoot, "refs/inputs.py")]).toMatch(/^[a-f0-9]{64}$/);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test("profile reference dependency context invalidates cache, checks cache-hit bytes and survives new workdirs", async () => {
  const f = await fixture("complete", 0, "profile", "Default", { candidateTree: true });
  try {
    const referenceRoot = join(f.dir, "reference");
    await mkdir(join(referenceRoot, "refs/pkg"), { recursive: true });
    const problem = join(referenceRoot, "refs/pkg/problem.py");
    const helper = join(referenceRoot, "refs/inputs.py");
    await cp(join(f.dir, "problem.py"), problem);
    await writeFile(helper, "def make_inputs(): return [1]\n");
    const hashes = async (): Promise<Record<string, string>> => Object.fromEntries(await Promise.all([problem, helper].map(async path => [path,
      createHash("sha256").update(await readFile(path)).digest("hex")] as const)));
    const candidateRoot = join(f.dir, "candidate");
    const args = { problem, candidateRoot, candidateFiles: await treeFiles(candidateRoot), kernel: join(candidateRoot, "kernels/problem.py"),
      round: 1, seed: 42, warmup: 7, collection: "Default" as const, cacheDir: join(f.dir, "reference-cache") };
    const options = { env: { ASCEND_RT_VISIBLE_DEVICES: "0", KERNEL_NPU_DEVICE: "0" } };
    const execution = { session: f.session, atomDirectory: join(f.session.workdir, "runtime"), sourceContext: { dataRoot: referenceRoot, hashes: await hashes() } };
    expect((await kernelProfile({ ...args, out: join(f.dir, "ref-first.json") }, options, execution)).error).toBe("");
    expect((await kernelProfile({ ...args, out: join(f.dir, "ref-hit.json") }, options, execution)).error).toBe("");
    expect(f.commands).toHaveLength(1);
    await writeFile(helper, "def make_inputs(): return [2]\n");
    await expect(kernelProfile({ ...args, out: join(f.dir, "ref-tampered.json") }, options, execution)).rejects.toThrow(/source.*changed/i);
    execution.sourceContext.hashes = await hashes();
    expect((await kernelProfile({ ...args, out: join(f.dir, "ref-changed.json") }, options, execution)).error).toBe("");
    expect(f.commands).toHaveLength(2);
    const moved = join(f.dir, "another-attempt");
    await cp(referenceRoot, moved, { recursive: true });
    const movedProblem = join(moved, "refs/pkg/problem.py");
    const movedHashes = Object.fromEntries(Object.entries(execution.sourceContext.hashes).map(([path, hash]) => [path.replace(referenceRoot, moved), hash]));
    expect((await kernelProfile({ ...args, problem: movedProblem, out: join(f.dir, "ref-moved.json") }, options,
      { ...execution, sourceContext: { dataRoot: moved, hashes: movedHashes } })).error).toBe("");
    expect(f.commands).toHaveLength(2);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});
