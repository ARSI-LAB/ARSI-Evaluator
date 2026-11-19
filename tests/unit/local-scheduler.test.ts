import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { LocalScheduler } from "../../src/plugins/schedulers/local/scheduler.js";
import { WorkflowDefinitions } from "../../src/core/workflow/catalog.js";
import { compileWorkflow } from "../../src/core/workflow/compile.js";
import { executeWorkflow } from "../../src/core/workflow/execute.js";
import { jsonPort, workflowObject } from "../../src/core/workflow/values.js";
import { parseWorkflowDocument } from "../../src/config/workflow-schema.js";
import { LocalWorkflowStore } from "../../src/plugins/stores/workflow-local.js";
import type { WorkflowAdmission, WorkflowContext, WorkflowEvent } from "../../src/core/contracts/workflow.js";

const roots: string[] = [];
vi.setConfig({ testTimeout: 30_000 });
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function batch(count: number, concurrency: number, work: (id: number, context: WorkflowContext) => Promise<void>,
  options: { signal?: AbortSignal; admission?: WorkflowAdmission; onEvent?: (event: WorkflowEvent) => void } = {}) {
  const root = await mkdtemp(join(tmpdir(), "workflow-scheduling-")); roots.push(root);
  const catalog = new WorkflowDefinitions();
  catalog.registerStep({ type: "work", apiVersion: 1, version: "1", inputs: { id: jsonPort() }, outputs: { result: jsonPort() },
    resources: {}, effects: "pure", validateConfig: workflowObject, async execute(input, _config, context) {
      const id = Number(input.id); await work(id, context); return { result: id };
    } });
  if (options.admission) catalog.registerResource({ type: "ready", version: "1", apiVersion: 1,
    capabilities: ["workflow.admission/v1"], resources: {}, validateConfig: workflowObject,
    async create() { return { value: options.admission, identity: {} }; } });
  const plan = compileWorkflow(parseWorkflowDocument({ schemaVersion: 2, run: { onError: "stop" },
    resources: options.admission ? { ready: { use: "ready", scope: "run" } } : {}, workflow: {
      steps: [{ id: "samples", forEach: { items: { value: Array.from({ length: count }, (_, id) => ({ id: String(id) })) },
        mode: "units", concurrency, ...(options.admission ? { admission: "ready" } : {}) },
        steps: [{ id: "work", use: "work", inputs: { id: { ref: "item.id" } } }], outputs: { result: { ref: "work.outputs.result" } } }],
    } }), catalog);
  return executeWorkflow(plan, catalog, { store: new LocalWorkflowStore(root), signal: options.signal ?? new AbortController().signal,
    ...(options.onEvent ? { onEvent: options.onEvent } : {}) });
}

const cancelled = (signal: AbortSignal) => new Promise<void>(resolve => {
  if (signal.aborted) resolve(); else signal.addEventListener("abort", () => resolve(), { once: true });
});

test("50 samples refill a completed slot while the first 24 remain active", async () => {
  const gates = Array.from({ length: 50 }, () => Promise.withResolvers<void>()), started: number[] = [];
  let active = 0, maximum = 0;
  const running = batch(50, 25, async id => {
    started.push(id); maximum = Math.max(maximum, ++active); await gates[id]!.promise; active--;
  });
  try {
    await vi.waitFor(() => expect(started).toHaveLength(25), { timeout: 5_000 });
    gates[7]!.resolve();
    await vi.waitFor(() => expect(started).toHaveLength(26), { timeout: 5_000 });
    expect(active).toBe(25);
  } finally { gates.forEach(gate => gate.resolve()); }
  const result = await running;
  expect(result.status).toBe("completed"); expect(result.units).toHaveLength(50);
  expect(maximum).toBe(25); expect(active).toBe(0);
});

test("a cancelled workflow starts no samples", async () => {
  let starts = 0;
  const result = await batch(5, 2, async () => { starts++; }, { signal: AbortSignal.abort() });
  expect(result.status).toBe("cancelled"); expect(starts).toBe(0);
});

test.each([0, -1, 1.5, NaN, Infinity])("preparation scheduler rejects invalid concurrency %s", value => {
  expect(() => new LocalScheduler(value)).toThrow(/concurrency/);
});

test("cancellation stops queued samples and drains active steps", async () => {
  const controller = new AbortController(), started: number[] = [], stopped: number[] = [];
  const running = batch(5, 2, async (id, context) => { started.push(id); await cancelled(context.signal); stopped.push(id); }, { signal: controller.signal });
  await vi.waitFor(() => expect(started).toHaveLength(2)); controller.abort();
  expect((await running).status).toBe("cancelled"); expect(started).toEqual([0, 1]); expect(stopped.sort()).toEqual(started);
});

test("fatal step failure cancels peers and waits for their cleanup", async () => {
  const failure = Promise.withResolvers<void>(), started: number[] = []; let cleaned = false;
  const running = batch(5, 2, async (id, context) => {
    started.push(id);
    if (id === 0) { await failure.promise; throw new Error("store unavailable"); }
    await cancelled(context.signal); cleaned = true;
  });
  await vi.waitFor(() => expect(started).toHaveLength(2)); failure.resolve();
  const result = await running;
  expect(result.status).toBe("failed"); expect(JSON.stringify(result)).toContain("store unavailable");
  expect(cleaned).toBe(true); expect(started).toEqual([0, 1]);
});

test("finished samples are persisted while admission waits for the next ready sample", async () => {
  const release = Promise.withResolvers<void>(), completed: string[] = [];
  const running = batch(2, 2, async () => {}, { admission: {
    async *order(units) { yield units[0]!; await release.promise; yield units[1]!; },
  }, onEvent(event) { if (event.status === "completed") completed.push(event.path); } });
  try { await vi.waitFor(() => expect(completed.some(path => path.includes("work"))).toBe(true)); }
  finally { release.resolve(); }
  expect((await running).status).toBe("completed");
});

test("readiness failure cancels active steps and closes its input iterator", async () => {
  let cleaned = false, closed = false;
  const started = Promise.withResolvers<void>();
  const result = await batch(3, 2, async (_id, context) => { started.resolve(); await cancelled(context.signal); cleaned = true; }, {
    admission: { async *order(units) { try { yield units[0]!; await started.promise; throw new Error("prepare failed"); } finally { closed = true; } } },
  });
  expect(result.status).toBe("failed"); expect(JSON.stringify(result)).toContain("prepare failed");
  expect(cleaned).toBe(true); expect(closed).toBe(true); expect(result.units).toHaveLength(1);
});
