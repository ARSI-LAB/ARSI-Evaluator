import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";
import { JobsClient } from "../../src/infrastructure/ray/jobs-client.js";
import { ProgressPublisher, parseProgressSnapshot } from "../../src/core/progress/progress-wire.js";
import { LiveOperation } from "../../src/core/progress/live-progress.js";
import { createGatewayCertificate } from "../fixtures/ray/gateway-certificate.js";
import { uploadJobsSeed } from "../../src/application/ray/jobs-seed-upload.js";
import { JobsSeedUploads } from "../../src/infrastructure/ray/jobs-seed.js";

const available = spawnSync("openssl", ["version"], { windowsHide: true }).status === 0;
test.skipIf(!available)("authenticated Jobs gateway keeps previews in RAM and repopulates them after restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "jobs-live-gateway-"));
  const security = join(root, "security"); const jobs = join(root, "jobs"); const id = randomUUID();
  await mkdir(security); await mkdir(join(jobs, id), { recursive: true });
  const token = randomUUID() + randomUUID();
  await writeFile(join(security, "jobs-token"), token);
  await createGatewayCertificate(security);
  const backend = createServer((req, res) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(req.url?.endsWith("/logs") ? { logs: "formal logs only" } : { status: "RUNNING" })); });
  await new Promise<void>(done => backend.listen(0, "127.0.0.1", done));
  const address = backend.address(); if (!address || typeof address === "string") throw new Error("No backend port");
  let child: ChildProcess | undefined;
  let output = "";
  let client: JobsClient;
  const start = async () => {
    child = spawn(process.execPath, [resolve("src/application/ray/entries/jobs-gateway.mjs")], { windowsHide: true,
      env: { ...process.env, EVALUATOR_JOBS_ROOT: jobs, EVALUATOR_JOBS_SECURITY: security, EVALUATOR_JOBS_PORT: "0", EVALUATOR_RAY_DASHBOARD: `http://127.0.0.1:${address.port}` }, stdio: ["ignore", "pipe", "pipe"] });
    const port = await new Promise<number>((done, fail) => {
      const timeout = setTimeout(() => fail(new Error("Gateway did not start")), 10_000);
      child?.once("exit", () => { clearTimeout(timeout); fail(new Error("Gateway exited before listening")); });
      child?.stdout?.on("data", (chunk: Buffer) => {
        output += chunk.toString("utf8"); const match = /HTTPS :(\d+)/u.exec(output);
        if (match) { clearTimeout(timeout); done(Number(match[1])); }
      });
      child?.stderr?.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
    });
    client = new JobsClient(`https://127.0.0.1:${port}`, await readFile(join(security, "cert.pem")), token);
    return { port, client };
  };
  const stop = async () => {
    if (!child || child.exitCode !== null) return;
    const exited = new Promise<void>(done => child?.once("exit", () => done())); child.kill(); await exited; child = undefined;
  };
  let publisher: ProgressPublisher | undefined;
  try {
    const { port, client: activeClient } = await start();
    const denied = new JobsClient(`https://127.0.0.1:${port}`, await readFile(join(security, "cert.pem")), "incorrect-token");
    await expect(denied.call(`/jobs/${id}/progress`)).rejects.toMatchObject({ statusCode: 401 });
    const submission = { kind: "workflow", plan: {}, credentialValues: {} };
    const seedJob = randomUUID(), seedRun = randomUUID(), seedSource = join(root, "seed-source");
    await mkdir(seedSource);
    const seedBytes = Buffer.alloc(1_048_593, 127);
    await writeFile(join(seedSource, "binary.bin"), seedBytes);
    const seedDigest = await uploadJobsSeed(activeClient, seedJob, seedRun, seedSource, AbortSignal.timeout(10_000));
    const seedRestored = join(root, "restored-seed");
    await new JobsSeedUploads(join(jobs, ".seeds")).materialize(seedJob, seedRun, seedDigest, seedRestored);
    expect(await readFile(join(seedRestored, "binary.bin"))).toEqual(seedBytes);
    for (const invalid of [
      { ...submission, auth: "old-single-key" },
      { ...submission, auth: "old-single-key", serviceAuth: { default: "current-key" } },
      { ...submission, kind: "legacy", config: {} },
    ]) await expect(activeClient.call(`/jobs/${id}/submit`, invalid)).rejects.toMatchObject({ statusCode: 409 });
    const warmupId = randomUUID();
    await activeClient.call(`/jobs/${warmupId}/submit`, { ...submission, operation: "maintenance", maintenance: { operation: "warmup", options: {} } });
    const staged = JSON.parse(await readFile(join(jobs, warmupId, "input.json"), "utf8"));
    expect(staged).toMatchObject({ operation: "maintenance", maintenance: { operation: "warmup", options: {} }, credentialNames: [] });
    expect(staged).not.toHaveProperty("credentialValues");
    const credentialJob = randomUUID();
    const secret = "memory-only-gateway-test-credential";
    const credentialInput = { ...submission, requestedRunId: randomUUID(), credentialValues: { default: secret } };
    await activeClient.call(`/jobs/${credentialJob}/submit`, credentialInput);
    const stagedCredential = await readFile(join(jobs, credentialJob, "input.json"), "utf8");
    expect(stagedCredential).not.toContain(secret);
    expect(JSON.parse(stagedCredential)).toMatchObject({ credentialNames: ["default"] });
    expect(await activeClient.call(`/jobs/${credentialJob}/credential`, { scope: "run", name: "default" })).toEqual({ value: secret });
    await expect(activeClient.call(`/jobs/${credentialJob}/credential`, { scope: "run", name: "other" })).rejects.toMatchObject({ statusCode: 409 });
    await expect(denied.call(`/jobs/${credentialJob}/credential`, { scope: "run", name: "default" })).rejects.toMatchObject({ statusCode: 401 });
    const warmup = [{ provider: "fixture", path: "fixture", status: "passed", output: {} }];
    await writeFile(join(jobs, warmupId, "maintenance.json"), JSON.stringify(warmup));
    expect(await activeClient.call(`/jobs/${warmupId}/maintenance`)).toEqual(warmup);
    const cleanupId = randomUUID();
    await activeClient.call(`/jobs/${cleanupId}/submit`, { ...submission, operation: "maintenance", maintenance: { operation: "cleanup-images", options: { all: true, execute: false } } });
    const cleanup = [{ provider: "fixture", path: "fixture", status: "passed", output: { preview: true, nodes: [{ nodeId: "a", daemonId: "daemon-a", items: [] }] } }];
    await writeFile(join(jobs, cleanupId, "maintenance.json"), JSON.stringify(cleanup));
    expect(await activeClient.call(`/jobs/${cleanupId}/maintenance`)).toEqual(cleanup);
    for (const invalid of [
      { ...submission, operation: "warmup" },
      { ...submission, operation: "maintenance", maintenance: { operation: "warmup", options: {} }, requestedRunId: randomUUID() },
      { ...submission, operation: "unknown" },
      { ...submission, operation: "maintenance", maintenance: { operation: "cleanup-images", options: false } },
      { ...submission, operation: "maintenance", maintenance: { operation: "doctor", options: {} }, retry: {} },
      { ...submission, requestedRunId: randomUUID(), config: { apiKey: "must-not-persist" } },
    ]) await expect(activeClient.call(`/jobs/${randomUUID()}/submit`, invalid)).rejects.toMatchObject({ statusCode: 409 });
    publisher = new ProgressPublisher((snapshot, signal) => client.call(`/jobs/${id}/progress`, snapshot, signal), ["fixture-secret"]);
    const operation = new LiveOperation(publisher.observe, { phase: "solve", message: "waiting", taskId: "task" }, ["fixture-secret"]);
    operation.update({ lines: ["active tool output fixture-secret"] });
    await new Promise(done => setTimeout(done, 1200));
    const first = parseProgressSnapshot(await client!.call(`/jobs/${id}/progress`));
    expect(JSON.stringify(first)).toContain("active tool output [redacted]");
    expect(JSON.stringify(await client!.call(`/jobs/${id}/logs`))).not.toContain("active tool output");
    expect(await readdir(join(jobs, id))).toEqual([]);
    await stop(); output = ""; await start();
    await expect(client!.call(`/jobs/${credentialJob}/credential`, { scope: "run", name: "default" })).rejects.toMatchObject({ statusCode: 409 });
    await client!.call(`/jobs/${credentialJob}/submit`, credentialInput);
    expect(await client!.call(`/jobs/${credentialJob}/credential`, { scope: "run", name: "default" })).toEqual({ value: secret });
    await client!.call(`/jobs/${credentialJob}/credential`, { scope: "run", release: true });
    await expect(client!.call(`/jobs/${credentialJob}/credential`, { scope: "run", name: "default" })).rejects.toMatchObject({ statusCode: 409 });
    expect(parseProgressSnapshot(await client!.call(`/jobs/${id}/progress`)).publisherId).toBe("pending");
    await new Promise(done => setTimeout(done, 1200));
    const restored = parseProgressSnapshot(await client!.call(`/jobs/${id}/progress`));
    expect(restored.publisherId).toBe(first.publisherId);
    expect(restored.events[0]?.live?.idleMs).toBeGreaterThan(first.events[0]?.live?.idleMs ?? 0);
    operation.finish(); await publisher.close(); publisher = undefined;
    expect(output).not.toContain("active tool output"); expect(output).not.toContain("fixture-secret");
    expect(await readdir(join(jobs, id))).toEqual([]);
  } finally {
    await publisher?.close(); await stop();
    await new Promise<void>(done => backend.close(() => done()));
    await rm(root, { recursive: true, force: true });
  }
}, 20_000);
