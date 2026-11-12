import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, expect, test } from "vitest";
import { safeTaskKey } from "../../src/core/artifacts/artifacts.js";
import { Evaluator } from "../../src/application/evaluator.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function runOperation(operation: "precision" | "bench", status: string, candidateMs: number | null) {
  await mkdir(".scratch", { recursive: true });
  const root = await mkdtemp(resolve(".scratch/kernel-operation-"));
  roots.push(root);
  await mkdir(join(root, "candidate"));
  await writeFile(join(root, "problem.py"), "class Model: pass\n");
  await writeFile(join(root, "candidate/kernel.py"), "from helper import run\nkernel_function = run\n");
  await writeFile(join(root, "candidate/helper.py"), "def run(x): return x\n");
  const worker = join(root, "worker.cjs");
  await writeFile(worker, `#!/usr/bin/env node
const { writeFileSync } = require("node:fs");
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => { input += chunk; });
process.stdin.on("end", () => {
  const request = JSON.parse(input);
  const output = process.argv[process.argv.indexOf("--output") + 1];
  const result = { operation: request.operation, candidateSha256: request.candidateSha256, referenceKind: request.referenceKind,
    timingScope: request.operation === "bench" ? "triton-kernels" : "all-device-kernels",
    status: ${JSON.stringify(status)}, error: "", referenceMs: null, candidateMs: ${JSON.stringify(candidateMs)}, speedup: null,
    request };
  const bytes = JSON.stringify(result);
  writeFileSync(output, bytes);
  process.stdout.write(bytes);
});
`, { mode: 0o755 });
  await writeFile(join(root, "tasks.json"), JSON.stringify({ tasks: [{ id: "candidate", problem: "problem.py", candidateRoot: "candidate",
    candidate: "candidate/kernel.py", files: ["candidate/helper.py"], referenceKind: "pytorch" }] }));
  const configPath = join(root, "experiment.yaml");
  await writeFile(configPath, JSON.stringify({
    services: { default: { model: "unused", base_url: "http://localhost:1/v1", api_key: "${TEST_API_KEY}" } },
    benchmark: { name: "kernel", config: { operation, manifest: "tasks.json", python: worker, seeds: [42], warmup: 7, repeat: 11 } },
    output: { directory: "./results" },
  }));
  const result = await new Evaluator().run({ configPath, env: { TEST_API_KEY: "unused" } });
  if (result.kind !== "local") throw new Error("expected local run");
  const native = JSON.parse(await readFile(join(result.runDirectory, `tasks/${safeTaskKey("candidate")}/attempts/${result.snapshot.records[0]!.key.attemptId}/verifier/kernel-result.json`), "utf8"));
  return { ...result, native };
}

test.skipIf(process.platform === "win32").each([true, false])("YAML precision records correctness without performance (%s)", async passed => {
  const result = await runOperation("precision", passed ? "passed" : "incorrect", null);
  expect(result.snapshot.run.evaluationKind).toBe("quality");
  expect(result.snapshot.records[0]).toMatchObject({ executionStatus: "completed", scoreStatus: "valid",
    verdict: { passed, score: passed ? 1 : 0, details: { operation: "precision", candidateMs: null, speedup: null } } });
  expect(result.native.request).toMatchObject({ operation: "precision", seeds: [42], warmup: 7, repeat: 11 });
  expect(Object.keys(result.native.request.hashes)).toContain("data/candidate/helper.py");
});

test.skipIf(process.platform === "win32")("YAML bench publishes only candidate timing and no correctness score", async () => {
  const result = await runOperation("bench", "completed", 0.125);
  expect(result.snapshot.run.evaluationKind).toBe("performance");
  expect(result.snapshot.records[0]).toMatchObject({ executionStatus: "completed", scoreStatus: "not-applicable",
    verdict: { passed: null, details: { operation: "bench", candidateMs: 0.125, timingScope: "triton-kernels" } } });
  expect(result.snapshot.records[0]?.verdict).not.toHaveProperty("score");
  const report = await readFile(join(result.runDirectory, "report.md"), "utf8");
  expect(report).toContain("0.125");
  const metrics = JSON.parse(await readFile(join(result.runDirectory, "metrics.json"), "utf8"));
  expect(metrics.metrics.kernel).toMatchObject({ measured: 1, passed: 0, rows: [{ candidateMs: 0.125, speedup: null, passed: null }] });
});

test.skipIf(process.platform === "win32")("YAML bench rejects an invalid duration without turning it into a candidate zero score", async () => {
  const result = await runOperation("bench", "completed", 0);
  expect(result.snapshot.records[0]).toMatchObject({ executionStatus: "failed", scoreStatus: "not-applicable", verdict: { passed: null, details: { status: "unavailable" } } });
  expect(result.snapshot.records[0]?.errors).toEqual(expect.arrayContaining([expect.objectContaining({ phase: "verify" })]));
});
