import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from "node:fs/promises";
import { randomUUID, createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { JobsSeedUploads } from "../../src/infrastructure/ray/jobs-seed.js";
import { JobsClient } from "../../src/infrastructure/ray/jobs-client.js";
import { uploadJobsSeed } from "../../src/application/ray/jobs-seed-upload.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "jobs-seed-")); roots.push(root);
  return { root, id: randomUUID(), runId: randomUUID(), receiver: new JobsSeedUploads(join(root, "uploads")) };
}
const entry = (path: string, content: string) => ({ path, size: Buffer.byteLength(content), sha256: createHash("sha256").update(content).digest("hex") });

test("resume upload carries binary evidence across chunks and excludes local writer and retry ownership", async () => {
  const { root, id, runId, receiver } = await fixture();
  const source = join(root, "source"); await mkdir(join(source, "artifacts"), { recursive: true });
  const evidence = Buffer.alloc(1_200_123, 171);
  await writeFile(join(source, "artifacts", "data.bin"), evidence);
  await writeFile(join(source, "plan.json"), "{}");
  await writeFile(join(source, "run.json"), "{}");
  await writeFile(join(source, "empty.txt"), "");
  await mkdir(join(source, "reports", "resume-1"), { recursive: true });
  await writeFile(join(source, "reports", "resume-1", "report.md"), "previous report");
  await writeFile(join(source, "workflow-reporting.json"), "submitter plugin paths");
  await writeFile(join(source, ".workflow.lock"), "local pid");
  await writeFile(join(source, "retry-control.json"), "local coordinator");
  class Client extends JobsClient {
    override async call(path: string, body?: unknown): Promise<unknown> {
      expect(path).toBe(`/jobs/${id}/seed`);
      return receiver.handle(id, body);
    }
  }
  const digest = await uploadJobsSeed(new Client("https://unused", Buffer.alloc(0), ""), id, runId, source, new AbortController().signal);
  const destination = join(root, "results", runId);
  await receiver.materialize(id, runId, digest, destination);
  expect((await readFile(join(destination, "artifacts", "data.bin"))).equals(evidence)).toBe(true);
  expect(await readFile(join(destination, "reports", "resume-1", "report.md"), "utf8")).toBe("previous report");
  expect(await readdir(destination)).toEqual(["artifacts", "empty.txt", "plan.json", "reports", "run.json"]);
});

test("seed upload resumes after receiver restart and rejects altered replay, missing bytes and wrong digest", async () => {
  const { root, id, runId, receiver } = await fixture();
  const files = [entry("artifact.txt", "abcdef")];
  const started = await receiver.handle(id, { op: "start", runId, files });
  await receiver.handle(id, { op: "chunk", path: "artifact.txt", offset: 0, data: Buffer.from("abc").toString("base64") });
  const restarted = new JobsSeedUploads(join(root, "uploads"));
  expect(await restarted.handle(id, { op: "start", runId, files })).toEqual(started);
  await restarted.handle(id, { op: "chunk", path: "artifact.txt", offset: 0, data: Buffer.from("abc").toString("base64") });
  await expect(restarted.handle(id, { op: "chunk", path: "artifact.txt", offset: 0, data: Buffer.from("xyz").toString("base64") })).rejects.toThrow("replay changed");
  await expect(restarted.handle(id, { op: "commit" })).rejects.toThrow("digest mismatch");
  await restarted.handle(id, { op: "chunk", path: "artifact.txt", offset: 3, data: Buffer.from("def").toString("base64") });
  expect(await restarted.handle(id, { op: "commit" })).toEqual(started);
  expect(await restarted.handle(id, { op: "start", runId, files })).toEqual({ ...Object(started), committed: true });
  await expect(restarted.ready(id, runId, "wrong")).rejects.toThrow("identity mismatch");
  await expect(restarted.handle(id, { op: "chunk", path: "artifact.txt", offset: 0, data: "YWJj" })).rejects.toThrow("immutable");
});

test.each(["../outside", "/outside", "C:\\outside", ".workflow.lock", "retry-control.json"])("seed rejects unsafe or process-local path %s", async path => {
  const { receiver, id, runId } = await fixture();
  await expect(receiver.handle(id, { op: "start", runId, files: [entry(path, "")] })).rejects.toThrow();
});
