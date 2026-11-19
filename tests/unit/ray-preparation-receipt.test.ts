import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { readPreparedTask } from "../../src/infrastructure/ray/preparation-receipt.js";
import { safeTaskKey } from "../../src/core/artifacts/artifacts.js";
import { fingerprintConfig } from "../../src/core/results/run-manifest.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

test("a ready receipt is accepted only for its locked task, source, package and configuration", async () => {
  const root = await mkdtemp(join(tmpdir(), "ray-prepared-")); roots.push(root);
  const key = { runId: "run", taskId: "case", attemptId: "attempt" };
  const expected = { packageDigest: "package", source: { source: "fixture", revision: "1", files: [], metadata: {} }, configFingerprint: "config" };
  const task = { input: { id: "case", prompt: "input" }, verification: { hidden: "answer" },
    solveEnv: { workdir: ".", image: null, initialFiles: [], runtime: [] }, verifyEnv: null, transfer: null };
  const receipt = { ...expected, task };
  const directory = join(root, "preparations", key.runId, "round"); await mkdir(directory, { recursive: true });
  const file = join(directory, `${safeTaskKey(key.taskId)}.json`);
  await writeFile(file, JSON.stringify(receipt));
  const ready = { roundId: "round", digest: fingerprintConfig(receipt) };
  expect(await readPreparedTask(root, key, ready, expected)).toEqual(task);
  for (const mismatched of [{ ...expected, packageDigest: "other" }, { ...expected, configFingerprint: "other" },
    { ...expected, source: { ...expected.source, revision: "other" } }])
    await expect(readPreparedTask(root, key, ready, mismatched)).rejects.toThrow("differs from dispatch");
  await writeFile(file, JSON.stringify({ ...receipt, task: { ...task, verification: { hidden: "changed" } } }));
  await expect(readPreparedTask(root, key, ready, expected)).rejects.toThrow("ready barrier");
  await expect(readPreparedTask(root, key, { ...ready, roundId: "../round" }, expected)).rejects.toThrow("Unsafe");
});
