import { copyFile, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, test, vi } from "vitest";
import { runWorkflow, retryWorkflow } from "../../src/application/workflow.js";
import { rebuildWorkflowReport } from "../../src/application/workflow-report.js";
import { runCli } from "../../src/cli/main.js";

const roots: string[] = [];
// Report scenarios execute, resume and rebuild from real persisted evidence.
vi.setConfig({ testTimeout: 30_000 });
const state = globalThis as Record<string, unknown>;
afterEach(async () => {
  for (const key of ["__cliOnSolve", "__cliOnSolverFactory", "__offlineRenderCalls", "__offlineReportFailure", "__offlineOnly"]) delete state[key];
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "workflow-report-")); roots.push(root);
  await copyFile(join(import.meta.dirname, "../fixtures/cli/plugin.mjs"), join(root, "cli.mjs"));
  await writeFile(join(root, "report.mjs"), `import { registerNativeResource } from "arsi-evaluator";
export const inject = ["evaluator"];
export function apply(ctx) {
  registerNativeResource(ctx, "reporter", "offline-fixture", value => value, (_config, runtime) => {
    if (globalThis.__offlineOnly && runtime.services) throw new Error("Reporting factory received evaluation services");
    return { taskReports(snapshot) { return snapshot.run.taskIds.map(taskId => ({ id: taskId, taskId, title: taskId })); }, async render(snapshot, _metrics, context) {
      globalThis.__offlineRenderCalls = (globalThis.__offlineRenderCalls ?? 0) + 1;
      if (globalThis.__offlineReportFailure) throw new Error("fixture offline rendering failed");
      return "# Custom offline report\\n" + snapshot.records.map(row => row.executionStatus + " " + row.errors.map(error => error.code).join(",")).join("\\n")
        + (context ? "" : "\\n[task](points/task/report.md)");
    } };
  });
}
`);
  await writeFile(join(root, "unrelated.mjs"), "export function apply() {}\n");
  const configPath = join(root, "eval.yaml"), patchPath = join(root, "patch.yaml");
  await writeFile(patchPath, JSON.stringify([{ insert: ["cli", "report", "unrelated"].map(id => ({ id, name: `./${id}.mjs` })) }]));
  await writeFile(configPath, JSON.stringify({ schemaVersion: 2, workflow: "benchmark.evaluate", output: { directory: "runs" }, with: {
    benchmark: { name: "cli-fixture", solver: "cli-fixture" }, environment: "local", reporter: "offline-fixture",
    services: { default: { model: "fixture", base_url: "http://unused.invalid", apiKeyEnv: "REPORT_TEST_KEY" } },
    run: { onError: "continue" },
  } }));
  return { root, configPath, patchPath, env: { REPORT_TEST_KEY: "fixture-model-auth-not-in-report" } };
}

test("offline CLI loads only selected renderers, never creates solvers or requires credentials", async () => {
  const options = await fixture();
  let solvers = 0;
  state.__cliOnSolverFactory = () => { solvers++; };
  const run = await runWorkflow(options), before = solvers;
  state.__offlineOnly = true;
  await rm(join(options.root, "unrelated.mjs"));
  const output: string[] = [], errors: string[] = [];
  expect(await runCli(["report", run.directory], { out: value => output.push(value), error: value => errors.push(value) }), errors.join("\n")).toBe(0);
  expect(solvers).toBe(before);
  expect(await readFile(output[0] ?? "", "utf8")).toContain("Custom offline report");
  expect(await readFile(output[0] ?? "", "utf8")).not.toContain(options.env.REPORT_TEST_KEY);
});

test("offline rendering rejects changed report modules without rerunning evaluation", async () => {
  const options = await fixture(), run = await runWorkflow(options);
  const record = await readFile(join(run.directory, "run.json"), "utf8");
  await writeFile(join(options.root, "report.mjs"), "export function apply() {}\n");
  await expect(rebuildWorkflowReport(run.directory)).rejects.toThrow("version differs");
  expect(await readFile(join(run.directory, "run.json"), "utf8")).toBe(record);
});

test("cancelled execution publishes a partial report using saved evidence", async () => {
  const options = await fixture(), controller = new AbortController();
  const run = await runWorkflow({ ...options, signal: controller.signal, onEvent: event => {
    if (event.message === "Starting benchmark.solve") controller.abort();
  } });
  expect(run.record.status).toBe("cancelled");
  const report = await readFile(join(run.directory, "report.md"), "utf8");
  expect(report).toContain("Status: cancelled");
  expect(report).toContain("Custom offline report");
});

test("explicit resume preserves the previous report while retry and offline rendering update the current report", async () => {
  const options = await fixture();
  let fail = true, calls = 0;
  state.__cliOnSolve = () => { calls++; if (fail) throw new Error("ECONNRESET"); };
  const first = await runWorkflow(options);
  const initial = await readFile(join(first.directory, "report.md"), "utf8");
  expect(initial).toContain("NETWORK_FAILURE");
  await runWorkflow({ ...options, resume: first.record.runId });
  const archived = await readFile(join(first.directory, "reports/initial/report.md"), "utf8");
  expect(archived).toBe(initial);
  const attachment = archived.match(/\[task\]\(([^)]+)\)/)?.[1];
  expect(attachment).toBeDefined();
  const originalAttachment = await readFile(join(first.directory, "reports/initial", attachment ?? ""), "utf8");
  expect(originalAttachment).toContain("NETWORK_FAILURE");
  fail = false;
  await retryWorkflow(first.directory, { env: options.env, requestId: "report-retry" });
  expect(calls).toBe(3);
  expect(await readFile(join(first.directory, "reports/resume-1/report.md"), "utf8")).not.toContain("NETWORK_FAILURE");
  expect(await readFile(join(first.directory, "reports/initial/report.md"), "utf8")).toBe(archived);
  expect(await readFile(join(first.directory, "reports/initial", attachment ?? ""), "utf8")).toBe(originalAttachment);
  expect(await readFile(join(first.directory, "reports/resume-1", attachment ?? ""), "utf8")).not.toContain("NETWORK_FAILURE");
  await rebuildWorkflowReport(first.directory);
  expect((await readdir(join(first.directory, "reports"))).sort()).toEqual(["current.json", "initial", "resume-1"]);
});

test("offline report attachments cannot overwrite the saved plan", async () => {
  const options = await fixture();
  await writeFile(join(options.root, "report.mjs"), `export const inject = ["evaluator"];
export function apply(ctx) { ctx.evaluator.registerStep({ type: "unsafe.report", apiVersion: 1, version: "1",
  inputs: {}, outputs: {}, resources: {}, effects: "pure", validateConfig: value => value,
  async execute() { return {}; }, report: { async rebuild(_config, context) {
    if (context.runtime || context.resource) throw new Error("Offline context exposed evaluation resources");
    return { markdown: "report", files: { "../plan.json": "overwritten" } };
  } } }); }
`);
  await writeFile(options.configPath, JSON.stringify({ schemaVersion: 2, output: { directory: "runs" },
    workflow: { steps: [{ id: "report", use: "unsafe.report" }] } }));
  const run = await runWorkflow(options);
  expect(run.record.status).toBe("completed");
  const plan = await readFile(join(run.directory, "plan.json"), "utf8");
  expect(plan).not.toBe("overwritten");
  await expect(rebuildWorkflowReport(run.directory)).rejects.toThrow("Unsafe evidence path");
  expect(await readFile(join(run.directory, "plan.json"), "utf8")).toBe(plan);
});
