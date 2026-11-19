import { copyFile, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { runCli } from "../../src/cli/main.js";
import { inspectWorkflow } from "../../src/application/workflow.js";
import { workflowObject } from "../../src/core/workflow/values.js";

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  delete (globalThis as Record<string, unknown>).__cliOnSolverFactory;
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "workflow-cli-")); roots.push(root);
  const patchPath = join(root, "patch.yaml"), configPath = join(root, "config.yaml");
  await copyFile(join(import.meta.dirname, "../fixtures/cli/plugin.mjs"), join(root, "plugin.mjs"));
  await writeFile(patchPath, JSON.stringify([{ insert: [{ id: "cli-fixture", name: "./plugin.mjs" }] }]));
  const parameters = {
    services: { default: { model: "${UNSET_CLI_MODEL}", base_url: "${UNSET_CLI_ENDPOINT}", apiKeyEnv: "UNSET_CLI_KEY" } },
    benchmark: { name: "cli-fixture", config: { tasks: ["a", "b", "c"] }, solver: "cli-fixture" },
    environment: "local", run: { offset: 1, maxTasks: 1 },
  };
  await writeFile(configPath, JSON.stringify({ schemaVersion: 2, workflow: "benchmark.evaluate", with: parameters }));
  const out: string[] = [], errors: string[] = [], io = { out: (text: string) => { out.push(text); }, error: (text: string) => { errors.push(text); } };
  return { root, patchPath, configPath, parameters, out, errors, io };
}

test("CLI shortcuts replace missing variables before expansion and credentials stay out of persisted evidence", async () => {
  const f = await fixture(), ids = join(f.root, "ids.json");
  await writeFile(ids, JSON.stringify({ taskIds: ["c", "a"] }));
  const code = await runCli(["run", f.configPath, "--patch", f.patchPath, "--model", "selected-model", "--endpoint", "https://fixture.invalid",
    "--api-key", "CLI_PRIVATE_CREDENTIAL", "--task-ids-file", ids], f.io);
  expect(code, f.errors.join("\n")).toBe(0);
  const directory = f.out.at(-1); if (!directory) throw new Error("No result directory");
  const record = JSON.parse(await readFile(join(directory, "run.json"), "utf8"));
  expect(record.units.map((unit: { caseId: string }) => unit.caseId).sort()).toEqual(["a", "c"]);
  const plan = await readFile(join(directory, "plan.json"), "utf8");
  expect(plan).toContain("selected-model"); expect(plan).toContain("EVALUATOR_CLI_API_KEY");
  expect(plan + JSON.stringify(record) + f.out.join() + f.errors.join()).not.toContain("CLI_PRIVATE_CREDENTIAL");
  expect(process.env.EVALUATOR_CLI_API_KEY).toBeUndefined();
});

test("Benchmark dry-run selects cases without model credentials or evaluation output", async () => {
  const f = await fixture();
  const solverFactory = vi.fn(() => { throw new Error("Preview must not create a solver"); });
  (globalThis as Record<string, unknown>).__cliOnSolverFactory = solverFactory;
  const code = await runCli(["run", f.configPath, "--patch", f.patchPath, "--dry-run", "--model", "fixture", "--endpoint", "https://fixture.invalid"], f.io);
  expect(code, f.errors.join("\n")).toBe(0);
  expect(JSON.parse(f.out.at(-1) ?? "[]")).toContainEqual(expect.objectContaining({ provider: "benchmark.runtime", status: "passed",
    output: { groups: [{ id: "default", taskIds: ["b"] }] } }));
  expect(await readdir(f.root)).not.toContain("results");
  expect(solverFactory).not.toHaveBeenCalled();
});

test("an unknown judge service fails compilation before resource factories", async () => {
  const f = await fixture();
  await writeFile(f.configPath, JSON.stringify({ schemaVersion: 2, workflow: "benchmark.evaluate", with: {
    ...f.parameters, services: { default: { model: "fixture", base_url: "https://fixture.invalid" } },
    benchmark: { name: "cli-fixture", config: { judgeService: "missing" }, solver: "cli-fixture" },
  } }));
  await expect(inspectWorkflow({ configPath: f.configPath, patchPath: f.patchPath })).rejects.toThrow("judgeService references unknown service missing");
  expect(await readdir(f.root)).not.toContain("results");
});

test("template overrides target the selected solver service and preserve independent judge settings", async () => {
  const f = await fixture();
  await writeFile(f.configPath, JSON.stringify({ schemaVersion: 2, workflow: "benchmark.evaluate", with: {
    ...f.parameters, services: { subject: { model: "before", base_url: "https://subject.invalid" }, judge: { model: "judge", base_url: "https://judge.invalid" } },
    benchmark: { name: "cli-fixture", solver: { name: "cli-fixture", service: "subject" } },
  } }));
  const plan = await inspectWorkflow({ configPath: f.configPath, patchPath: f.patchPath, parameterOverrides: { model: "after", apiKeyEnv: "SUBJECT_KEY" } });
  const binding = plan.document.workflow.resources.benchmark;
  const value = binding?.config.experiment;
  if (!value || !("value" in value)) throw new Error("Missing benchmark configuration");
  const services = workflowObject(workflowObject(value.value).services);
  expect(services.subject).toMatchObject({ name: "after", apiKeyEnv: "SUBJECT_KEY" });
  expect(services.judge).toMatchObject({ name: "judge", endpoint: "https://judge.invalid" });
});

test("unsupported shortcuts fail before work starts", async () => {
  const f = await fixture();
  await writeFile(f.configPath, JSON.stringify({ schemaVersion: 2, workflow: "application.evaluate", with: { model: { model: "fixture" }, cases: [] } }));
  expect(await runCli(["run", f.configPath, "--model", "override"], f.io)).toBe(2);
  expect(f.errors.join("\n")).toContain("does not support command-line parameter overrides");
  expect(await readdir(f.root)).not.toContain("results");
});
