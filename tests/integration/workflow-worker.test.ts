import { workflowDispatchFingerprint } from "../../src/core/workflow/unit-request.js";
import { workflowCredentialNames, workflowPlanCredentialNames } from "../../src/core/workflow/credentials.js";
import { WorkflowTransferSession } from "../../src/infrastructure/ray/workflow-transfer.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import type { ExecutionUnitIdentity, WorkflowUnitExecutor, WorkflowUnitRequest } from "../../src/core/contracts/workflow.js";
import { WorkflowDefinitions } from "../../src/core/workflow/catalog.js";
import { compileWorkflow } from "../../src/core/workflow/compile.js";
import { executeWorkflow, executeWorkflowUnit } from "../../src/core/workflow/execute.js";
import { jsonPort, workflowDigest, workflowObject } from "../../src/core/workflow/values.js";
import { parseWorkflowDocument } from "../../src/config/workflow-schema.js";
import { LocalWorkflowStore } from "../../src/plugins/stores/workflow-local.js";
import type { ProgressEvent } from "../../src/core/progress/progress.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function storage() {
  const root = await mkdtemp(join(tmpdir(), "ember-worker-")); roots.push(root);
  return new LocalWorkflowStore(root);
}
function fixture(scope = "worker", failCleanup = false) {
  const catalog = new WorkflowDefinitions();
  let setupCalls = 0, allocations = 0, releases = 0;
  catalog.registerResource({ type: "client", apiVersion: 1, version: "1", sharing: "shared", capabilities: ["client"], resources: {},
    validateConfig: workflowObject, async create(_config, context) {
      allocations++;
      await context.checkpoint({ host: context.workerId });
      return { value: context.workerId, identity: { host: context.workerId }, async dispose() {
        releases++; if (failCleanup) throw new Error("cannot confirm remote cleanup");
      } };
    } });
  catalog.registerStep({ type: "setup", apiVersion: 1, version: "1", effects: "pure", inputs: {}, outputs: { result: jsonPort() },
    resources: {}, validateConfig: workflowObject, async execute() { setupCalls++; return { result: "setup" }; } });
  catalog.registerStep({ type: "sample", apiVersion: 1, version: "1", effects: "pure", inputs: { item: jsonPort() },
    outputs: { result: jsonPort() }, resources: { client: { capability: "client" } }, validateConfig: workflowObject,
    async execute(inputs, _config, context) {
      const artifact = await context.artifacts.write("response.txt", JSON.stringify(inputs.item), { mediaType: "text/plain", protocol: "arsi.text/v1" });
      return { result: { artifact: workflowObject(artifact), worker: String(context.resource("client")), attemptId: context.attemptId } };
    } });
  const plan = compileWorkflow(parseWorkflowDocument({ schemaVersion: 2, resources: { client: { use: "client", scope } },
    workflow: { steps: [{ id: "setup", use: "setup" }, { id: "samples", forEach: {
      items: { value: [{ id: "a" }, { id: "b" }] }, mode: "units" },
      steps: [{ id: "answer", use: "sample", inputs: { item: { ref: "item" } }, resources: { client: "client" } }],
      outputs: { result: { ref: "answer.outputs.result" } } }], outputs: { result: { ref: "samples.outputs.results" } } } }), catalog);
  const identity = { caseId: "b", variantId: "default", repetition: 0 };
  const item = { id: "b" }, variant = { id: "default" }, bindings = { "setup.outputs.result": "setup" };
  const digest = workflowDigest(identity);
  const request: WorkflowUnitRequest = { dispatchFingerprint: "", plan, runId: "run", blockPath: "workflow.samples", path: `workflow.samples[${digest.slice(0, 16)}]`,
    bindings: { ...bindings, item, variant, repetition: 0 }, unit: { ...identity, key: `workflow.samples:${digest}`, attemptId: "attempt",
      ordinal: 1, inputFingerprint: workflowDigest({ item, variant, repetition: 0, bindings }), status: "running", cleanupStatus: "cleaned", outputs: {}, errors: [] } };
  request.dispatchFingerprint = workflowDispatchFingerprint(request);
  return { catalog, request, counts: () => ({ setupCalls, allocations, releases }) };
}

test("JSON dispatch executes only the assigned sample and preserves its identity and evidence", async () => {
  const { catalog, request, counts } = fixture();
  const store = await storage();
  const result = await executeWorkflowUnit(JSON.parse(JSON.stringify(request)), catalog, { store, signal: new AbortController().signal, workerId: "node-a" });
  expect(result.status).toBe("completed");
  expect(counts()).toEqual({ setupCalls: 0, allocations: 1, releases: 1 });
  expect(result.units).toHaveLength(1);
  expect(result.units[0]).toMatchObject({ attemptId: "attempt", caseId: "b", cleanupStatus: "cleaned", outputs: { result: { worker: "node-a", attemptId: "attempt" } } });
  expect(result.steps.map(step => step.plugin)).toEqual(["sample"]);
  expect(result.artifacts).toHaveLength(1);
  expect(await store.read()).toEqual(result);
});

test("credential declarations use locked inputs and reject names obtained from case or step output", () => {
  const { catalog, request } = fixture();
  catalog.resource("client").credentials = config => [String(config.apiKeyEnv)];
  request.plan.document.inputs.keyName = "MODEL_AUTH";
  const binding = request.plan.document.workflow.resources.client;
  if (!binding) throw new Error("Missing fixture client");
  binding.config = { apiKeyEnv: { ref: "inputs.keyName" } };
  expect(workflowCredentialNames(request, catalog)).toEqual(["MODEL_AUTH"]);
  binding.config = { apiKeyEnv: { ref: "item.id" } };
  expect(() => workflowCredentialNames(request, catalog)).toThrow("must use literals");
  binding.config = { apiKeyEnv: { ref: "setup.outputs.result" } };
  expect(() => workflowCredentialNames(request, catalog)).toThrow("must use literals");
});

test("transfer resolves only declared credentials without placing their values in assignment or records", async () => {
  const { request } = fixture();
  const store = await storage();
  const resolved: string[] = [];
  const session = new WorkflowTransferSession(request, "node", "digest", store, new AbortController().signal,
    { names: ["MODEL_AUTH"], async resolve(name) { resolved.push(name); return "fixture-secret-value"; } });
  const call = (requestId: string, op: string, name?: string) => session.handle({ requestId, op, name: name ?? null,
    nodeId: "node", attemptId: request.unit.attemptId });
  await expect(call("denied", "credential", "UNDECLARED_SECRET")).rejects.toThrow("not declared");
  expect(resolved).toEqual([]);
  expect(await call("allowed", "credential", "MODEL_AUTH")).toEqual({ value: "fixture-secret-value" });
  expect(await call("allowed", "credential", "MODEL_AUTH")).toEqual({ value: "fixture-secret-value" });
  expect(resolved).toEqual(["MODEL_AUTH"]);
  expect(JSON.stringify(await call("assignment", "assignment"))).not.toContain("fixture-secret-value");
  await expect(store.read()).rejects.toMatchObject({ code: "ENOENT" });
});

test("whole-plan credential collection includes each model variant and ignores unused resources", () => {
  const { catalog, request } = fixture();
  catalog.resource("client").credentials = config => [String(config.apiKeyEnv)];
  const binding = request.plan.document.workflow.resources.client;
  const samples = request.plan.document.workflow.steps.find(node => node.id === "samples");
  if (!binding || samples?.kind !== "forEach") throw new Error("Missing fixture declarations");
  binding.config = { apiKeyEnv: { ref: "variant.apiKeyEnv" } };
  samples.matrix.variants = [{ id: "a", apiKeyEnv: "AUTH_A" }, { id: "b", apiKeyEnv: "AUTH_B" }];
  request.plan.document.workflow.resources.unused = { ...binding, config: { apiKeyEnv: { value: "DO_NOT_READ" } } };
  expect(workflowPlanCredentialNames(request.plan, catalog)).toEqual(["AUTH_A", "AUTH_B"]);
});

test("worker progress retains the assigned identity without persisting previews or caching each update", async () => {
  const { request } = fixture(), store = await storage();
  const events: ProgressEvent[] = [];
  const session = new WorkflowTransferSession(request, "node", "digest", store, new AbortController().signal, undefined, event => events.push(event));
  const call = (event: ProgressEvent) => session.handle({ op: "event", nodeId: "node", attemptId: request.unit.attemptId, event });
  await call({ phase: "solve", message: "started" });
  await call({ phase: "solve", message: "tool output", transient: true });
  expect(events).toEqual([
    { phase: "solve", message: "started", taskId: "b", attemptId: "attempt" },
    { phase: "solve", message: "tool output", transient: true, taskId: "b", attemptId: "attempt" },
  ]);
  expect(() => call({ phase: "solve", message: "wrong task", taskId: "other" })).toThrow("assigned workflow unit");
  expect(session.replies.size).toBe(0);
  await expect(store.read()).rejects.toMatchObject({ code: "ENOENT" });
});

test("worker cleanup failure preserves business results and requires recovery", async () => {
  const { catalog, request } = fixture("worker", true);
  const result = await executeWorkflowUnit(request, catalog, { store: await storage(), signal: new AbortController().signal, workerId: "node-b" });
  expect(result).toMatchObject({ status: "failed", businessComplete: true });
  expect(result.units[0]).toMatchObject({ status: "completed", cleanupStatus: "unconfirmed" });
  expect(result.resources[0]?.state).toBe("unconfirmed");
});

test("asynchronously resolved credentials are redacted from logs and persisted failures regardless of variable name", async () => {
  const { catalog, request } = fixture();
  const secret = "asynchronously-resolved-test-authentication";
  catalog.resource("client").create = async (_config, context) => {
    const value = await context.runtime.credential("AUTHENTICATION");
    context.log(`failure: ${value}`);
    throw new Error(`provider rejected ${value}`);
  };
  const events: unknown[] = [];
  const store = await storage();
  const result = await executeWorkflowUnit(request, catalog, { store, signal: new AbortController().signal, workerId: "node",
    runtime: { directory: store.directory, resolvePath: path => path, credential: async () => secret },
    onEvent: event => { events.push(event); } });
  expect(result.status).toBe("failed");
  expect(JSON.stringify(result)).toContain("[redacted]");
  expect(JSON.stringify(await store.read())).not.toContain(secret);
  expect(JSON.stringify(events)).not.toContain(secret);
});

test("dispatch rejects coordinator resources, altered inputs, and changed implementation versions before allocation", async () => {
  const coordinator = fixture("run");
  const options = { store: await storage(), signal: new AbortController().signal, workerId: "node" };
  await expect(executeWorkflowUnit(coordinator.request, coordinator.catalog, options)).rejects.toThrow("coordinator-owned");
  expect(coordinator.counts().allocations).toBe(0);
  const changed = fixture();
  changed.request.bindings["setup.outputs.result"] = "altered";
  await expect(executeWorkflowUnit(changed.request, changed.catalog, options)).rejects.toThrow("fingerprint changed");
  const version = fixture();
  version.catalog.resource("client").version = "2";
  await expect(executeWorkflowUnit(version.request, version.catalog, options)).rejects.toThrow("implementation changed");
  expect(version.counts().allocations).toBe(0);
});

test("dispatch persists evidence and recovers a lost response before retrying the whole unit", async () => {
  const { catalog, request, counts } = fixture();
  let loseResponse = true;
  const recovered: string[] = [];
  catalog.registerResource({ type: "executor", version: "1", apiVersion: 1, capabilities: ["workflow.executor/v1"], resources: {},
    validateConfig: workflowObject, async create() {
      const executor: WorkflowUnitExecutor = {
        recoveryIdentity: request => ({ attemptId: request.unit.attemptId }),
        async execute(request, host) {
          const result = await executeWorkflowUnit(JSON.parse(JSON.stringify(request)), catalog, {
            store: host.store, signal: host.signal, workerId: "remote" });
          if (loseResponse) { loseResponse = false; throw new Error("connection lost after checkpoint"); }
          return result;
        },
      };
      return { value: executor, identity: {} };
    }, async recover(identity) { recovered.push(String(identity.attemptId)); },
  });
  const document = structuredClone(request.plan.document);
  document.workflow.resources.executor = { use: "executor", scope: "run", config: {}, resources: {} };
  const samples = document.workflow.steps[1];
  if (!samples || samples.kind !== "forEach") throw new Error("Missing samples");
  samples.executor = "executor";
  document.run.onError = "continue";
  const plan = compileWorkflow(document, catalog);
  const store = await storage(), signal = new AbortController().signal;
  const first = await executeWorkflow(plan, catalog, { store, signal });
  expect(first.status).toBe("failed");
  expect(first.units.map(unit => unit.cleanupStatus)).toEqual(["unconfirmed", "cleaned"]);
  expect(first.artifacts).toHaveLength(2);
  expect(await store.read()).toEqual(first);
  const second = await executeWorkflow(plan, catalog, { store, signal, previous: first });
  expect(second.status).toBe("completed");
  expect(recovered).toEqual([first.units[0]?.attemptId]);
  expect(second.units.map(unit => unit.ordinal)).toEqual([1, 1, 2]);
  expect(second.resources.every(resource => resource.state === "released")).toBe(true);
  expect(counts()).toEqual({ setupCalls: 2, allocations: 3, releases: 3 });
  expect(await store.read()).toEqual(second);
});


test.each([false, true])("dispatch refreshes receipts before recovery checkpoint and rejects altered identity (tamper=%s)", async tamper => {
  const { catalog, request } = fixture();
  let dispatched = 0, checkpointed = 0;
  catalog.registerResource({ type: "admission", version: "1", apiVersion: 1, capabilities: ["workflow.admission/v1"], resources: {},
    validateConfig: workflowObject, async create() { return { identity: {}, value: {
      async reuseInputs(unit: ExecutionUnitIdentity) { return { caseId: unit.caseId }; },
      async *order(units: ExecutionUnitIdentity[]) { yield* units; },
    } }; },
  });
  catalog.registerResource({ type: "executor", version: "1", apiVersion: 1, capabilities: ["workflow.executor/v1"], resources: {},
    validateConfig: workflowObject, async create() {
      const executor: WorkflowUnitExecutor = {
        async prepare(request, context) {
          const receipt = await context.artifacts.write("receipt.txt", "current receipt", { protocol: "arsi.text/v1", mediaType: "text/plain" });
          return { bindings: { ...request.bindings, "setup.outputs.result": workflowObject(receipt),
            ...(tamper ? { item: { id: "not-the-assigned-case" } } : {}) }, nodeId: "current-node" };
        },
        recoveryIdentity(request) {
          checkpointed++;
          expect(request.nodeId).toBe("current-node");
          expect(request.dispatchFingerprint).toBe(workflowDispatchFingerprint(request));
          return { receipt: request.bindings["setup.outputs.result"] ?? null };
        },
        async execute(request, host) {
          dispatched++;
          const saved = await storageRoot.read();
          expect(saved.resources.some(resource => resource.key.endsWith(":dispatch") && resource.state === "creating" &&
            JSON.stringify(resource.identity.receipt) === JSON.stringify(request.bindings["setup.outputs.result"]))).toBe(true);
          return executeWorkflowUnit(request, catalog, { store: host.store, signal: host.signal, workerId: "current-node" });
        },
      };
      return { value: executor, identity: {} };
    }, async recover() {},
  });
  const document = structuredClone(request.plan.document);
  document.workflow.resources.executor = { use: "executor", scope: "run", config: {}, resources: {} };
  document.workflow.resources.admission = { use: "admission", scope: "run", config: {}, resources: {} };
  const samples = document.workflow.steps[1];
  if (samples?.kind !== "forEach") throw new Error("Missing samples");
  samples.executor = "executor"; samples.admission = "admission";
  const storageRoot = await storage(), plan = compileWorkflow(document, catalog);
  const result = await executeWorkflow(plan, catalog, { store: storageRoot, signal: AbortSignal.timeout(5000) });
  expect(result.status).toBe(tamper ? "failed" : "completed");
  expect(dispatched).toBe(tamper ? 0 : 2); expect(checkpointed).toBe(dispatched);
  if (tamper) expect(JSON.stringify(result.units)).toContain("do not match its execution identity");
  else {
    const resumed = await executeWorkflow(plan, catalog, { store: storageRoot, signal: AbortSignal.timeout(5000), previous: result });
    expect(resumed.status).toBe("completed"); expect(dispatched).toBe(2);
  }
});
