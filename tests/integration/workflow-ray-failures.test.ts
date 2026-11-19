import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { openPluginRegistry } from "../../src/application/plugins/open-registry.js";
import { compileWorkflow } from "../../src/core/workflow/compile.js";
import { executeWorkflow } from "../../src/core/workflow/execute.js";
import { parseWorkflowDocument } from "../../src/config/workflow-schema.js";
import { LocalWorkflowStore } from "../../src/plugins/stores/workflow-local.js";
import type { ProgressEvent } from "../../src/core/progress/progress.js";
import type { RayResult } from "../../src/infrastructure/ray/client.js";
import type { WorkflowRemoteJob } from "../../src/infrastructure/ray/workflow-protocol.js";

const bridge = vi.hoisted(() => ({ submit: vi.fn<(job: WorkflowRemoteJob) => Promise<Extract<RayResult, { type: "failed" }>>>(), close: vi.fn(async () => {}) }));
vi.mock("../../src/infrastructure/ray/client.js", () => ({ RayClient: class {
  nodes = ["node"]; nodeSlots = { node: 2 }; slots = 2;
  start = async () => {}; submitWorkflow = bridge.submit; close = bridge.close;
} }));
vi.mock("../../src/infrastructure/transfer/https.js", () => ({ startTransferReceiver: async () => ({ url: "https://collector.invalid", close: async () => {} }) }));
const roots: string[] = [];
afterEach(async () => { vi.clearAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

test.each([
  { code: "RAY_WORKER_LOST" as const, retired: false },
  { code: "RAY_WORKER_LOST" as const, retired: true },
  { code: "ENV_ARCH_UNSUPPORTED" as const, retired: true },
])("Ray $code retired=$retired preserves diagnostics and requires recovery", async ({ code, retired }) => {
  const root = await mkdtemp(join(tmpdir(), "workflow-ray-failure-")); roots.push(root);
  const certificate = join(root, "certificate"); await writeFile(certificate, "controlled certificate");
  const registry = await openPluginRegistry(), events: ProgressEvent[] = [];
  try {
    const plan = compileWorkflow(parseWorkflowDocument({ schemaVersion: 2, resources: {
      connection: { use: "ray.connection", scope: "run", config: {
        endpoint: "ray://fixture:10001", collector: { certFile: certificate, keyFile: certificate, tokenEnv: "FIXTURE_TRANSFER_TOKEN", publicUrl: "https://collector.invalid" },
      } }, execution: { use: "executor.ray", scope: "run", resources: { connection: "connection" } },
    }, workflow: { steps: [{ id: "samples", forEach: { items: { value: [{ id: "a" }] }, mode: "units", executor: "execution" },
      steps: [{ id: "value", use: "data.value", inputs: { value: { value: "must execute on worker" } } }],
      outputs: { value: { ref: "value.outputs.value" } } }] } }), registry.ctx.evaluator.workflows, registry.pluginVersions);
    bridge.submit.mockImplementation(async job => ({ type: "failed", attemptId: job.job.attemptId, code, retired,
      originalName: "WorkerCrashedError", network: { originalCode: "ECONNRESET", networkStage: "model-api" } }));
    const result = await executeWorkflow(plan, registry.ctx.evaluator.workflows, {
      store: new LocalWorkflowStore(root), signal: AbortSignal.timeout(10_000),
      runtime: { directory: root, resolvePath: path => resolve(root, path), async credential() { return "controlled-transfer-token"; } },
      onEvent(event) { if (event.progress) events.push(event.progress); },
    });
    expect(result.status).toBe("failed");
    expect(result.units).toMatchObject([{ caseId: "a", status: "failed", cleanupStatus: "unconfirmed" }]);
    expect(result.steps.some(step => step.plugin === "data.value")).toBe(false);
    expect(events).toContainEqual(expect.objectContaining({ taskId: "a", error: true,
      failure: expect.objectContaining({ code, details: expect.objectContaining({ originalCode: "ECONNRESET", networkStage: "model-api" }) }) }));
    expect(bridge.submit).toHaveBeenCalledOnce(); expect(bridge.close).toHaveBeenCalledOnce();
  } finally { await registry.dispose(); }
});
