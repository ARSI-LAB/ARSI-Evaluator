import { readFile, writeFile, readdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join } from "node:path";
import assert from "node:assert/strict";
import { safeTaskKey } from "../../dist/core/artifacts/artifacts.js";
import { JobsClient } from "../../dist/infrastructure/ray/jobs-client.js";

process.env.EVALUATOR_JOBS_TOKEN = (await readFile("/security/jobs-token", "utf8")).trim();
process.env.EVALUATOR_SMOKE_MODEL_KEY = "smoke-only-not-a-model-key";
const file = "/experiment/jobs-controlled.json";
const output = `/results/jobs-controlled-${Date.now()}`;
const config = { schemaVersion: 2, workflow: "benchmark.evaluate", with: {
  services: { default: { model: "fixture", base_url: "https://fixture.invalid/v1", api: "openai-completions", apiKeyEnv: "EVALUATOR_SMOKE_MODEL_KEY" } },
  benchmark: { name: "ray-fixture", solver: { name: "ray-fixture", service: "default" } }, environment: "local",
  deployment: { kind: "ray-jobs", endpoint: "https://gateway:9443", caFile: "/security/cert.pem", tokenEnv: "EVALUATOR_JOBS_TOKEN" },
  scheduler: { name: "ray", concurrency: 2 },
  metrics: [{ name: "success-rate" }, { name: "duration" }], run: { maxTasks: 2, timeoutSeconds: 120 } }, output: { directory: output },
};
await writeFile(file, JSON.stringify(config));
const spawnCli = args => {
  const child = spawn("node", ["dist/cli.js", ...args, ...(args[0] === "run" ? ["--patch", "/experiment/cordis.patch.yaml"] : [])], { stdio: "inherit", env: process.env });
  child.on("error", error => { throw error; });
  return child;
};
const exitCode = child => new Promise(done => child.on("exit", done));

// Submit and observe; the job outlives a hard CLI kill (not a SIGINT cancel).
const first = spawnCli(["run", file]);
const firstExit = new Promise(resolve => first.once("exit", (code, signal) => resolve({ code, signal })));
const client = await JobsClient.create(config.with.deployment, path => path);
let receipt;
for (let i = 0; i < 120 && !receipt; i++) {
  await new Promise(done => setTimeout(done, 500));
  assert.equal(first.exitCode, null, "CLI exited before the interruption");
  const names = (await readdir(join(output, ".jobs")).catch(error => {
    if (error.code === "ENOENT") return [];
    throw error;
  })).filter(name => name.endsWith(".workflow.json"));
  if (names.length !== 1) continue;
  const saved = JSON.parse(await readFile(join(output, ".jobs", names[0]), "utf8"));
  const job = await client.call(`/jobs/${saved.jobId}`).catch(error => {
    if (error.statusCode === 404) return null;
    throw error;
  });
  if (job?.status === "RUNNING") receipt = saved;
}
assert.ok(receipt, "Job did not reach RUNNING");
assert.ok(first.kill("SIGKILL"));
assert.deepEqual(await firstExit, { code: null, signal: "SIGKILL" });
console.log("First CLI killed; job continues on the cluster:", receipt.jobId);

// Resume without a run-id: no local copy yet, so the only live job is reattached.
assert.equal(await exitCode(spawnCli(["run", file, "--resume"])), 0);
const followed = JSON.parse(await readFile(join(output, ".jobs", `${receipt.runId}.workflow.json`), "utf8"));
assert.equal(followed.jobId, receipt.jobId);
assert.equal(followed.collected, true);

const runs = (await readdir(output)).filter(name => !name.startsWith(".")); assert.equal(runs.length, 1);
const directory = join(output, runs[0]);
const workflow = JSON.parse(await readFile(join(directory, "run.json"), "utf8"));
const evidence = join(directory, "benchmark-evidence", workflow.runId);
const manifest = JSON.parse(await readFile(join(evidence, "manifest.json"), "utf8"));
assert.equal(manifest.status, "completed"); assert.equal(manifest.taskIds.length, 2);
const attempts = workflow.resources.filter(resource => resource.identity.kind === "dispatch");
assert.equal(attempts.length, 2); assert.ok(attempts.every(a => a.state === "released"));
assert.ok(workflow.units.every(unit => unit.status === "completed" && unit.cleanupStatus === "cleaned"));
assert.ok(new Set(attempts.map(a => a.identity.nodeId)).size >= 2);
for (const a of attempts) {
  const result = JSON.parse(await readFile(join(evidence, "tasks", safeTaskKey(a.identity.job.taskId), "attempts", a.identity.job.attemptId, "result.json"), "utf8"));
  assert.equal(result.executionStatus, "completed"); assert.equal(result.verdict.score, 1);
}
// The follow CLI already rebuilt the report; `report` must reproduce it offline.
assert.equal(await exitCode(spawnCli(["report", directory])), 0);
console.log("Ray Jobs acceptance passed:", directory);
