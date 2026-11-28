import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, test } from "vitest";
import { WorkflowDefinitions } from "../../src/core/workflow/catalog.js";
import { compileWorkflow } from "../../src/core/workflow/compile.js";
import { executeWorkflow } from "../../src/core/workflow/execute.js";
import { jsonPort, workflowObject } from "../../src/core/workflow/values.js";
import { parseWorkflowDocument } from "../../src/config/workflow-schema.js";
import { LocalWorkflowStore } from "../../src/plugins/stores/workflow-local.js";
import type { StepDefinition, WorkflowRunRecord } from "../../src/core/contracts/workflow.js";
import type { WorkflowEvent } from "../../src/core/contracts/workflow.js";
import { classifyError } from "../../src/core/errors/classify.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function store() { const path = await mkdtemp(join(tmpdir(), "arsi-workflow-")); roots.push(path); return new LocalWorkflowStore(path); }
function step(type: string, execute: StepDefinition["execute"], resources: StepDefinition["resources"] = {}): StepDefinition {
  return { type, apiVersion: 1, version: "1", inputs: { input: jsonPort() }, outputs: { result: jsonPort() },
    resources, effects: "pure", validateConfig: workflowObject, execute };
}
const identity = { id: "copy", use: "copy", inputs: { input: { ref: "inputs.value" } } };
const document = (steps: unknown[], extra = {}) => parseWorkflowDocument({ schemaVersion: 2, inputs: { value: "hello" },
  workflow: { steps, outputs: { result: { ref: "copy.outputs.result" } } }, ...extra });

test("plugin progress preserves structured errors and live output while redacting credentials and leaving results unchanged", async () => {
  const definitions = new WorkflowDefinitions(), events: WorkflowEvent[] = [], secret = "fixture-secret-for-progress";
  definitions.registerStep(step("copy", async (inputs, _config, context) => {
    context.log("live output", { phase: "solve", message: `preview ${secret}`, taskId: "task", transient: true,
      live: { id: "tool", sequence: 1, status: "updated", elapsedMs: 1, idleMs: 0, lines: [`tool ${secret}`] } });
    context.log(`failure ${secret}`, { phase: "solve", message: `failure ${secret}`, error: true,
      failure: classifyError(new Error(`problem ${secret}`, { cause: new Error(`cause ${secret}`) }), { phase: "solve" }) });
    return { result: inputs.input ?? null };
  }));
  const storage = await store();
  const record = await executeWorkflow(compileWorkflow(document([identity]), definitions), definitions, {
    store: storage, signal: new AbortController().signal, secrets: [secret], onEvent: event => events.push(event),
  });
  expect(record.status).toBe("completed");
  expect(events.some(event => event.progress?.live?.lines[0] === "tool [redacted]")).toBe(true);
  expect(events.some(event => event.progress?.failure?.causes[0]?.message === "cause [redacted]")).toBe(true);
  expect(JSON.stringify(events)).not.toContain(secret);
  expect(JSON.stringify(await storage.read())).not.toContain("preview");
});

test.each([false, true])("worker clients are reused, attempt state is isolated, and all owners close (failure=%s)", async failing => {
  const definitions = new WorkflowDefinitions();
  const created: string[] = [], closed: string[] = [];
  const observations: { worker: string; client: unknown; memory: unknown }[] = [];
  definitions.registerResource({ type: "client", version: "1", apiVersion: 1, sharing: "shared", capabilities: ["client"], resources: {},
    validateConfig: workflowObject, async create(_config, context) {
      created.push(context.workerId);
      return { value: {}, identity: { worker: context.workerId }, async dispose() { closed.push(context.workerId); } };
    } });
  definitions.registerResource({ type: "memory", version: "1", apiVersion: 1, capabilities: ["memory"], resources: {},
    validateConfig: workflowObject, async create() { return { value: new Map(), identity: {} }; } });
  definitions.registerStep(step("copy", async (inputs, _config, context) => {
    observations.push({ worker: context.workerId, client: context.resource("client"), memory: context.resource("memory") });
    if (failing && inputs.input === "b") throw new Error("sample failure");
    return { result: inputs.input ?? null };
  }, { client: { capability: "client" }, memory: { capability: "memory" } }));
  const plan = compileWorkflow(parseWorkflowDocument({ schemaVersion: 2, run: { onError: "continue" },
    resources: { client: { use: "client", scope: "worker" }, memory: { use: "memory", scope: "attempt" } },
    workflow: { steps: [{ id: "samples", forEach: { items: { value: ["a", "b", "c", "d", "e", "f"].map(id => ({ id })) }, mode: "units", concurrency: 2 },
      steps: [{ ...identity, inputs: { input: { ref: "item.id" } }, resources: { client: "client", memory: "memory" } }],
      outputs: { result: { ref: "copy.outputs.result" } } }], outputs: { result: { ref: "samples.outputs.results" } } } }), definitions);
  const result = await executeWorkflow(plan, definitions, { store: await store(), signal: new AbortController().signal });
  expect(result.status).toBe(failing ? "failed" : "completed");
  expect(created).toHaveLength(2);
  expect(closed.sort()).toEqual(created.sort());
  expect(new Set(observations.map(row => row.memory)).size).toBe(6);
  expect(new Set(observations.map(row => row.client)).size).toBe(2);
  for (const worker of created) expect(new Set(observations.filter(row => row.worker === worker).map(row => row.client)).size).toBe(1);
  expect(result.resources.every(resource => resource.state === "released")).toBe(true);
});

test("worker resource declarations cannot capture a sample or outlive their dependencies", () => {
  const definitions = new WorkflowDefinitions();
  definitions.registerResource({ type: "client", version: "1", apiVersion: 1, sharing: "shared", capabilities: ["client"], resources: {},
    validateConfig: workflowObject, async create() { return { value: {}, identity: {} }; } });
  definitions.registerResource({ type: "outer", version: "1", apiVersion: 1, capabilities: ["client"],
    resources: { client: { capability: "client" } }, validateConfig: workflowObject, async create() { return { value: {}, identity: {} }; } });
  definitions.registerStep(step("copy", async inputs => ({ result: inputs.input ?? null }), { client: { capability: "client" } }));
  const sample = { id: "samples", forEach: { items: { value: [{ id: "a" }] }, mode: "units" },
    steps: [{ ...identity, inputs: { input: { value: "x" } }, resources: { client: "client" } }], outputs: { result: { ref: "copy.outputs.result" } } };
  const dynamic = parseWorkflowDocument({ schemaVersion: 2, resources: { client: { use: "client", scope: "worker", config: { sample: { ref: "item.id" } } } },
    workflow: { steps: [sample], outputs: { result: { ref: "samples.outputs.results" } } } });
  expect(() => compileWorkflow(dynamic, definitions)).toThrow("cannot vary between iterations");
  expect(() => compileWorkflow(document([{ ...identity, resources: { client: "outer" } }], {
    resources: { client: { use: "client", scope: "worker" }, outer: { use: "outer", scope: "run", resources: { client: "client" } } },
  }), definitions)).toThrow("cannot outlive dependency");
});

test("resume does not repeat a non-idempotent external write after a later failure", async () => {
  const definitions = new WorkflowDefinitions();
  let writes = 0;
  definitions.registerStep({ ...step("copy", async () => { writes++; return { result: "sent" }; }), effects: "external-write" });
  definitions.registerStep(step("fail", async () => { throw new Error("Later failure"); }));
  const plan = compileWorkflow(document([identity], { workflow: { steps: [identity,
    { id: "failed", use: "fail", inputs: { input: { ref: "copy.outputs.result" } } }],
    outputs: { result: { ref: "failed.outputs.result" } } } }), definitions);
  const storage = await store(), signal = new AbortController().signal;
  const first = await executeWorkflow(plan, definitions, { store: storage, signal });
  const resumed = await executeWorkflow(plan, definitions, { store: storage, signal, previous: first });
  expect(writes).toBe(1);
  expect(resumed.status).toBe("failed");
  expect(resumed.errors.at(-1)?.message).toContain("external write");
});

test("a failed question prevents a sequential session from being marked complete", async () => {
  const definitions = new WorkflowDefinitions();
  definitions.registerStep(step("copy", async () => { throw new Error("Question failed"); }));
  const plan = compileWorkflow(document([], { workflow: { steps: [{ id: "questions", forEach: { items: { value: [1, 2] } },
    steps: [identity], outputs: { result: { ref: "copy.outputs.result" } } }], outputs: { results: { ref: "questions.outputs.results" } } } }), definitions);
  const record = await executeWorkflow(plan, definitions, { store: await store(), signal: new AbortController().signal });
  expect(record.status).toBe("failed");
  expect(record.businessComplete).toBe(false);
  expect(record.steps[0]?.outputs.results).toEqual(expect.arrayContaining([expect.objectContaining({ status: "failed" })]));
});

test("executes explicit inputs and validates a round trip through the local store", async () => {
  const definitions = new WorkflowDefinitions();
  definitions.registerStep(step("copy", async inputs => ({ result: inputs.input ?? null })));
  const storage = await store();
  const result = await executeWorkflow(compileWorkflow(document([identity]), definitions), definitions, { store: storage, signal: new AbortController().signal });
  expect(result.status).toBe("completed");
  expect(result.outputs).toEqual({ result: "hello" });
  expect(await storage.read()).toEqual(result);
});

test("rejects removed producers and private-to-public bindings before execution", () => {
  const definitions = new WorkflowDefinitions();
  definitions.registerStep(step("copy", async inputs => ({ result: inputs.input ?? null })));
  expect(() => compileWorkflow(document([{ ...identity, inputs: { input: { ref: "deleted.outputs.result" } } }]), definitions)).toThrow("deleted.outputs.result");
  expect(() => compileWorkflow(document([identity], { inputProtocols: { value: { protocol: "arsi.json/v1", visibility: "private" } } }), definitions)).toThrow("private");
});

test("rejects cross-sample mutable resources and unrelated conditional consumers", () => {
  const definitions = new WorkflowDefinitions();
  definitions.registerResource({ type: "memory", apiVersion: 1, version: "1", capabilities: ["memory"], resources: {}, validateConfig: workflowObject,
    async create() { return { value: new Map(), identity: {} }; } });
  definitions.registerStep(step("copy", async inputs => ({ result: inputs.input ?? null }), { memory: { capability: "memory" } }));
  const mutable = parseWorkflowDocument({ schemaVersion: 2, resources: { memory: { use: "memory", scope: "run" } }, workflow: {
    steps: [{ id: "samples", forEach: { items: { value: [{ id: "a" }] }, mode: "units" },
      steps: [{ ...identity, inputs: { input: { value: 1 } }, resources: { memory: "memory" } }], outputs: { result: { ref: "copy.outputs.result" } } }],
    outputs: { result: { ref: "samples.outputs.results" } } } });
  expect(() => compileWorkflow(mutable, definitions)).toThrow("safe sharing");
  const pure = new WorkflowDefinitions();
  pure.registerStep(step("copy", async inputs => ({ result: inputs.input ?? null })));
  expect(() => compileWorkflow(document([
    { ...identity, when: { value: false } },
    { ...identity, id: "consume", when: { value: true }, inputs: { input: { ref: "copy.outputs.result" } } },
  ]), pure)).toThrow("skipped or failed producer");
});

test("nested sequential sessions retain the enclosing model and repetition", async () => {
  const definitions = new WorkflowDefinitions();
  const observed: unknown[] = [];
  definitions.registerStep(step("copy", async inputs => { observed.push(inputs.input); return { result: inputs.input ?? null }; }));
  const plan = compileWorkflow(parseWorkflowDocument({ schemaVersion: 2, workflow: {
    steps: [{ id: "samples", forEach: { items: { value: [{ id: "a" }] }, mode: "units", as: "sample",
      matrix: { variants: [{ id: "model-a" }, { id: "model-b" }], repetitions: 2 } },
      steps: [{ id: "sessions", forEach: { items: { value: [1, 2] }, as: "session" },
        steps: [{ ...identity, inputs: { input: { ref: "variant.id" } } },
          { ...identity, id: "repeat", inputs: { input: { ref: "repetition" } } }], outputs: { result: { ref: "copy.outputs.result" } } }],
      outputs: { result: { ref: "sessions.outputs.results" } } }], outputs: { result: { ref: "samples.outputs.results" } } } }), definitions);
  expect((await executeWorkflow(plan, definitions, { store: await store(), signal: new AbortController().signal })).status).toBe("completed");
  expect(observed).toEqual(["model-a", 0, "model-a", 0, "model-a", 1, "model-a", 1, "model-b", 0, "model-b", 0, "model-b", 1, "model-b", 1]);
});

test("creates a dynamically configured resource once and releases it after consumers", async () => {
  const definitions = new WorkflowDefinitions();
  const events: string[] = [];
  definitions.registerResource({ type: "memory", version: "1", apiVersion: 1, capabilities: ["memory"], resources: {},
    validateConfig: workflowObject, async create(config) {
      events.push(`create:${config.namespace}`);
      return { value: { namespace: config.namespace }, identity: { id: "memory" }, async dispose() { events.push("dispose"); } };
    } });
  definitions.registerStep(step("copy", async (inputs, _config, context) => {
    events.push(`use:${workflowObject(context.resource("memory")).namespace}`);
    return { result: inputs.input ?? null };
  }, { memory: { capability: "memory" } }));
  const plan = compileWorkflow(document([
    { ...identity, resources: { memory: "memory" } },
    { ...identity, id: "second", resources: { memory: "memory" } },
  ], { resources: { memory: { use: "memory", scope: "run", config: { namespace: { ref: "inputs.value" } } } } }), definitions);
  expect((await executeWorkflow(plan, definitions, { store: await store(), signal: new AbortController().signal })).status).toBe("completed");
  expect(events).toEqual(["create:hello", "use:hello", "use:hello", "dispose"]);
});

test("resumes failed units from scratch but skips completed units", async () => {
  const definitions = new WorkflowDefinitions();
  const calls: string[] = [];
  let fail = true;
  definitions.registerStep(step("copy", async inputs => {
    const input = workflowObject(inputs.input);
    calls.push(String(input.id));
    if (input.id === "b" && fail) throw new Error("transient failure");
    return { result: input.id ?? null };
  }));
  const plan = compileWorkflow(parseWorkflowDocument({ schemaVersion: 2,
    inputs: { cases: [{ id: "a" }, { id: "b" }] }, run: { onError: "continue" },
    workflow: { steps: [{ id: "evaluate", forEach: { items: { ref: "inputs.cases" }, as: "item", mode: "units", concurrency: 2 },
      steps: [{ ...identity, inputs: { input: { ref: "item" } } }], outputs: { result: { ref: "copy.outputs.result" } } }],
    outputs: { results: { ref: "evaluate.outputs.results" } } } }), definitions);
  const storage = await store();
  const first = await executeWorkflow(plan, definitions, { store: storage, signal: new AbortController().signal });
  expect(first.status).toBe("failed");
  fail = false;
  const second = await executeWorkflow(plan, definitions, { store: storage, previous: first, signal: new AbortController().signal });
  expect(second.status).toBe("completed");
  expect(calls.filter(id => id === "a")).toHaveLength(1);
  expect(calls.filter(id => id === "b")).toHaveLength(2);
  expect(second.units.map(unit => unit.ordinal).sort()).toEqual([1, 1, 2]);
});

test("preserves produced artifacts when a downstream step fails", async () => {
  const definitions = new WorkflowDefinitions();
  definitions.registerStep(step("copy", async (_input, _config, context) => {
    const artifact = await context.artifacts.write("answer.txt", "partial evidence", { mediaType: "text/plain", protocol: "arsi.text/v1" });
    return { result: workflowObject(artifact) };
  }));
  definitions.registerStep(step("fail", async () => { throw new Error("grader failed"); }));
  const storage = await store();
  const result = await executeWorkflow(compileWorkflow(document([identity,
    { id: "grade", use: "fail", inputs: { input: { ref: "copy.outputs.result" } } }],
  { workflow: { steps: [identity, { id: "grade", use: "fail", inputs: { input: { ref: "copy.outputs.result" } } }],
    outputs: { score: { ref: "grade.outputs.result" } } } }), definitions), definitions, { store: storage, signal: new AbortController().signal });
  expect(result.status).toBe("failed");
  expect(result.artifacts).toHaveLength(1);
  const artifact = result.artifacts[0];
  if (!artifact) throw new Error("Missing artifact");
  expect(Buffer.from(await storage.artifacts("test").read(artifact)).toString()).toBe("partial evidence");
});

test("cancelled evaluations still persist evidence produced during resource cleanup", async () => {
  const definitions = new WorkflowDefinitions(), cancel = new AbortController();
  definitions.registerResource({ type: "cleanup-evidence", apiVersion: 1, version: "1", capabilities: ["session"], resources: {},
    validateConfig: workflowObject, async create(_config, context) {
      return { value: {}, identity: {}, async dispose() {
        await context.artifacts.write("cleanup.txt", "cancelled work was collected", { mediaType: "text/plain", protocol: "arsi.text/v1" });
      } };
    } });
  definitions.registerStep(step("copy", async () => { cancel.abort(); return { result: "not committed" }; }, { session: { capability: "session" } }));
  const plan = compileWorkflow(document([{ ...identity, resources: { session: "session" } }],
    { resources: { session: { use: "cleanup-evidence", scope: "attempt" } } }), definitions);
  const storage = await store();
  const record = await executeWorkflow(plan, definitions, { store: storage, signal: cancel.signal });
  expect(record.status).toBe("cancelled");
  expect(record.outputs).toEqual({});
  expect(record.resources[0]?.state).toBe("released");
  expect(record.artifacts).toHaveLength(1);
  expect(await storage.read()).toEqual(record);
});

test("whole-plan snapshots never publish class instances as outputs", async () => {
  const definitions = new WorkflowDefinitions();
  definitions.registerStep(step("copy", async () => ({ result: new Date() as unknown as string })));
  const result: WorkflowRunRecord = await executeWorkflow(compileWorkflow(document([identity]), definitions), definitions,
    { store: await store(), signal: new AbortController().signal });
  expect(result.status).toBe("failed");
  expect(result.steps[0]?.errors[0]?.message).toContain("live object");
});

test("step timeout does not cancel a later independent grader", async () => {
  const definitions = new WorkflowDefinitions();
  definitions.registerStep(step("slow", async (_inputs, _config, context) => {
    await new Promise<void>(resolve => context.signal.addEventListener("abort", () => resolve(), { once: true }));
    context.signal.throwIfAborted();
    return { result: "unreachable" };
  }));
  definitions.registerStep(step("copy", async inputs => ({ result: inputs.input ?? null })));
  const plan = compileWorkflow(document([
    { ...identity, id: "slow", use: "slow", timeoutSeconds: 0.02, onError: "continue" }, identity,
  ]), definitions);
  const result = await executeWorkflow(plan, definitions, { store: await store(), signal: new AbortController().signal });
  expect(result.businessComplete).toBe(true);
  expect(result.steps.map(step => step.status)).toEqual(["failed", "completed"]);
});

test("resuming a valid result with failed cleanup only recovers resources", async () => {
  const definitions = new WorkflowDefinitions();
  let invoked = 0, recovered = 0;
  definitions.registerResource({ type: "session", apiVersion: 1, version: "1", capabilities: ["session"], resources: {}, validateConfig: workflowObject,
    async create() { return { identity: { id: "session" }, value: {}, async dispose() { throw new Error("cleanup failed"); } }; },
    async recover() { recovered++; },
  });
  definitions.registerStep(step("copy", async inputs => { invoked++; return { result: inputs.input ?? null }; }, { session: { capability: "session" } }));
  const plan = compileWorkflow(document([{ ...identity, resources: { session: "session" } }],
    { resources: { session: { use: "session", scope: "attempt" } } }), definitions);
  const storage = await store();
  const first = await executeWorkflow(plan, definitions, { store: storage, signal: new AbortController().signal });
  expect(first.status).toBe("failed");
  expect(first.businessComplete).toBe(true);
  const second = await executeWorkflow(plan, definitions, { store: storage, signal: new AbortController().signal, previous: first });
  expect(second.status).toBe("completed");
  expect(invoked).toBe(1);
  expect(recovered).toBe(1);
});

test("a late resource is disposed without rewriting the closed run or its returned snapshot", async () => {
  const definitions = new WorkflowDefinitions();
  const release = Promise.withResolvers<void>();
  const disposed = Promise.withResolvers<void>();
  const cancel = new AbortController();
  definitions.registerResource({ type: "late", apiVersion: 1, version: "1", capabilities: ["session"], resources: {}, validateConfig: workflowObject,
    async create() { cancel.abort(new Error("cancel opening")); await release.promise;
      return { identity: { id: "late" }, value: {}, async dispose() { disposed.resolve(); } }; },
  });
  definitions.registerStep(step("copy", async inputs => ({ result: inputs.input ?? null }), { session: { capability: "session" } }));
  const plan = compileWorkflow(document([{ ...identity, resources: { session: "late" } }],
    { resources: { late: { use: "late", scope: "attempt" } } }), definitions);
  const storage = await store();
  const snapshots: WorkflowRunRecord[] = [];
  const result = await executeWorkflow(plan, definitions, { store: {
    artifacts: producer => storage.artifacts(producer),
    async save(record) { snapshots.push(structuredClone(record)); await storage.save(record); },
  }, signal: cancel.signal });
  expect(result.status).toBe("cancelled");
  expect(result.resources[0]?.state).toBe("unconfirmed");
  const committed = structuredClone(result), writes = snapshots.length;
  release.resolve();
  await disposed.promise;
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(result).toEqual(committed);
  expect(snapshots).toHaveLength(writes);
  expect(await storage.read()).toEqual(committed);
});

test("sequential iterations share attempt memory while independent units do not", async () => {
  const definitions = new WorkflowDefinitions();
  const counts: number[] = [];
  let creations = 0;
  definitions.registerResource({ type: "counter", apiVersion: 1, version: "1", capabilities: ["counter"], resources: {}, validateConfig: workflowObject,
    async create() { creations++; return { identity: {}, value: { count: 0 }, async dispose() {} }; },
  });
  definitions.registerStep(step("increment", async (_inputs, _config, context) => {
    const value = context.resource("counter");
    if (!value || typeof value !== "object" || !("count" in value) || typeof value.count !== "number") throw new Error("Bad counter");
    value.count++;
    counts.push(value.count);
    return { result: value.count };
  }, { counter: { capability: "counter" } }));
  const plan = compileWorkflow(parseWorkflowDocument({ schemaVersion: 2,
    inputs: { cases: [{ id: "a" }, { id: "b" }] },
    resources: { counter: { use: "counter", scope: "attempt" } },
    workflow: { steps: [{ id: "cases", forEach: { items: { ref: "inputs.cases" }, mode: "units" },
      steps: [{ id: "turns", forEach: { items: { value: [1, 2] }, as: "turn" },
        steps: [{ id: "increment", use: "increment", inputs: { input: { ref: "turn" } }, resources: { counter: "counter" } }],
        outputs: { result: { ref: "increment.outputs.result" } } }],
      outputs: { result: { ref: "turns.outputs.results" } } }],
      outputs: { results: { ref: "cases.outputs.results" } } } }), definitions);
  expect((await executeWorkflow(plan, definitions, { store: await store(), signal: new AbortController().signal })).status).toBe("completed");
  expect(creations).toBe(2);
  expect(counts).toEqual([1, 2, 1, 2]);
});


test.each(["reverse", "duplicate", "missing"])("readiness admission validates %s order and does not prefetch past the execution slot", async mode => {
  const definitions = new WorkflowDefinitions(), events: string[] = [];
  definitions.registerResource({ type: "ready", version: "1", apiVersion: 1, capabilities: ["workflow.admission/v1"],
    resources: {}, validateConfig: workflowObject, async create() {
      return { identity: {}, value: { async *order(units: import("../../src/core/contracts/workflow.js").ExecutionUnitIdentity[]) {
        try {
          for (const unit of mode === "duplicate" ? [units[1]!, units[1]!] : mode === "missing" ? [units[1]!] : [...units].reverse()) {
            events.push(`admit:${unit.caseId}`); yield unit;
          }
        } finally { events.push("closed"); }
      } } };
    } });
  definitions.registerStep(step("copy", async inputs => { events.push(`execute:${String(inputs.input)}`); return { result: inputs.input ?? null }; }));
  const plan = compileWorkflow(parseWorkflowDocument({ schemaVersion: 2, resources: { ready: { use: "ready", scope: "run" } }, workflow: {
    steps: [{ id: "samples", forEach: { items: { value: [{ id: "a" }, { id: "b" }] }, mode: "units", as: "sample", admission: "ready" },
      steps: [{ ...identity, inputs: { input: { ref: "sample.id" } } }], outputs: { result: { ref: "copy.outputs.result" } } }],
    outputs: { result: { ref: "samples.outputs.results" } } } }), definitions);
  const result = await executeWorkflow(plan, definitions, { store: await store(), signal: new AbortController().signal });
  expect(events.slice(0, 2)).toEqual(["admit:b", "execute:b"]);
  expect(events).toContain("closed");
  expect(result.status).toBe(mode === "reverse" ? "completed" : "failed");
  expect(result.units.map(unit => unit.caseId)).toEqual(mode === "reverse" ? ["b", "a"] : ["b"]);
});


test("cancellation bounds cleanup when a readiness provider ignores its signal", async () => {
  const definitions = new WorkflowDefinitions(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  definitions.registerResource({ type: "blocked-ready", version: "1", apiVersion: 1, capabilities: ["workflow.admission/v1"],
    resources: {}, validateConfig: workflowObject, async create() {
      return { identity: {}, value: { async *order() { entered.resolve(); await release.promise; } } };
    } });
  definitions.registerStep(step("copy", async inputs => ({ result: inputs.input ?? null })));
  const plan = compileWorkflow(parseWorkflowDocument({ schemaVersion: 2, run: { cleanupTimeoutSeconds: 0.05 },
    resources: { ready: { use: "blocked-ready", scope: "run" } }, workflow: {
      steps: [{ id: "samples", forEach: { items: { value: [{ id: "a" }] }, mode: "units", admission: "ready" },
        steps: [identity], outputs: { result: { ref: "copy.outputs.result" } } }], outputs: { result: { ref: "samples.outputs.results" } } },
    inputs: { value: 1 } }), definitions);
  const cancellation = new AbortController();
  const running = executeWorkflow(plan, definitions, { store: await store(), signal: cancellation.signal });
  try {
    await entered.promise;
    cancellation.abort(new DOMException("Stopped", "AbortError"));
    const record = await running;
    expect(record.status).toBe("cancelled");
    expect(record.units).toHaveLength(0);
    expect(record.steps[0]?.errors).toMatchObject([{ code: "WORKFLOW_TIMEOUT" }]);
  } finally { release.resolve(); await running; }
});


test.each([false, true])("business inputs govern reuse while preparation receipts change (source changed: %s)", async changed => {
  const definitions = new WorkflowDefinitions();
  let fail = true, receipt = 0, source = "original";
  const calls: string[] = [];
  definitions.registerResource({ type: "admission", apiVersion: 1, version: "1", capabilities: ["workflow.admission/v1"], resources: {},
    validateConfig: workflowObject, async create() { return { identity: {}, value: {
      async *order(units: readonly import("../../src/core/contracts/workflow.js").ExecutionUnitIdentity[]) { yield* units; },
      async reuseInputs() { return { source }; },
    } }; }, async recover() {},
  });
  definitions.registerStep(step("prepare", async () => ({ result: ++receipt })));
  definitions.registerStep(step("copy", async inputs => {
    const item = workflowObject(inputs.input);
    calls.push(String(item.id));
    if (item.id === "b" && fail) throw new Error("transient failure");
    return { result: item.id ?? null };
  }));
  const plan = compileWorkflow(parseWorkflowDocument({ schemaVersion: 2, run: { onError: "continue" },
    resources: { admission: { use: "admission", scope: "run" } }, workflow: { steps: [
      { id: "prepare", use: "prepare", inputs: { input: { value: null } } },
      { id: "evaluate", forEach: { items: { value: [{ id: "a" }, { id: "b" }] }, mode: "units", admission: "admission" },
        steps: [{ ...identity, inputs: { input: { ref: "item" } } }], outputs: { result: { ref: "copy.outputs.result" } } },
    ], outputs: { results: { ref: "evaluate.outputs.results" } } } }), definitions);
  const storage = await store();
  const first = await executeWorkflow(plan, definitions, { store: storage, signal: new AbortController().signal });
  expect(first.status).toBe("failed");
  fail = false;
  if (changed) source = "changed";
  const second = await executeWorkflow(plan, definitions, { store: storage, previous: first, signal: new AbortController().signal });
  expect(second.status, JSON.stringify(second.errors)).toBe("completed");
  expect(receipt).toBe(2);
  expect(calls.filter(id => id === "a")).toHaveLength(changed ? 2 : 1);
  expect(calls.filter(id => id === "b")).toHaveLength(2);
});


test("a background prerequisite failure cancels occupied slots, stops admission and closes resources", async () => {
  const definitions = new WorkflowDefinitions(), failure = new AbortController(), entered = Promise.withResolvers<void>();
  let started = 0, drained = 0, disposed = 0;
  definitions.registerResource({ type: "prerequisite", apiVersion: 1, version: "1", capabilities: ["workflow.admission/v1"],
    resources: {}, validateConfig: workflowObject, async create() {
      return { identity: {}, value: { failureSignal: failure.signal, async *order(units: unknown[]) { yield* units; } },
        async dispose() { disposed++; } };
    },
  });
  definitions.registerStep(step("blocked", async (_inputs, _config, context) => {
    started++; if (started === 2) entered.resolve();
    try {
      await new Promise<never>((_resolve, reject) => {
        const abort = () => reject(context.signal.reason);
        if (context.signal.aborted) abort(); else context.signal.addEventListener("abort", abort, { once: true });
      });
      return { result: null };
    } finally { drained++; }
  }));
  const plan = compileWorkflow(parseWorkflowDocument({ schemaVersion: 2,
    resources: { prerequisite: { use: "prerequisite", scope: "run" } }, workflow: { steps: [{ id: "samples",
      forEach: { items: { value: [{ id: "a" }, { id: "b" }, { id: "c" }] }, mode: "units", concurrency: 2, admission: "prerequisite" },
      steps: [{ id: "blocked", use: "blocked", inputs: { input: { ref: "item.id" } } }], outputs: { result: { ref: "blocked.outputs.result" } },
    }] } }), definitions);
  const storage = await store();
  const running = executeWorkflow(plan, definitions, { store: storage, signal: AbortSignal.timeout(5000) });
  await entered.promise;
  failure.abort(new Error("background preparation failed"));
  const result = await running;
  expect(result.status).toBe("failed");
  expect(result.steps.find(row => row.path === "workflow.samples")?.errors[0]?.message).toContain("background preparation failed");
  expect(started).toBe(2); expect(drained).toBe(2); expect(disposed).toBe(1);
  expect(result.units.every(unit => unit.status === "cancelled")).toBe(true);
});


test.each(["valid", "changed-input", "missing-output", "damaged-evidence"])("reconciles committed results after cleanup: %s", async scenario => {
  const definitions = new WorkflowDefinitions();
  let executed = 0, recovered = false, source = "original";
  definitions.registerResource({ type: "reconcile", apiVersion: 1, version: "1", capabilities: ["workflow.admission/v1"], resources: {},
    validateConfig: workflowObject, async create() { return { identity: {}, value: {
      async *order(units: unknown[]) { yield* units; }, async reuseInputs() { return { source }; },
      async reconcile() {
        expect(recovered).toBe(true);
        if (scenario === "damaged-evidence") throw new Error("Evidence digest differs");
        return scenario === "missing-output" ? {} : { result: "committed" };
      },
    } }; },
  });
  definitions.registerResource({ type: "owned", apiVersion: 1, version: "1", capabilities: ["owned/v1"], resources: {},
    validateConfig: workflowObject, async create() { return { identity: {}, value: {}, async dispose() {
      if (!recovered) throw new Error("cleanup interrupted");
    } }; }, async recover() { recovered = true; },
  });
  definitions.registerStep({ ...step("commit", async () => {
    executed++;
    if (executed === 1) throw new Error("Result committed before acknowledgment was saved");
    return { result: "executed" };
  }), resources: { owned: { capability: "owned/v1" } } });
  const plan = compileWorkflow(parseWorkflowDocument({ schemaVersion: 2,
    resources: { admission: { use: "reconcile", scope: "run" } }, workflow: { steps: [{ id: "samples",
      forEach: { items: { value: [{ id: "a" }] }, mode: "units", admission: "admission" },
      resources: { owned: { use: "owned", scope: "attempt" } },
      steps: [{ id: "commit", use: "commit", inputs: { input: { value: null } }, resources: { owned: "owned" } }],
      outputs: { result: { ref: "commit.outputs.result" } }, required: ["result"],
    }] } }), definitions);
  const storage = await store();
  const first = await executeWorkflow(plan, definitions, { store: storage, signal: new AbortController().signal });
  expect(first.units[0]).toMatchObject({ status: "failed", cleanupStatus: "unconfirmed" });
  if (scenario === "changed-input") source = "changed";
  const resumed = await executeWorkflow(plan, definitions, { store: storage, previous: first, signal: new AbortController().signal });
  expect(executed).toBe(scenario === "changed-input" ? 2 : 1);
  expect(resumed.units).toHaveLength(scenario === "changed-input" ? 2 : 1);
  if (scenario === "valid") {
    expect(resumed.status).toBe("completed");
    expect(resumed.units[0]).toMatchObject({ attemptId: first.units[0]?.attemptId, status: "completed", outputs: { result: "committed" } });
    expect(resumed.units[0]?.errors.length).toBeGreaterThan(0);
  } else expect(resumed.status).toBe(scenario === "changed-input" ? "completed" : "failed");
});
