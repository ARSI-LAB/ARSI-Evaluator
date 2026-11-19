import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { buildFileManifest } from "../../src/core/artifacts/artifacts.js";
import { downloadRunResults } from "../../src/application/ray/jobs-results.js";
import type { JobsClient } from "../../src/infrastructure/ray/jobs-client.js";

/** Serves a directory the way the jobs gateway does: manifest plus base64 chunks. */
function fakeClient(remoteRoot: string): JobsClient {
  const runDirectory = async () => join(remoteRoot, (await readdir(remoteRoot))[0]!);
  return {
    async call(path: string) {
      const manifestMatch = /^\/jobs\/([^/]+)\/manifest$/u.exec(path);
      if (manifestMatch) {
        const runId = (await readdir(remoteRoot))[0]!;
        const inventory = await buildFileManifest(await runDirectory(), []);
        return { runId, files: inventory.files, missing: inventory.missing };
      }
      const fileMatch = /^\/jobs\/[^/]+\/file\?path=([^&]+)&offset=(\d+)$/u.exec(path);
      if (!fileMatch) throw new Error(`unexpected jobs call: ${path}`);
      const relative = decodeURIComponent(fileMatch[1]!);
      const data = (await readFile(join(await runDirectory(), relative))).subarray(Number(fileMatch[2]), Number(fileMatch[2]) + 65536);
      return { data: data.toString("base64") };
    },
  } as unknown as JobsClient;
}

test("download verifies chunked evidence, reports and empty files before publishing a snapshot", async () => {
  const root = await mkdtemp(join(tmpdir(), "evaluator-jobs-results-"));
  try {
    const runId = "01234567-89ab-4cde-8f01-23456789abcd", remote = join(root, "remote", runId);
    await mkdir(join(remote, "reports", "resume-1"), { recursive: true });
    await writeFile(join(remote, "reports", "resume-1", "report.md"), "saved report");
    const evidence = Buffer.alloc(1_200_123, 171);
    await writeFile(join(remote, "evidence.bin"), evidence);
    await writeFile(join(remote, "empty.txt"), "");
    await writeFile(join(remote, ".workflow.lock"), "remote coordinator");
    const destination = await downloadRunResults(fakeClient(join(root, "remote")), "job-1", join(root, "output"), () => {});
    expect((await readFile(join(destination, "evidence.bin"))).equals(evidence)).toBe(true);
    expect(await readFile(join(destination, "reports", "resume-1", "report.md"), "utf8")).toBe("saved report");
    expect(await readFile(join(destination, "empty.txt"), "utf8")).toBe("");
    expect(await readdir(destination)).not.toContain(".workflow.lock");
  } finally { await rm(root, { recursive: true, force: true }); }
});
