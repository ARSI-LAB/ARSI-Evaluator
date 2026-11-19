import { mkdtemp, mkdir, rm, writeFile, readdir, readFile, realpath } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { resolveResumeRun } from "../../src/core/recovery/resume.js";
import { LocalRunStore } from "../../src/plugins/stores/local.js";
import { storeKey, storeRecord, storeRun } from "../fixtures/results/store-fixture.js";
import { harness, source } from "../fixtures/engine/fakes.js";
import { runBenchmarkFixture } from "../fixtures/engine/workflow.js";

vi.setConfig({ testTimeout: 30_000 });

const roots: string[] = []; const stores: LocalRunStore[] = [];
async function root() { const value = await mkdtemp(join(tmpdir(), "evaluator-resume-")); roots.push(value); return value; }
afterEach(async () => { await Promise.all(stores.splice(0).map(store => store.close())); await Promise.all(roots.splice(0).map(value => rm(value, { recursive: true, force: true }))); });

test("resume locates an explicit run or the only candidate, never guesses latest", async () => {
  const directory = await root();
  await expect(resolveResumeRun(directory, null)).rejects.toThrow(/no.*run/i);
  await mkdir(join(directory, "a")); await writeFile(join(directory, "a/manifest.json"), JSON.stringify({ ...storeRun, runId: "a" }));
  expect(await resolveResumeRun(directory, null)).toBe(await realpath(join(directory, "a")));
  await mkdir(join(directory, "b")); await writeFile(join(directory, "b/manifest.json"), JSON.stringify({ ...storeRun, runId: "b" }));
  await expect(resolveResumeRun(directory, null)).rejects.toThrow(/a.*b/);
  expect(await resolveResumeRun(directory, "a")).toBe(await realpath(join(directory, "a")));
  await expect(resolveResumeRun(directory, "../outside")).rejects.toThrow(/run ID/i);
});

test("reopened snapshot selects the new terminal attempt and preserves cancelled history", async () => {
  const directory = await root(); const store = new LocalRunStore(); stores.push(store);
  await store.create(directory, storeRun, {});
  await store.allocate(storeKey); await store.commit({ ...storeRecord(), executionStatus: "cancelled", scoreStatus: "invalid" }, { files: [], missing: [] });
  const next = { ...storeKey, attemptId: "new-attempt" }; await store.allocate(next);
  expect((await store.snapshot()).records).toEqual([]);
  await store.commit(storeRecord(next), { files: [], missing: [] }); await store.close();
  await store.open(join(directory, storeRun.runId));
  const snapshot = await store.snapshot();
  expect(snapshot.records).toHaveLength(1); expect(snapshot.records[0]!.key).toEqual(next);
  expect((await store.listAttempts()).map(attempt => attempt.record!.executionStatus)).toEqual(["cancelled", "completed"]);
  expect(snapshot.pendingTaskIds).toEqual(["b"]);
});

test("snapshot rejects two scored attempts instead of choosing by modification time", async () => {
  const store = new LocalRunStore(); stores.push(store); await store.create(await root(), storeRun, {});
  for (const attemptId of ["old", "new"]) {
    const key = { ...storeKey, attemptId }; await store.allocate(key); await store.commit(storeRecord(key), { files: [], missing: [] });
  }
  await expect(store.snapshot()).rejects.toMatchObject({ code: "STORE_RECORD_INVALID" });
});

test("only reclaims a writer lock whose local process is confirmed dead", async () => {
  const directory = await root(); const store = new LocalRunStore(); stores.push(store); await store.create(directory, storeRun, {}); await store.close();
  const runDir = join(directory, storeRun.runId);
  const { stdout } = await promisify(execFile)(process.execPath, ["-e", "console.log(process.pid)"], { windowsHide: true });
  const stale = { host: hostname(), pid: Number(stdout.trim()), token: "stale-fixture", acquiredAt: "2026-09-18T00:00:00Z" };
  await writeFile(join(runDir, ".writer.lock"), JSON.stringify(stale));
  expect((await store.open(runDir)).runId).toBe(storeRun.runId);
  const archived = (await readdir(runDir)).find(name => name.startsWith(".recovered-lock-"));
  expect(archived).toBeDefined(); expect(JSON.parse(await readFile(join(runDir, archived!), "utf8"))).toEqual(stale);
  await store.close();
  for (const lock of [{ ...stale, host: "unknown-remote-host" }, { ...stale, pid: process.pid }, { bad: true }]) {
    await writeFile(join(runDir, ".writer.lock"), JSON.stringify(lock));
    await expect(store.open(runDir)).rejects.toMatchObject({ code: "STORE_LOCKED" });
    expect(JSON.parse(await readFile(join(runDir, ".writer.lock"), "utf8"))).toEqual(lock);
    await rm(join(runDir, ".writer.lock"));
  }
});

async function interrupted() {
  const directory = await root(), value = harness(directory);
  stores.push(value.components.store as LocalRunStore);
  value.config.experiment.scheduler.config.concurrency = 1;
  const controller = new AbortController();
  const solve = value.components.solver.solve.bind(value.components.solver);
  const prepare = value.components.environment.prepare.bind(value.components.environment);
  let interrupt = false;
  value.components.environment.prepare = async (...args) => {
    const session = await prepare(...args), dispose = session.dispose.bind(session);
    session.dispose = async signal => { await dispose(signal); if (interrupt) throw new Error("interrupted cleanup"); };
    return session;
  };
  value.components.solver.solve = async (...args) => {
    if (args[0].id === "b") { interrupt = true; controller.abort(); throw controller.signal.reason; }
    return solve(...args);
  };
  const first = await runBenchmarkFixture({ ...value, signal: controller.signal });
  expect(first.workflow.status).toBe("cancelled");
  expect(first.records.map(record => record.executionStatus)).toEqual(["completed", "cancelled"]);
  await value.components.store.close();
  value.components.solver.solve = solve;
  value.components.environment.prepare = prepare;
  value.components.environment.recoverAttempts = async () => {};
  value.inputs.length = 0;
  return { ...value, resumeDirectory: first.directory, nativeDirectory: first.nativeDirectory,
    run: first.run, completedKey: first.records[0]!.key, interruptedKey: first.records[1]!.key };
}

test("workflow resumes locked source and skips completed tasks while retaining historical attempts", async () => {
  const value = await interrupted();
  const cleanup = vi.fn(async () => { expect(value.inputs).toEqual([]); });
  value.components.environment.recoverAttempts = cleanup;
  const resolved = vi.spyOn(value.components.benchmark, "resolveSource");
  const snapshot = await runBenchmarkFixture({ ...value, signal: new AbortController().signal });
  expect(snapshot.run.runId).toBe(value.run.runId); expect(snapshot.run.status).toBe("completed");
  expect(value.inputs.map(input => input.id)).toEqual(["b", "c"]);
  expect(cleanup).toHaveBeenCalledWith([value.interruptedKey], expect.any(AbortSignal));
  expect(resolved.mock.calls[0]![0]).toEqual(source);
  expect(snapshot.records.map(record => record.key.attemptId)).toContain(value.completedKey.attemptId);
  expect(await value.components.store.listAttempts()).toHaveLength(4);
  await value.components.store.close();
  value.components.benchmark.resolveSource = async () => { throw new Error("completed resume must stay offline"); };
  value.components.solver.solve = async () => { throw new Error("completed resume must not solve"); };
  expect((await runBenchmarkFixture({ ...value, signal: new AbortController().signal })).digest).toBe(snapshot.digest);
});

test("a benchmark can require source validation when a completed run resumes", async () => {
  const value = await interrupted();
  await runBenchmarkFixture({ ...value, signal: new AbortController().signal });
  await value.components.store.close();
  Object.defineProperty(value.components.benchmark, "validateSourceOnCompletedResume", { value: true });
  value.components.benchmark.resolveSource = async () => ({ ...source, revision: "changed" });
  const resumed = await runBenchmarkFixture({ ...value, signal: new AbortController().signal });
  expect(resumed.workflow).toMatchObject({ status: "failed", errors: expect.arrayContaining([expect.objectContaining({ message: expect.stringContaining("source changed") })]) });
});

test("a corrupt source lock fails before source, environment, or model access for interrupted and all-terminal runs", async () => {
  const interruptedValue = await interrupted(); interruptedValue.events.length = 0;
  await writeFile(join(interruptedValue.nativeDirectory, "manifest.json"), JSON.stringify({ ...interruptedValue.run, source: {} }));
  await expect(runBenchmarkFixture({ ...interruptedValue, signal: new AbortController().signal }))
    .rejects.toMatchObject({ code: "STORE_RECORD_INVALID" });
  expect(interruptedValue.events).toEqual([]); expect(interruptedValue.inputs).toEqual([]);

  const directory = await root(); const completedValue = harness(directory); stores.push(completedValue.components.store as LocalRunStore);
  const completed = await runBenchmarkFixture({ ...completedValue, signal: new AbortController().signal });
  await completedValue.components.store.close(); completedValue.events.length = 0; completedValue.inputs.length = 0;
  const runDir = join(completedValue.config.experiment.output.directory, completed.run.runId);
  await writeFile(join(completed.nativeDirectory, "manifest.json"), JSON.stringify({ ...completed.run, source: {} }));
  await expect(runBenchmarkFixture({ ...completedValue, resumeDirectory: runDir, signal: new AbortController().signal }))
    .rejects.toMatchObject({ code: "STORE_RECORD_INVALID" });
  expect(completedValue.events).toEqual([]); expect(completedValue.inputs).toEqual([]);
});

test.each(["config", "plugins", "source"])("resume rejects changed %s before a model call", async changed => {
  const value = await interrupted();
  if (changed === "config") value.config.experiment.run.maxTasks = 2;
  if (changed === "plugins") value.components.pluginVersions = { fixture: "2" };
  if (changed === "source") value.components.benchmark.resolveSource = async () => ({ ...source, revision: "changed" });
  if (changed === "source") {
    const result = await runBenchmarkFixture({ ...value, signal: new AbortController().signal });
    expect(result.workflow.status).toBe("failed");
    expect(JSON.stringify(result.workflow)).toContain("source changed");
  } else await expect(runBenchmarkFixture({ ...value, signal: new AbortController().signal })).rejects.toThrow(/different workflow/);
  expect(value.inputs).toEqual([]);
});
