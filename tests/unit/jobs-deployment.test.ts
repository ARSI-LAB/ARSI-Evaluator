import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { maintainWorkflowJobs, runWorkflowJobs } from "../../src/application/ray/workflow-jobs.js";
import { downloadWorkflowResults } from "../../src/application/ray/workflow-jobs-results.js";
import { JobsClient } from "../../src/infrastructure/ray/jobs-client.js";
import { parseJobsConfig } from "../../src/config/jobs.js";
import { parseWorkflowDocument } from "../../src/config/workflow-schema.js";
import { compileWorkflow } from "../../src/core/workflow/compile.js";
import { WorkflowDefinitions } from "../../src/core/workflow/catalog.js";
import type { WorkflowRunRecord } from "../../src/core/contracts/workflow.js";

vi.mock("../../src/application/ray/workflow-jobs-results.js", () => ({ downloadWorkflowResults: vi.fn() }));
afterEach(() => vi.restoreAllMocks());
const config = parseJobsConfig({ transport: "jobs", endpoint: "https://jobs.invalid", caFile: "cert.pem" });
const plan = compileWorkflow(parseWorkflowDocument({ schemaVersion: 2, workflow: { steps: [] } }), new WorkflowDefinitions());
function connection() {
  const client = new JobsClient(config.endpoint, Buffer.alloc(0), "gateway-fixture");
  vi.spyOn(JobsClient, "create").mockResolvedValue(client);
  return { client, call: vi.spyOn(client, "call"), attach: vi.spyOn(client, "attach") };
}

test.each(["warmup", "preview", "cleanup-images"])("Jobs %s uses the maintenance protocol without model credentials or result allocation", async operation => {
  const { call, attach } = connection();
  const results = [{ path: "fixture", provider: "fixture", status: "passed", output: { ready: true } }];
  call.mockImplementation(async path => path.endsWith("/maintenance") ? results : {}); attach.mockResolvedValue(0);
  const request = { operation, options: operation === "cleanup-images" ? { all: false, execute: false } : {} };
  expect(await maintainWorkflowJobs(config, plan, [], request, { configDirectory: ".", signal: AbortSignal.timeout(5000), env: { MODEL_KEY: "must-not-send" } })).toEqual(results);
  expect(call.mock.calls[0]?.[1]).toMatchObject({ kind: "workflow", operation: "maintenance", maintenance: request, credentialValues: {} });
  expect(JSON.stringify(call.mock.calls)).not.toContain("must-not-send");
  expect(call.mock.calls.some(([path]) => /manifest|\/file|\/seed/.test(path))).toBe(false);
});

test("failed maintenance Jobs do not masquerade as successful preparation", async () => {
  const { call, attach } = connection(); call.mockResolvedValue({}); attach.mockResolvedValue(1);
  await expect(maintainWorkflowJobs(config, plan, [], { operation: "warmup", options: {} },
    { configDirectory: ".", signal: AbortSignal.timeout(5000), env: {} })).rejects.toThrow("failed");
  expect(call.mock.calls.some(([path]) => path.endsWith("/maintenance"))).toBe(false);
});

test("maintenance cancellation sends cancel and awaits cleanup with an independent deadline", async () => {
  const { call, attach } = connection(), controller = new AbortController(); call.mockResolvedValue({});
  const signals: AbortSignal[] = [];
  attach.mockImplementation(async (_id, _log, signal) => {
    signals.push(signal);
    if (signals.length === 1) { controller.abort(new Error("cancelled")); throw controller.signal.reason; }
    return 1;
  });
  await expect(maintainWorkflowJobs(config, plan, [], { operation: "warmup", options: {} },
    { configDirectory: ".", signal: controller.signal, env: {} })).rejects.toThrow("cancelled");
  expect(signals).toHaveLength(2); expect(signals[1]).not.toBe(controller.signal); expect(signals[1]?.aborted).toBe(false);
  expect(call.mock.calls.find(([path]) => path.endsWith("/cancel"))?.[2]).toBe(signals[1]);
});

test.each([false, true])("run cancellation collects evidence with its cleanup signal and keeps a resumable receipt: collection fails=%s", async fails => {
  const root = await mkdtemp(join(tmpdir(), "workflow-jobs-cancel-"));
  try {
    const { call, attach } = connection(), controller = new AbortController();
    let runId = "";
    call.mockImplementation(async (_path, body) => { if (body && typeof body === "object" && "requestedRunId" in body) runId = String(body.requestedRunId); return {}; });
    const signals: AbortSignal[] = [];
    attach.mockImplementation(async (_id, _log, signal) => {
      signals.push(signal); if (signals.length === 1) { controller.abort(); throw controller.signal.reason; } return 1;
    });
    vi.mocked(downloadWorkflowResults).mockImplementation(async (_client, _job, output, fingerprint, signal) => {
      expect(signal).toBe(signals[1]); expect(signal.aborted).toBe(false);
      expect(await readdir(join(root, ".jobs"))).toContain(`.${runId}.workflow.lock`);
      if (fails) throw new Error("collection unavailable");
      const record: WorkflowRunRecord = { schemaVersion: 2, runId, fingerprint, implementations: {}, startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(), status: "cancelled", businessComplete: false, outputs: {}, units: [], steps: [], resources: [], artifacts: [], errors: [] };
      return { directory: join(output, runId), record };
    });
    const result = runWorkflowJobs(config, plan, ["MODEL_KEY"], { configDirectory: root, outputDirectory: root, signal: controller.signal, env: { MODEL_KEY: "private-fixture-key" } });
    if (fails) await expect(result).rejects.toThrow("collection unavailable");
    else expect((await result).record.status).toBe("cancelled");
    expect(signals).toHaveLength(2);
    const receipt = await readFile(join(root, ".jobs", `${runId}.workflow.json`), "utf8");
    expect(JSON.parse(receipt).collected).toBe(!fails); expect(receipt).not.toContain("private-fixture-key");
    expect(await readdir(join(root, ".jobs"))).not.toContain(`.${runId}.workflow.lock`);
    expect(call.mock.calls.find(([path]) => path.endsWith("/cancel"))?.[2]).toBe(signals[1]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
