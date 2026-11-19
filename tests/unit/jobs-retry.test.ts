import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { retryWorkflowJobs } from "../../src/application/ray/workflow-jobs.js";
import { JobsClient } from "../../src/infrastructure/ray/jobs-client.js";
import { parseJobsConfig } from "../../src/config/jobs.js";
import { parseWorkflowDocument } from "../../src/config/workflow-schema.js";
import { compileWorkflow } from "../../src/core/workflow/compile.js";
import { WorkflowDefinitions } from "../../src/core/workflow/catalog.js";
import type { WorkflowRunRecord } from "../../src/core/contracts/workflow.js";

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "workflow-retry-client-")); roots.push(root);
  const runId = randomUUID(), jobId = randomUUID();
  const config = parseJobsConfig({ endpoint: "https://gateway.invalid", caFile: "cert.pem" });
  const plan = compileWorkflow(parseWorkflowDocument({ schemaVersion: 2, workflow: { steps: [] } }), new WorkflowDefinitions());
  await mkdir(join(root, ".jobs"));
  await writeFile(join(root, ".jobs", `${runId}.workflow.json`), JSON.stringify({ runId, jobId, fingerprint: plan.fingerprint,
    endpoint: config.endpoint, submission: {}, credentialNames: [], collected: false }));
  const metadata = { config, configDirectory: root, outputDirectory: root, runId };
  const client = new JobsClient(config.endpoint, Buffer.alloc(0), "fixture");
  vi.spyOn(JobsClient, "create").mockResolvedValue(client);
  return { root, runId, jobId, metadata, plan, call: vi.spyOn(client, "call"), attach: vi.spyOn(client, "attach") };
}

test("active Jobs retry targets the original coordinator without sending credentials or starting another Job", async () => {
  const f = await fixture();
  const record: WorkflowRunRecord = { schemaVersion: 2, runId: f.runId, fingerprint: f.plan.fingerprint, implementations: {}, startedAt: new Date().toISOString(),
    finishedAt: null, status: "running", businessComplete: false, outputs: {}, units: [], steps: [], resources: [], artifacts: [], errors: [] };
  f.call.mockResolvedValue({ active: true, record, request: { requestId: "request-1", taskIds: ["task-a"], reason: "test", status: "pending", bindings: {} } });
  const result = await retryWorkflowJobs(join(f.root, f.runId), f.metadata, f.plan, ["MODEL_KEY"], { env: { MODEL_KEY: "private-fixture-key" }, taskIds: ["task-a"], requestId: "request-1", reason: "test" });
  expect(result.queued).toBe(true); expect(result.record).toEqual(record);
  expect(f.call).toHaveBeenCalledOnce(); expect(f.call.mock.calls[0]?.slice(0, 2)).toEqual([`/jobs/${f.jobId}/retry`, {
    kind: "workflow", runId: f.runId, fingerprint: f.plan.fingerprint, taskIds: ["task-a"], requestId: "request-1", reason: "test" }]);
  expect(f.attach).not.toHaveBeenCalled(); expect(JSON.stringify(f.call.mock.calls)).not.toContain("private-fixture-key");
});

test("a lost retry acknowledgement exposes the generated request ID for safe replay", async () => {
  const f = await fixture(); f.call.mockRejectedValue(new Error("gateway connection closed"));
  const result = retryWorkflowJobs(join(f.root, f.runId), f.metadata, f.plan, [], {});
  await expect(result).rejects.toThrow("Resubmit the same request ID");
  const sent = f.call.mock.calls[0]?.[1];
  if (!sent || typeof sent !== "object" || !("requestId" in sent)) throw new Error("Missing submitted request ID");
  await expect(result).rejects.toThrow(String(sent.requestId)); expect(f.attach).not.toHaveBeenCalled();
});
