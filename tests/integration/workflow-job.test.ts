import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { parseWorkflowDocument } from "../../src/config/workflow-schema.js";
import { bindWorkflowNetwork } from "../../src/application/workflow-network.js";
import { compileWorkflow } from "../../src/core/workflow/compile.js";
import { executeWorkflowJob } from "../../src/application/ray/workflow-job.js";
import { uploadJobsSeed } from "../../src/application/ray/jobs-seed-upload.js";
import { openPluginRegistry } from "../../src/application/plugins/open-registry.js";
import { JobsClient } from "../../src/infrastructure/ray/jobs-client.js";
import { JobsSeedUploads } from "../../src/infrastructure/ray/jobs-seed.js";

test("Jobs plan execution restores full evidence on a fresh host and retries only the failed sample", async () => {
  const root = await mkdtemp(join(tmpdir(), "workflow-job-"));
  const registry = await openPluginRegistry();
  let fail = true;
  const calls: string[] = [], credentials: string[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      let body = ""; for await (const chunk of request) body += String(chunk);
      const prompt = String(JSON.parse(body).messages[0].content); calls.push(prompt);
      expect(request.headers.authorization).toBe("Bearer model-fixture-authentication");
      if (fail && prompt === "b") { response.writeHead(400); response.end(); return; }
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
    })().catch(() => { response.writeHead(500); response.end(); });
  });
  try {
    await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
    const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing fixture port");
    const template = registry.ctx.evaluator.workflows.template("application.evaluate");
    const document = parseWorkflowDocument(template.expand({ model: { model: "fixture", apiKeyEnv: "MODEL_AUTH",
      endpoint: `http://127.0.0.1:${address.port}/v1`, maxAttempts: 1 },
      cases: ["a", "b"].map(id => ({ id, request: { prompt: id }, reference: "ok" })) }));
    document.pathBase = "."; document.run.onError = "continue";
    await bindWorkflowNetwork(document, registry.ctx.evaluator.workflows, { env: {} });
    const plan = compileWorkflow(document, registry.ctx.evaluator.workflows, registry.pluginVersions);
    const runId = randomUUID(), originalJob = randomUUID();
    const runtime = { root: join(root, "cluster"), configDirectory: root, signal: AbortSignal.timeout(15_000),
      async credential(name: string) { credentials.push(name); return name === "MODEL_AUTH" ? "model-fixture-authentication" : undefined; } };
    const first = await executeWorkflowJob(originalJob, { plan, requestedRunId: runId }, registry, runtime);
    expect(first.record.status).toBe("failed");
    expect(first.record.units.map(unit => unit.status)).toEqual(["completed", "failed"]);
    expect(credentials.filter(name => name === "MODEL_AUTH")).toHaveLength(1);
    const recoveredRoot = join(root, "new-cluster"), nextJob = randomUUID();
    const upload = new JobsSeedUploads(join(recoveredRoot, ".seeds"));
    class Client extends JobsClient {
      override async call(_path: string, body?: unknown): Promise<unknown> { return upload.handle(nextJob, body); }
    }
    const seedDigest = await uploadJobsSeed(new Client("https://unused", Buffer.alloc(0), ""), nextJob, runId, first.directory, runtime.signal);
    fail = false;
    const second = await executeWorkflowJob(nextJob, { plan, requestedRunId: runId, resumeRunId: runId, seedDigest }, registry,
      { ...runtime, root: recoveredRoot });
    expect(second.record.status, JSON.stringify(second.record.errors)).toBe("completed");
    expect(second.record.units).toHaveLength(3);
    expect(calls).toEqual(["a", "b", "b"]);
    expect(second.record.units[0]).toEqual(first.record.units[0]);
    expect(await readFile(join(second.directory, "run.json"), "utf8")).not.toContain("model-fixture-authentication");
    await expect(executeWorkflowJob(randomUUID(), { plan: { ...plan, fingerprint: "changed" }, requestedRunId: runId }, registry, runtime))
      .rejects.toThrow("installed plugins changed");
    expect(calls).toHaveLength(3);
  } finally {
    server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()));
    await registry.dispose(); await rm(root, { recursive: true, force: true });
  }
}, 20_000);
