import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { locateRun, registerRunLocation } from "../../src/infrastructure/filesystem/run-index.js";

let root: string | undefined;
afterEach(async () => { vi.unstubAllEnvs(); if (root) await rm(root, { recursive: true, force: true }); });
test("resolves current and bare directories, explicit paths, and indexed IDs", async () => {
  root = await mkdtemp(join(tmpdir(), "run-index-"));
  vi.stubEnv("EVALUATOR_RUN_INDEX_DIR", join(root, "index"));
  const directory = join(root, "run"); await mkdir(directory);
  await registerRunLocation("fixture-run", directory);
  expect(await locateRun("fixture-run")).toBe(directory);
  expect(await locateRun(directory)).toBe(directory);
  expect(await locateRun(".")).toBe(resolve("."));
  expect(await locateRun("tests")).toBe(resolve("tests"));
  await writeFile(join(root, "index", "invalid.json"), JSON.stringify({ runId: "different", directory }));
  await expect(locateRun("invalid")).rejects.toThrow("Invalid run index");
});
