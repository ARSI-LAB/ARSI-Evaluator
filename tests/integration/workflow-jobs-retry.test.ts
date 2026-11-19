import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { retryWorkflowJobs } from "../../src/application/ray/workflow-jobs.js";
import * as managed from "../../src/application/ray/managed-local.js";
import { JobsClient } from "../../src/infrastructure/ray/jobs-client.js";
import { inspectWorkflow } from "../../src/application/workflow.js";
import { parseJobsConfig } from "../../src/config/jobs.js";

afterEach(() => vi.restoreAllMocks());

test("managed Jobs retry validates its receipt then starts the gateway before opening its credentials or connection", async () => {
  const root = await mkdtemp(join(tmpdir(), "workflow-jobs-retry-"));
  try {
    const file = join(root, "eval.yaml"), runId = randomUUID();
    await writeFile(file, JSON.stringify({ schemaVersion: 2, workflow: "application.evaluate", with: { model: { model: "fixture" }, cases: [] } }));
    const plan = await inspectWorkflow({ configPath: file, env: {} });
    const config = parseJobsConfig({ managedLocal: true, transport: "jobs", bundles: { fixture: join(root, "bundle") } });
    const metadata = { config, configDirectory: root, outputDirectory: root, runId };
    const receiptPath = join(root, ".jobs", `${runId}.workflow.json`);
    await mkdir(join(root, ".jobs"));
    const receipt = { runId, jobId: randomUUID(), fingerprint: plan.fingerprint, endpoint: config.endpoint,
      submission: {}, credentialNames: [], collected: true };
    await writeFile(receiptPath, JSON.stringify(receipt));
    let gatewayStarted = false;
    const start = vi.spyOn(managed, "ensureManagedLocalCluster").mockImplementation(async () => { gatewayStarted = true; });
    const connect = vi.spyOn(JobsClient, "create").mockImplementation(async (_config, _resolvePath, evaluationCredentials) => {
      expect(gatewayStarted).toBe(true);
      expect(evaluationCredentials).toEqual(["model-fixture"]);
      throw new Error("gateway fixture reached");
    });
    const env = { [config.tokenEnv]: "gateway-fixture", MODEL_KEY: "model-fixture" };
    await expect(retryWorkflowJobs(join(root, runId), metadata, plan, ["MODEL_KEY"], { env })).rejects.toThrow("gateway fixture reached");
    expect(start).toHaveBeenCalledWith(expect.any(AbortSignal), expect.any(Function), config.bundles);
    expect(connect).toHaveBeenCalledOnce();
    start.mockClear(); connect.mockClear();
    await writeFile(receiptPath, JSON.stringify({ ...receipt, fingerprint: "changed" }));
    await expect(retryWorkflowJobs(join(root, runId), metadata, plan, [], {})).rejects.toThrow("differs from its submitted workflow");
    expect(start).not.toHaveBeenCalled(); expect(connect).not.toHaveBeenCalled();
  } finally { await rm(root, { recursive: true, force: true }); }
});
