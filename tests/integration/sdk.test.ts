import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { Evaluator, EvaluatorRunError, type EvaluatorRunOptions, type ProgressEvent, type WorkflowRunRecord } from "arsi-evaluator";
import * as jobs from "../../src/application/ray/workflow-jobs.js";
import { LocalRunStore } from "../../src/plugins/stores/local.js";
import * as pluginRegistry from "../../src/application/plugins/open-registry.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
  delete (globalThis as Record<string, unknown>).__cliReportCalls;
});
async function fixture(mode = "pass", extra: Record<string, unknown> = {}) {
  const root = await mkdtemp(join(tmpdir(), "evaluator-sdk-")); roots.push(root);
  await copyFile(join(import.meta.dirname, "../fixtures/cli/plugin.mjs"), join(root, "cli.mjs"));
  await copyFile(join(import.meta.dirname, "../fixtures/sdk/plugin.mjs"), join(root, "plugin.mjs"));
  const patchPath = join(root, "patch.yaml"), configPath = join(root, "config.yaml");
  await writeFile(patchPath, JSON.stringify([{ insert: [{ id: "sdk-fixture", name: "./plugin.mjs" }] }]));
  await writeFile(configPath, JSON.stringify({ schemaVersion: 2, workflow: "benchmark.evaluate", output: { directory: "./results" }, with: {
    services: { default: { model: "sdk-fixture", base_url: "https://fixture.invalid", apiKeyEnv: "SDK_KEY" } },
    benchmark: { name: "cli-fixture", config: { mode }, solver: { name: "cli-fixture", config: { mode } } },
    environment: "local", run: {}, ...(mode === "report-error" ? { reporter: "cli-error" } : {}), ...extra,
  } }));
  const options: EvaluatorRunOptions = { configPath, patchPath, env: { SDK_KEY: "SDK_SENSITIVE_TEST_VALUE" } };
  return { root, options };
}
async function released(root: string) { expect(await readFile(join(root, "lifecycle.log"), "utf8")).toBe("registered\ndisposed\n"); }
async function nativeSnapshot(result: Awaited<ReturnType<Evaluator["run"]>>) {
  const store = new LocalRunStore();
  try { await store.open(join(result.runDirectory, "benchmark-evidence", result.runId)); return await store.snapshot(); }
  finally { await store.close(); }
}

test.each(["pass", "wrong", "error"])("public SDK runs %s and preserves Benchmark evidence", async mode => {
  const { root, options } = await fixture(mode), events: ProgressEvent[] = [];
  const result = await new Evaluator().run({ ...options, onProgress: event => events.push(event) });
  expect(result.kind).toBe("workflow"); expect(result.exitCode).toBe(mode === "error" ? 1 : 0);
  const snapshot = await nativeSnapshot(result);
  expect(snapshot.records[0]?.verdict?.passed).toBe(mode === "pass" ? true : mode === "wrong" ? false : undefined);
  expect(result.record.units.map(unit => unit.caseId)).toEqual(["task"]);
  expect(JSON.stringify(events)).not.toContain("SDK_SENSITIVE_TEST_VALUE");
  expect(await readFile(join(result.runDirectory, "plan.json"), "utf8")).not.toContain("SDK_SENSITIVE_TEST_VALUE");
  await released(root);
});

test("SDK applies Benchmark offset and maxTasks", async () => {
  const { root, options } = await fixture("pass", {
    benchmark: { name: "cli-fixture", config: { mode: "pass", tasks: ["a", "b", "c"] }, solver: "cli-fixture" }, run: { offset: 1, maxTasks: 1 },
  });
  const result = await new Evaluator().run(options);
  expect(result.record.units.map(unit => unit.caseId)).toEqual(["b"]); await released(root);
});

test("SDK reporting loads selected renderers without reopening evaluation factories or requesting credentials", async () => {
  const { root, options } = await fixture("pass", { metrics: ["aisbench-performance"], reporter: "aisbench-markdown" });
  const sdk = new Evaluator(), result = await sdk.run(options);
  const path = await sdk.report(result.runDirectory);
  expect(path).toBe(join(result.runDirectory, "report.md"));
  expect(await readFile(path, "utf8")).toContain("AISBench"); await released(root);
});

test("SDK rejects a different plugin using a bundled ID", async () => {
  const { root, options } = await fixture();
  await writeFile(join(root, "patch.yaml"), JSON.stringify([{ insert: [{ id: "aisbench-plugin", name: "./plugin.mjs" }] }]));
  await expect(new Evaluator().run(options)).rejects.toThrow(/aisbench-plugin conflicts with a bundled plugin/u);
});

test("SDK resumes the same run without creating new attempts", async () => {
  const { root, options } = await fixture(), sdk = new Evaluator();
  const first = await sdk.run(options), resumed = await sdk.run({ ...options, resume: true });
  expect(resumed.runDirectory).toBe(first.runDirectory); expect(resumed.record.units).toEqual(first.record.units);
  expect(await readFile(join(root, "lifecycle.log"), "utf8")).toBe("registered\ndisposed\nregistered\ndisposed\n");
});

test("SDK cancels a running attempt and saves a readable partial result", async () => {
  const { root, options } = await fixture("cancel"), controller = new AbortController();
  const listeners = process.listenerCount("SIGINT");
  const result = await new Evaluator().run({ ...options, signal: controller.signal,
    onEvent(event) { if (event.status === "running" && event.message === "Starting benchmark.solve") controller.abort(); } });
  expect(result.exitCode).toBe(130); expect(result.record.status).toBe("cancelled");
  expect(await readFile(await new Evaluator().report(result.runDirectory), "utf8")).toContain("cancelled");
  expect(process.listenerCount("SIGINT")).toBe(listeners); await released(root);
});

test("invalid configuration releases the registry and missing auth is recorded when resources open", async () => {
  const invalid = await fixture();
  await writeFile(invalid.options.configPath, '{"schemaVersion":2,"workflow":"missing"}');
  await expect(new Evaluator().run(invalid.options)).rejects.toMatchObject({ phase: "config", exitCode: 2, result: null });
  await released(invalid.root);
  const missing = await fixture();
  const result = await new Evaluator().run({ ...missing.options, env: {} });
  expect(result.exitCode).toBe(1);
  expect(JSON.stringify(result.record)).toContain("Missing credential environment variable SDK_KEY"); await released(missing.root);
});

test("source errors remain in the returned partial result", async () => {
  const { root, options } = await fixture("python-file-error");
  const result = await new Evaluator().run(options);
  expect(result.exitCode).toBe(1); expect(JSON.stringify(result.record)).toContain("FileNotFoundError"); await released(root);
});

test("optional report failure retains completed business results and is not retried", async () => {
  const { root, options } = await fixture("report-error");
  const result = await new Evaluator().run(options);
  expect(result.record.businessComplete).toBe(true);
  expect(result.record.steps.find(step => step.plugin === "benchmark.report")?.status).toBe("failed");
  expect((globalThis as Record<string, unknown>).__cliReportCalls).toBe(1); await released(root);
});

test("observer failure stops work, redacts its cause, and releases resources", async () => {
  const { root, options } = await fixture("cancel");
  await expect(new Evaluator().run({ ...options, onEvent(event) {
    if (event.status === "running" && event.message === "Starting benchmark.solve") throw new Error("observer failed SDK_SENSITIVE_TEST_VALUE");
  } })).rejects.toSatisfy((error: unknown) => error instanceof EvaluatorRunError && error.exitCode === 1 && error.result !== null
    && !String(error.cause).includes("SDK_SENSITIVE_TEST_VALUE") && error.message.includes("observer failed"));
  await released(root);
});

test("an observer failing during final report publication retains the committed result", async () => {
  const { root, options } = await fixture();
  await expect(new Evaluator().run({ ...options, onEvent(event) {
    if (event.message === "Writing saved evaluation report") throw new Error("report observer failed");
  } })).rejects.toMatchObject({ exitCode: 1, result: { record: { status: "completed", businessComplete: true } } });
  await released(root);
});

test("same SDK instance permits independent concurrent evaluations", async () => {
  const a = await fixture(), b = await fixture(), sdk = new Evaluator();
  const results = await Promise.all([sdk.run(a.options), sdk.run(b.options)]);
  expect(results.every(result => result.exitCode === 0)).toBe(true);
  expect(results[0]?.runDirectory).not.toBe(results[1]?.runDirectory); await released(a.root); await released(b.root);
});

test("rejected resume does not overwrite original evidence", async () => {
  const { options } = await fixture(), sdk = new Evaluator(), first = await sdk.run(options);
  const before = await readFile(join(first.runDirectory, "run.json"), "utf8");
  await writeFile(options.configPath, (await readFile(options.configPath, "utf8")).replace('"model":"sdk-fixture"', '"model":"changed-model"'));
  await expect(sdk.run({ ...options, resume: first.runId })).rejects.toMatchObject({ exitCode: 1, result: null });
  expect(await readFile(join(first.runDirectory, "run.json"), "utf8")).toBe(before);
});

test("registry disposal failure retains the completed result", async () => {
  const { root, options } = await fixture(), original = pluginRegistry.openPluginRegistry;
  vi.spyOn(pluginRegistry, "openPluginRegistry").mockImplementation(async (...args) => {
    const registry = await original(...args), dispose = registry.dispose;
    registry.dispose = async () => { await dispose(); throw new Error("registry release failed"); }; return registry;
  });
  await expect(new Evaluator().run(options)).rejects.toMatchObject({ phase: "dispose", exitCode: 1,
    result: { kind: "workflow", record: { status: "completed" } } }); await released(root);
});

test("pre-aborted SDK call does not load plugins", async () => {
  const { root, options } = await fixture();
  await expect(new Evaluator().run({ ...options, signal: AbortSignal.abort() })).rejects.toMatchObject({ exitCode: 130, result: null });
  await expect(readFile(join(root, "lifecycle.log"))).rejects.toMatchObject({ code: "ENOENT" });
});

test.each([false, true])("SDK routes the workflow to Ray Jobs with managed defaults=%s", async managed => {
  const { root, options } = await fixture("pass", { scheduler: { name: "ray", concurrency: 2 },
    ...(managed ? {} : { deployment: { kind: "ray-jobs", endpoint: "https://jobs.invalid", caFile: "cert.pem", managedLocal: false } }) });
  const events: ProgressEvent[] = [];
  const submitted = vi.spyOn(jobs, "runWorkflowJobs").mockImplementation(async (config, plan, names, opts) => {
    expect(config.managedLocal).toBe(managed); expect(names).toContain("SDK_KEY");
    opts.onEvent?.({ path: "deployment", status: "running", message: "remote progress SDK_SENSITIVE_TEST_VALUE" });
    const record: WorkflowRunRecord = { schemaVersion: 2, runId: "fixture", fingerprint: plan.fingerprint, implementations: plan.implementations,
      startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), status: "completed", businessComplete: true,
      outputs: {}, units: [], steps: [], resources: [], artifacts: [], errors: [] };
    const directory = join(root, "downloaded");
    await mkdir(directory);
    return { record, directory };
  });
  const result = await new Evaluator().run({ ...options, onProgress: event => events.push(event) });
  expect(result).toMatchObject({ kind: "workflow", runId: "fixture", exitCode: 0 });
  expect(submitted).toHaveBeenCalledOnce(); expect(events.length).toBeGreaterThan(0);
  expect(JSON.stringify(events)).not.toContain("SDK_SENSITIVE_TEST_VALUE"); await released(root);
});

test("Ray collection errors are execution failures with a redacted cause", async () => {
  const { root, options } = await fixture("pass", { scheduler: { name: "ray" } });
  vi.spyOn(jobs, "runWorkflowJobs").mockRejectedValue(new Error("download failed SDK_SENSITIVE_TEST_VALUE"));
  await expect(new Evaluator().run(options)).rejects.toSatisfy((error: unknown) => error instanceof EvaluatorRunError
    && error.exitCode === 1 && error.phase === "execute" && !String(error.cause).includes("SDK_SENSITIVE_TEST_VALUE"));
  await released(root);
});
