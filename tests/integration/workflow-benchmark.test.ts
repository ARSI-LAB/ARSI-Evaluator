import { safeTaskKey } from "../../src/core/artifacts/artifacts.js";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { inspectWorkflow, runWorkflow } from "../../src/application/workflow.js";
import { workflowConfiguration } from "../../src/config/workflow-schema.js";
import { workflowObject } from "../../src/core/workflow/values.js";
import { warmupWorkflow } from "../../src/application/workflow-warmup.js";

test("Benchmark Jobs shorthand compiles one portable connection shared by preparation and execution", async () => {
  const root = await mkdtemp(join(tmpdir(), "benchmark-jobs-plan-")); roots.push(root);
  const configPath = join(root, "eval.yaml");
  await writeFile(configPath, JSON.stringify({ schemaVersion: 2, workflow: "benchmark.evaluate", with: {
    benchmark: "gsm8k", services: { default: { model: "fixture", base_url: "http://fixture.invalid", apiKeyEnv: "MODEL_KEY" } },
    scheduler: { name: "ray", concurrency: 2 }, run: { maxTasks: 1 },
  } }));
  const plan = await inspectWorkflow({ configPath, env: {} });
  expect(plan.document.pathBase).toBe(".");
  const resources = plan.document.workflow.resources;
  expect(resources.ray?.config).toEqual({ deployment: { value: "ray-jobs" }, concurrency: { value: 2 } });
  expect(resources.benchmark?.resources.connection).toBe("ray");
  expect(resources.execution?.resources.connection).toBe("ray");
  expect(JSON.stringify(plan)).not.toContain(root);
});

vi.setConfig({ testTimeout: 30_000 });
const roots: string[] = [];
afterEach(async () => {
  delete (globalThis as Record<string, unknown>).__cliOnSolve;
  delete (globalThis as Record<string, unknown>).__cliReportCalls;
  delete (globalThis as Record<string, unknown>).__warmupEvent;
  delete (globalThis as Record<string, unknown>).__workflowMaterialize;
  delete (globalThis as Record<string, unknown>).__workflowSourceRevision;
  delete (globalThis as Record<string, unknown>).__workflowPlanningFailures;
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

test.each(["batch", "pipeline"])("%s materializes selected cases and preserves preparation receipts", async mode => {
  const options = await fixture();
  await copyFile(join(options.root, "plugin.mjs"), join(options.root, "base.mjs"));
  await copyFile(join(import.meta.dirname, "../fixtures/cli/planned-plugin.mjs"), join(options.root, "plugin.mjs"));
  const config = JSON.parse(await readFile(options.configPath, "utf8"));
  config.with.benchmark.name = "planned-fixture";
  config.with.environment = "planned-fixture";
  config.with.run = { preparation: { mode, concurrency: 2 } };
  await writeFile(options.configPath, JSON.stringify(config));
  const prepared = new Set<string>();
  (globalThis as Record<string, unknown>).__workflowMaterialize = (id: string) => { prepared.add(id); };
  (globalThis as Record<string, unknown>).__cliOnSolve = () => {
    if (mode === "batch") expect(prepared.size).toBe(2);
  };
  const result = await runWorkflow(options);
  expect(result.record.status, JSON.stringify(result.record.steps.filter(step => step.errors.length))).toBe("completed");
  expect([...prepared].sort()).toEqual(["a", "b"]);
  const manifest = JSON.parse(await readFile(join(result.directory, "benchmark-evidence", result.record.runId, "manifest.json"), "utf8"));
  expect(manifest.preparationRounds).toMatchObject([{ mode, status: "ready" }]);
  (globalThis as Record<string, unknown>).__workflowSourceRevision = "changed";
  const resumed = await runWorkflow({ ...options, resume: result.record.runId });
  expect(resumed.record.status).toBe("failed");
  expect(resumed.record.errors[0]?.message).toContain("source changed");
}, 15_000);

test("pipeline starts a ready case before a slow earlier case without draining lookahead", async () => {
  const options = await fixture();
  await copyFile(join(options.root, "plugin.mjs"), join(options.root, "base.mjs"));
  await copyFile(join(import.meta.dirname, "../fixtures/cli/planned-plugin.mjs"), join(options.root, "plugin.mjs"));
  const config = JSON.parse(await readFile(options.configPath, "utf8"));
  config.with.benchmark.name = "planned-fixture";
  config.with.benchmark.config.tasks = ["a", "b", "c", "d", "e", "f"];
  config.with.environment = "planned-fixture";
  config.with.scheduler.concurrency = 1;
  config.with.run = { preparation: { mode: "pipeline", concurrency: 2, lookahead: 2 } };
  await writeFile(options.configPath, JSON.stringify(config));
  const slow = Promise.withResolvers<void>(), prepared: string[] = [], started: string[] = [];
  let beforeFirstSolve = 0;
  (globalThis as Record<string, unknown>).__workflowMaterialize = async (id: string) => {
    prepared.push(id); if (id === "a") await slow.promise;
  };
  (globalThis as Record<string, unknown>).__cliOnSolve = () => {
    if (!beforeFirstSolve) beforeFirstSolve = prepared.length;
    slow.resolve();
  };
  try {
    const result = await runWorkflow({ ...options, signal: AbortSignal.timeout(10_000), onEvent(event) {
      if (event.message.startsWith("Execution unit")) started.push(event.message);
    } });
    expect(result.record.status, JSON.stringify(result.record.errors)).toBe("completed");
    expect(result.record.units[0]?.caseId).toBe("b");
    expect(beforeFirstSolve).toBeLessThanOrEqual(3); // 2 lookahead + the admitted slot.
    expect(started).toHaveLength(6);
  } finally { slow.resolve(); }
}, 15_000);

async function fixture(mode = "pass") {
  const root = await mkdtemp(join(tmpdir(), "ember-benchmark-workflow-")); roots.push(root);
  await copyFile(join(import.meta.dirname, "../fixtures/cli/plugin.mjs"), join(root, "plugin.mjs"));
  const patchPath = join(root, "patch.yaml"), configPath = join(root, "eval.yaml");
  await writeFile(patchPath, JSON.stringify([{ insert: [{ id: "workflow-benchmark-fixture", name: "./plugin.mjs" }] }]));
  await writeFile(configPath, JSON.stringify({ schemaVersion: 2, workflow: "benchmark.evaluate", with: {
    services: { default: { model: "fixture", base_url: "http://fixture.invalid", apiKeyEnv: "BENCHMARK_KEY" } },
    benchmark: { name: "cli-fixture", config: { mode, tasks: ["a", "b"] }, solver: { name: "cli-fixture", config: { mode } } },
    environment: "local", scheduler: { concurrency: 2 },
  } }));
  return { root, configPath, patchPath, env: { BENCHMARK_KEY: "workflow-fixture-secret" } };
}

test("Benchmark template exposes native steps and persists native evidence through the generic runtime", async () => {
  const options = await fixture();
  let calls = 0;
  (globalThis as Record<string, unknown>).__cliOnSolve = () => { calls++; };
  const plan = await inspectWorkflow(options);
  expect(calls).toBe(0);
  expect(plan.implementations).toHaveProperty("step:benchmark.solve");
  const result = await runWorkflow(options);
  expect(result.record.status, JSON.stringify(result.record.steps.filter(step => step.errors.length))).toBe("completed");
  expect(calls).toBe(2);
  expect(result.record.units).toHaveLength(2);
  const exported = result.record.artifacts.filter(artifact => artifact.protocol === "arsi.benchmark-evidence/v1");
  expect(exported).toHaveLength(2);
  for (const artifact of exported) {
    expect(artifact.visibility).toBe("private");
    const evidence = JSON.parse(await readFile(join(result.directory, artifact.path), "utf8"));
    expect(evidence.files).toEqual(expect.arrayContaining([expect.objectContaining({ file: expect.objectContaining({ path: "agent/trajectory.jsonl" }) })]));
    for (const file of evidence.files) expect(file.artifact).toMatchObject({ sha256: file.file.sha256, size: file.file.size, visibility: "private" });
  }
  expect(result.record.steps.some(step => step.plugin === "benchmark.verify" && step.status === "completed")).toBe(true);
  const metrics = workflowObject(result.record.outputs.metrics);
  expect(metrics).toHaveProperty("success-rate");
  const resumed = await runWorkflow({ ...options, resume: result.record.runId });
  expect(resumed.record.status).toBe("completed");
  expect(calls).toBe(2);
  expect(await readFile(join(result.directory, "plan.json"), "utf8")).not.toContain("workflow-fixture-secret");
});

test("Benchmark variants and repetitions retain separate solvers, native results and reports", async () => {
  const options = await fixture();
  const config = JSON.parse(await readFile(options.configPath, "utf8"));
  config.with.repetitions = 2;
  config.with.variants = [
    { id: "correct", services: { default: { model: "correct-model" } }, solver: { name: "cli-fixture", config: { mode: "pass" } } },
    { id: "wrong", services: { default: { model: "wrong-model" } }, solver: { name: "cli-fixture", config: { mode: "wrong" } } },
  ];
  await writeFile(options.configPath, JSON.stringify(config));
  let calls = 0;
  (globalThis as Record<string, unknown>).__cliOnSolve = () => { calls++; };
  const result = await runWorkflow(options);
  expect(result.record.status, JSON.stringify(result.record.steps.filter(step => step.errors.length))).toBe("completed");
  expect(result.record.units).toHaveLength(8);
  for (const unit of result.record.units) {
    expect(unit.outputs.scores).toMatchObject([{ value: unit.variantId === "correct" ? 1 : 0 }]);
  }
  const groups = workflowObject(result.record.outputs.metrics).groups;
  if (!Array.isArray(groups)) throw new Error("Missing grouped metrics");
  expect(groups.map(value => workflowObject(value).variantId)).toEqual(["correct", "correct", "wrong", "wrong"]);
  const report = result.record.artifacts.find(artifact => artifact.protocol === "arsi.artifact-markdown/v1");
  if (!report) throw new Error("Missing grouped report");
  const content = await readFile(join(result.directory, report.path), "utf8");
  expect(content).toContain("benchmark-groups/correct/repeat-0/");
  expect(content).toContain("benchmark-groups/wrong/repeat-1/");
  const resumed = await runWorkflow({ ...options, resume: result.record.runId });
  expect(resumed.record.status, JSON.stringify(resumed.record.errors)).toBe("completed");
  expect(calls).toBe(8);
}, 20_000);

test("Benchmark matrix pipeline starts preparation one group at a time", async () => {
  const options = await fixture();
  await copyFile(join(options.root, "plugin.mjs"), join(options.root, "base.mjs"));
  await copyFile(join(import.meta.dirname, "../fixtures/cli/planned-plugin.mjs"), join(options.root, "plugin.mjs"));
  const config = JSON.parse(await readFile(options.configPath, "utf8"));
  config.with.benchmark.name = "planned-fixture";
  config.with.environment = "planned-fixture";
  config.with.run = { preparation: { mode: "pipeline", concurrency: 1, lookahead: 1 } };
  config.with.variants = [{ id: "first" }, { id: "second" }];
  await writeFile(options.configPath, JSON.stringify(config));
  let prepared = 0, firstSolvePrepared: number | undefined;
  (globalThis as Record<string, unknown>).__workflowMaterialize = () => { prepared++; };
  (globalThis as Record<string, unknown>).__cliOnSolve = () => { firstSolvePrepared ??= prepared; };
  const result = await runWorkflow(options);
  expect(result.record.status, JSON.stringify(result.record.steps.filter(step => step.errors.length))).toBe("completed");
  expect(firstSolvePrepared).toBeLessThanOrEqual(2);
  expect(prepared).toBe(4);
  expect(result.record.units).toHaveLength(4);
}, 20_000);

test("exported Benchmark flow accepts inserted and deleted steps", async () => {
  const options = await fixture();
  const plan = await inspectWorkflow(options);
  const evaluate = plan.document.workflow.steps.find(node => node.id === "evaluate");
  if (!evaluate || evaluate.kind !== "forEach") throw new Error("Missing evaluation block");
  const parts = evaluate.body.steps.find(node => node.id === "parts");
  if (!parts || parts.kind !== "forEach") throw new Error("Missing native parts");
  const solve = parts.body.steps.find(node => node.id === "solve");
  if (!solve || solve.kind !== "step") throw new Error("Missing solve");
  parts.body.steps.splice(1, 0, { kind: "step", id: "preprocess", use: "data.value", config: {},
    inputs: { value: { ref: "begin.outputs.task" } }, resources: {} });
  solve.inputs.task = { ref: "preprocess.outputs.value" };
  plan.document.workflow.steps = plan.document.workflow.steps.filter(node => node.id !== "report");
  const custom = join(options.root, "custom.yaml");
  await writeFile(custom, JSON.stringify(workflowConfiguration(plan.document)));
  const result = await runWorkflow({ ...options, configPath: custom });
  expect(result.record.status, JSON.stringify(result.record.steps.filter(step => step.errors.length))).toBe("completed");
  expect(result.record.steps.filter(step => step.plugin === "data.value")).toHaveLength(2);
  expect(result.record.steps.some(step => step.plugin === "benchmark.report")).toBe(false);
});

test("configured Reporter is invoked and its failure does not invalidate completed scoring", async () => {
  const options = await fixture();
  const config = JSON.parse(await readFile(options.configPath, "utf8"));
  config.with.reporter = { name: "cli-error", config: {} };
  await writeFile(options.configPath, JSON.stringify(config));
  const result = await runWorkflow(options);
  expect(result.record.status).toBe("completed");
  expect((globalThis as Record<string, unknown>).__cliReportCalls).toBe(1);
  expect(result.record.steps.find(step => step.plugin === "benchmark.report")).toMatchObject({ status: "failed" });
});

test("solve timeout retains a valid zero score without repeating the attempt", async () => {
  const options = await fixture("cancel");
  const config = JSON.parse(await readFile(options.configPath, "utf8"));
  config.with.run = { solveTimeoutSeconds: 1, timeoutSeconds: 10 };
  await writeFile(options.configPath, JSON.stringify(config));
  const result = await runWorkflow(options);
  expect(result.record.status, JSON.stringify(result.record.steps.filter(step => step.errors.length))).toBe("completed");
  expect(result.record.units).toHaveLength(2);
  for (const unit of result.record.units) expect(unit.outputs.scores).toMatchObject([{ valid: true, value: 0 }]);
  const resumed = await runWorkflow({ ...options, resume: result.record.runId });
  expect(resumed.record.units).toHaveLength(2);
});

test("Benchmark workflow warmup materializes dependencies without model credentials or attempts", async () => {
  const options = await fixture();
  await copyFile(join(import.meta.dirname, "../fixtures/warmup/plugin.mjs"), join(options.root, "plugin.mjs"));
  const events: string[] = [];
  (globalThis as Record<string, unknown>).__warmupEvent = (name: string) => { events.push(name); };
  const config = JSON.parse(await readFile(options.configPath, "utf8"));
  config.with.benchmark = { name: "warmup-fixture", config: {}, solver: "warmup-fixture" };
  config.with.environment = "warmup-fixture";
  await writeFile(options.configPath, JSON.stringify(config));
  const result = await warmupWorkflow({ ...options, env: {} });
  expect(result.find(item => item.provider === "benchmark.runtime")?.status).toBe("passed");
  expect(events.filter(name => name === "materialize")).toHaveLength(3);
  await expect(readFile(join(options.root, "results", "run.json"))).rejects.toMatchObject({ code: "ENOENT" });
});

test("native solve failures leave generic units failed and retain redacted evidence", async () => {
  const options = await fixture("error");
  const result = await runWorkflow(options);
  expect(result.record.status).toBe("failed");
  expect(result.record.businessComplete).toBe(false);
  expect(result.record.units.map(unit => unit.status)).toEqual(["failed", "failed"]);
  expect(result.record.resources.every(resource => resource.state === "released")).toBe(true);
  expect(JSON.stringify(result.record)).not.toContain("workflow-fixture-secret");
});


test("Benchmark resume reuses completed samples and preserves the locked selection", async () => {
  const options = await fixture();
  const config = JSON.parse(await readFile(options.configPath, "utf8"));
  config.with.run = { onError: "continue" };
  await writeFile(options.configPath, JSON.stringify(config));
  let calls = 0;
  (globalThis as Record<string, unknown>).__cliOnSolve = () => { if (++calls === 1) throw new Error("temporary failure"); };
  const first = await runWorkflow(options);
  expect(first.record.status).toBe("failed");
  expect(first.record.units.map(unit => unit.status).sort()).toEqual(["completed", "failed"]);
  const resumed = await runWorkflow({ ...options, resume: first.record.runId });
  expect(resumed.record.status, JSON.stringify(resumed.record.steps.filter(step => step.errors.length))).toBe("completed");
  expect(calls).toBe(3);
  expect(resumed.record.units).toHaveLength(3);
});

test("completed Benchmark resume verifies native trajectory checksums", async () => {
  const options = await fixture();
  const first = await runWorkflow(options);
  expect(first.record.status).toBe("completed");
  const unit = first.record.units[0]!;
  const evidence = join(first.directory, "benchmark-evidence", first.record.runId);
  const manifest = JSON.parse(await readFile(join(evidence, "manifest.json"), "utf8"));
  expect(manifest.configSummary).toMatchObject({ model: "fixture", solver: "cli-fixture" });
  expect(Object.keys(manifest.pluginVersions).length).toBeGreaterThan(0);
  await writeFile(join(evidence, "tasks", safeTaskKey(unit.caseId), "attempts", unit.attemptId, "agent", "trajectory.jsonl"), "changed");
  const resumed = await runWorkflow({ ...options, resume: first.record.runId });
  expect(resumed.record.status).toBe("failed");
  expect(resumed.record.errors[0]?.message).toContain("checksum changed");
});


test("Benchmark retries truncated streams as fresh attempts before applying stop-on-error", async () => {
  const options = await fixture("transient");
  const result = await runWorkflow(options);
  expect(result.record.status, JSON.stringify(result.record.errors)).toBe("completed");
  expect(result.record.units).toHaveLength(4);
  for (const id of ["a", "b"]) expect(result.record.units.filter(unit => unit.caseId === id).map(unit => unit.status)).toEqual(["failed", "completed"]);
  expect(new Set(result.record.units.map(unit => unit.attemptId)).size).toBe(4);
  expect(result.record.units.every(unit => unit.cleanupStatus === "cleaned")).toBe(true);
});


test("unused model services do not require credentials during a Benchmark run", async () => {
  const options = await fixture();
  const config = JSON.parse(await readFile(options.configPath, "utf8"));
  config.with.services.unused = { model: "unused-model", base_url: "https://unused.invalid", apiKeyEnv: "UNAVAILABLE_UNUSED_KEY" };
  await writeFile(options.configPath, JSON.stringify(config));
  const result = await runWorkflow(options);
  expect(result.record.status, JSON.stringify(result.record.errors)).toBe("completed");
  expect(result.record.units).toHaveLength(2);
});


test.each(["batch", "pipeline"])("%s matrix planning failure does not allocate unprepared cases or later groups", async mode => {
  const options = await fixture();
  await copyFile(join(options.root, "plugin.mjs"), join(options.root, "base.mjs"));
  await copyFile(join(import.meta.dirname, "../fixtures/cli/planned-plugin.mjs"), join(options.root, "plugin.mjs"));
  const config = JSON.parse(await readFile(options.configPath, "utf8"));
  config.with.benchmark.name = "planned-fixture";
  config.with.environment = "planned-fixture";
  config.with.run = { onError: "abort", preparation: { mode, concurrency: 1, ...(mode === "pipeline" ? { lookahead: 1 } : {}) } };
  config.with.variants = [{ id: "first" }, { id: "second" }];
  await writeFile(options.configPath, JSON.stringify(config));
  (globalThis as Record<string, unknown>).__workflowPlanningFailures = ["b"];
  let solves = 0, materializations = 0;
  (globalThis as Record<string, unknown>).__cliOnSolve = () => { solves++; };
  (globalThis as Record<string, unknown>).__workflowMaterialize = () => { materializations++; };
  const result = await runWorkflow(options);
  expect(result.record.status).toBe("failed");
  expect(solves).toBe(0); expect(materializations).toBe(0);
  const results = await import("node:fs/promises").then(fs => fs.readdir(result.directory, { recursive: true }));
  const records = await Promise.all(results.filter(file => file.endsWith("result.json")).map(async file => ({
    file, record: JSON.parse(await readFile(join(result.directory, file), "utf8")),
  })));
  expect(records).toHaveLength(1);
  expect(records[0]?.file.replaceAll("\\", "/")).toContain("benchmark-groups/first/");
  expect(records[0]?.record).toMatchObject({ key: { taskId: "b" }, executionStatus: "failed" });
});
