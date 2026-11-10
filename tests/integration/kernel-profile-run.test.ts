import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, expect, test } from "vitest";
import { Evaluator } from "../../src/evaluator.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture(ids: string[], selected: string[], taskTimeout: number) {
  await mkdir(".scratch", { recursive: true });
  const root = await mkdtemp(resolve(".scratch/kernel-profile-run-"));
  roots.push(root);
  const msprof = join(root, "msprof.cjs");
  await writeFile(join(root, "problem.py"), "class Model: pass\n");
  const tasks = [];
  for (const id of ids) {
    const candidate = `${id}.py`;
    await writeFile(join(root, candidate), `# ${id}\ndef kernel_function(x): return x\n`);
    tasks.push({ id, problem: "problem.py", candidate, referenceKind: "pytorch" });
  }
  await writeFile(join(root, "manifest.json"), JSON.stringify({ schemaVersion: 1, tasks }));
  const configPath = join(root, "config.yaml");
  await writeFile(configPath, JSON.stringify({
    services: { default: { model: "unused", base_url: "http://localhost:1/v1", api_key: "${TEST_API_KEY}" } },
    benchmark: { name: "kernel", config: { manifest: "manifest.json", operation: "profile", seeds: [0],
      timeoutSeconds: 30, profiling: { enabled: true, cacheEnabled: false, collection: "Default", roundNum: 0, msprofBin: msprof } } },
    run: { taskIds: selected, timeoutSeconds: taskTimeout }, output: { directory: "./results" },
  }));
  const run = () => new Evaluator().run({ configPath, env: { TEST_API_KEY: "unused" } });
  return { root, msprof, run };
}

test.skipIf(process.platform === "win32")("independent profiles publish fresh receipts for each selected manifest task", async () => {
  const { msprof, run } = await fixture(["first", "skip", "last"], ["first", "last"], 60);
  await writeFile(msprof, `#!/usr/bin/env node
const { mkdirSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const output = process.argv.find(s => s.startsWith("--output=")).slice("--output=".length);
const replay = process.argv.find(s => s.startsWith("--application=")).split(" --output ")[1];
const dir = join(output, "OPPROF_fixture");
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, "PipeUtilization.csv"), "block_id,sub_block_id,aiv_vec_ratio\\n0,vector,0.5\\n");
writeFileSync(join(dir, "L2Cache.csv"), "block_id,sub_block_id\\n0,vector\\n");
writeFileSync(join(dir, "ResourceConflictRatio.csv"), "block_id,aiv_vec_wait_ratio\\n0,0.1\\n");
writeFileSync(replay, JSON.stringify({ seed: 0, warmup: 25, requestedLogicalDevice: 0, logicalDevice: 0, deviceCount: 1,
  environment: { visibleDevices: "0" }, capture: { method: "mstx", range: "rsi_operator_profile", toolId: 4097, rangeId: 0, warmupCompleted: 25, callsInRange: 1 } }));
`, { mode: 0o755 });
  const result = await run();
  if (result.kind !== "local") throw new Error("expected a local result");
  expect(result.snapshot.run.taskIds).toEqual(["first", "last"]);
  expect(result.snapshot.records).toHaveLength(2);
  for (const { key, verdict } of result.snapshot.records) {
    const hash = createHash("sha256").update(`# ${key.taskId}\ndef kernel_function(x): return x\n`).digest("hex");
    expect(verdict).toMatchObject({ passed: null, details: { status: "completed", candidateSha256: hash,
      diagnosticProtocol: { caseId: key.taskId, seeds: [0] }, profiling: { metadata: { cacheRequested: false, roundNum: 0 } } } });
  }
});

test.skipIf(process.platform === "win32")("a shorter outer deadline waits for profiler cleanup and invalidates the interrupted measurement", async () => {
  const { root, msprof, run } = await fixture(["slow"], ["slow"], 2);
  const stopped = join(root, "profiler-stopped");
  await writeFile(msprof, `#!/usr/bin/env node
process.on("SIGTERM", () => setTimeout(() => {
  require("node:fs").writeFileSync(${JSON.stringify(stopped)}, String(process.pid));
  process.exit(0);
}, 30));
setInterval(() => {}, 1000);
`, { mode: 0o755 });
  const result = await run();
  if (result.kind !== "local") throw new Error("expected a local result");
  expect(result.snapshot.records[0]).toMatchObject({ executionStatus: "failed", scoreStatus: "not-applicable", cleanupStatus: "cleaned", verdict: null });
  expect(result.snapshot.records[0]?.errors).toEqual(expect.arrayContaining([expect.objectContaining({ phase: "verify" })]));
  const pid = Number(await readFile(stopped, "utf8"));
  expect(() => process.kill(pid, 0)).toThrowError(expect.objectContaining({ code: "ESRCH" }));
}, 15000);
