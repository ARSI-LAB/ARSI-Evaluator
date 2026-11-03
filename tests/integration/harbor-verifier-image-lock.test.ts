import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { expect, test, vi } from "vitest";

const exec = promisify(execFile);

test.each(["verifier", "runtime"])("two %s processes sharing a Docker target build once and inspect after acquiring the lock", async kind => {
  const root = await mkdtemp(join(tmpdir(), "verifier-image-process-"));
  const jobs: ReturnType<typeof exec>[] = [];
  const start = () => {
    const job = exec(process.execPath, [resolve("tests/fixtures/verifier-image-process.mjs"), root, kind], {
      env: { ...process.env, EVALUATOR_CACHE_DIR: root }, timeout: 15000, windowsHide: true,
    });
    void job.catch(() => {});
    jobs.push(job);
  };
  try {
    start();
    await vi.waitFor(async () => expect((await readFile(join(root, "builds"), "utf8")).trim()).toMatch(/^\d+$/u), { timeout: 5000 });
    start();
    // The second process has published its lock candidate and is waiting for the owner.
    await vi.waitFor(async () => {
      const files = await readdir(join(root, "image-builds"));
      expect(files.filter(file => file.endsWith(".tmp"))).toHaveLength(1);
      expect(files.filter(file => file.endsWith(".lock"))).toHaveLength(1);
    }, { timeout: 5000 });
    expect((await readFile(join(root, "inspections"), "utf8")).trim().split("\n")).toHaveLength(1);
    await writeFile(join(root, "release"), "release\n");
    const results = await Promise.all(jobs);
    expect(results[0]?.stdout).toMatch(kind === "verifier" ? /^ember-harbor-verifier:[a-f0-9]{24}$/u : /^ember-evaluator\/shared:solve-runtime-[a-f0-9]{24}$/u);
    expect(results[1]?.stdout).toBe(results[0]?.stdout);
    expect((await readFile(join(root, "builds"), "utf8")).trim().split("\n")).toHaveLength(1);
    expect((await readFile(join(root, "inspections"), "utf8")).trim().split("\n")).toHaveLength(kind === "verifier" ? 2 : 3);
    expect(await readdir(join(root, "image-builds"))).toEqual([]);
  } finally {
    await writeFile(join(root, "release"), "release\n");
    await Promise.allSettled(jobs);
    await rm(root, { recursive: true, force: true });
  }
}, 20000);
