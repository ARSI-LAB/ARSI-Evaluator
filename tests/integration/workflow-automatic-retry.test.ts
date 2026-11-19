import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { WorkflowDefinitions } from "../../src/core/workflow/catalog.js";
import { compileWorkflow } from "../../src/core/workflow/compile.js";
import { executeWorkflow } from "../../src/core/workflow/execute.js";
import { parseWorkflowDocument, parseCompiledWorkflowDocument, workflowConfiguration } from "../../src/config/workflow-schema.js";
import { workflowObject, jsonPort } from "../../src/core/workflow/values.js";
import { LocalWorkflowStore } from "../../src/plugins/stores/workflow-local.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture(mode: "transient" | "persistent" | "cleanup" | "cancel" | "reject" | "external") {
  const root = await mkdtemp(join(tmpdir(), "workflow-auto-retry-")); roots.push(root);
  const store = new LocalWorkflowStore(root), catalog = new WorkflowDefinitions(), controller = new AbortController();
  const events: string[] = [];
  let calls = 0, decisions = 0;
  catalog.registerResource({ type: "state", apiVersion: 1, version: "1", resources: {}, capabilities: ["state"], validateConfig: workflowObject,
    async create(_config, context) { events.push(`open:${context.attemptId}`); return { identity: {}, value: new Map(), async dispose() {
      events.push(`close:${context.attemptId}`); if (mode === "cleanup") throw new Error("Unconfirmed cleanup");
    } }; }, async recover() {},
  });
  catalog.registerResource({ type: "retry-policy", apiVersion: 1, version: "1", resources: {}, capabilities: ["workflow.retry/v1"], validateConfig: workflowObject,
    async create() { return { identity: {}, value: { async shouldRetry(attempt: { errors: unknown[] }) {
      decisions++; expect(attempt.errors.length).toBeGreaterThan(0); expect(events.at(-1)).toMatch(/^close:/);
      return mode !== "reject";
    } } }; },
  });
  catalog.registerStep({ type: "evaluate", apiVersion: 1, version: "1", resources: { state: { capability: "state" } }, inputs: {}, outputs: { answer: jsonPort() },
    effects: mode === "external" ? "external-write" : "isolated-write", validateConfig: workflowObject,
    async execute(_inputs, _config, context) {
      const memory = context.resource("state"); if (!(memory instanceof Map)) throw new Error("Missing fixture state");
      expect(memory.size).toBe(0); memory.set("used", true); calls++;
      if (mode === "cancel") controller.abort(new Error("cancelled"));
      if (mode !== "transient" || calls === 1) throw new Error("temporary fixture failure");
      return { answer: "ok" };
    },
  });
  const document = parseWorkflowDocument({ schemaVersion: 2, resources: {
    policy: { use: "retry-policy", scope: "run" }, state: { use: "state", scope: "attempt" },
  }, workflow: { steps: [{ id: "cases", forEach: { items: { value: [{ id: "a" }] }, mode: "units", retry: { policy: "policy", maxAttempts: 3 } },
    steps: [{ id: "evaluate", use: "evaluate", resources: { state: "state" } }], outputs: { answer: { ref: "evaluate.outputs.answer" } },
  }], outputs: { results: { ref: "cases.outputs.results" } } } });
  const plan = compileWorkflow(document, catalog);
  return { store, catalog, plan, controller, counts: () => ({ calls, decisions }), events };
}

test("automatic retry closes old state, creates a new attempt, and serializes its policy", async () => {
  const value = await fixture("transient");
  expect(parseCompiledWorkflowDocument(value.plan.document)).toEqual(value.plan.document);
  expect(parseWorkflowDocument(workflowConfiguration(value.plan.document))).toEqual(value.plan.document);
  const result = await executeWorkflow(value.plan, value.catalog, { store: value.store, signal: value.controller.signal });
  expect(result.status, JSON.stringify(result.errors)).toBe("completed");
  expect(result.units.map(unit => unit.status)).toEqual(["failed", "completed"]);
  expect(value.counts()).toEqual({ calls: 2, decisions: 1 });
  expect(new Set(result.units.map(unit => unit.attemptId)).size).toBe(2);
});

test("persistent failures stop at the saved attempt bound, including after manual resume", async () => {
  const value = await fixture("persistent");
  const result = await executeWorkflow(value.plan, value.catalog, { store: value.store, signal: value.controller.signal });
  expect(result.status).toBe("failed"); expect(result.units.map(unit => unit.ordinal)).toEqual([1, 2, 3]);
  expect(value.counts()).toEqual({ calls: 3, decisions: 2 });
  const resumed = await executeWorkflow(value.plan, value.catalog, { store: value.store, signal: value.controller.signal, previous: result });
  expect(resumed.units.map(unit => unit.ordinal)).toEqual([1, 2, 3, 4]);
  expect(value.counts()).toEqual({ calls: 4, decisions: 2 });
});

test.each(["cleanup", "cancel", "reject", "external"] as const)("%s cannot trigger an unsafe second execution", async mode => {
  const value = await fixture(mode);
  const result = await executeWorkflow(value.plan, value.catalog, { store: value.store, signal: value.controller.signal });
  expect(result.status).toBe(mode === "cancel" ? "cancelled" : "failed");
  expect(value.counts().calls).toBe(1);
  if (mode === "cleanup" || mode === "cancel") expect(value.counts().decisions).toBe(0);
  if (mode === "cleanup") expect(result.units[0]?.cleanupStatus).toBe("unconfirmed");
});
