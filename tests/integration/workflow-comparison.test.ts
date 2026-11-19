import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { comparisonSteps, comparisonTemplate } from "../../plugins/workflow-compare/index.js";
import { WorkflowDefinitions } from "../../src/core/workflow/catalog.js";
import { workflowBuiltinSteps } from "../../src/plugins/steps/workflow-builtins.js";
import { compileWorkflow } from "../../src/core/workflow/compile.js";
import { parseWorkflowDocument } from "../../src/config/workflow-schema.js";
import { executeWorkflow } from "../../src/core/workflow/execute.js";
import { LocalWorkflowStore } from "../../src/plugins/stores/workflow-local.js";
import { workflowObject } from "../../src/core/workflow/values.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function setup(failTarget: boolean, failJudge: boolean) {
  const root = await mkdtemp(join(tmpdir(), "ember-compare-flow-")); roots.push(root);
  const definitions = new WorkflowDefinitions(), calls = { a: 0, b: 0, judge: 0 };
  for (const step of [...workflowBuiltinSteps, ...comparisonSteps]) definitions.registerStep(step);
  definitions.registerResource({
    type: "model.client", apiVersion: 1, version: "1", capabilities: ["application.invoke/v1"], sharing: "shared", resources: {}, validateConfig: workflowObject,
    async create(config) {
      const model = workflowObject(config.settings).model;
      return { identity: {}, async dispose() {}, value: { async invoke() {
        if (model === "a") { calls.a++; return { text: "A result" }; }
        if (model === "b") { calls.b++; if (failTarget) { failTarget = false; throw new Error("Target temporarily unavailable"); } return { text: "B result" }; }
        calls.judge++;
        if (failJudge) { failJudge = false; throw new Error("Judge temporarily unavailable"); }
        return { text: JSON.stringify({ winner: "A", reason: "Clearer explanation" }) };
      } } };
    }, async recover() {},
  });
  const document = parseWorkflowDocument(comparisonTemplate.expand({ variants: [{ id: "a", config: { model: "a" } }, { id: "b", config: { model: "b" } }],
    cases: [{ id: "case", request: { question: "Explain" } }], judge: { model: { model: "judge" }, rubric: "Clarity" }, report: false }));
  const plan = compileWorkflow(document, definitions), store = new LocalWorkflowStore(root), signal = new AbortController().signal;
  return { calls, plan, definitions, store, signal };
}

test("pairwise grading retries without repeating completed candidate runs", async () => {
  const { calls, plan, definitions, store, signal } = await setup(false, true);
  const failed = await executeWorkflow(plan, definitions, { store, signal });
  expect(failed.status).toBe("failed");
  expect(calls).toEqual({ a: 1, b: 1, judge: 1 });
  const completed = await executeWorkflow(plan, definitions, { store, signal, previous: await store.read() });
  expect(completed.status, JSON.stringify(completed.errors)).toBe("completed");
  expect(calls).toEqual({ a: 1, b: 1, judge: 2 });
  expect(completed.outputs.metrics).toMatchObject({ scores: { "default:left-preference": { count: 1, mean: 1 } } });
});

test("missing counterparts remain explicit and are graded after the failed candidate recovers", async () => {
  const { calls, plan, definitions, store, signal } = await setup(true, false);
  const failed = await executeWorkflow(plan, definitions, { store, signal });
  expect(failed.status).toBe("failed");
  expect(calls).toEqual({ a: 1, b: 1, judge: 0 });
  expect(failed.units.at(-1)?.outputs.comparison).toMatchObject({ status: "missing-counterpart" });
  const completed = await executeWorkflow(plan, definitions, { store, signal, previous: await store.read() });
  expect(completed.status, JSON.stringify(completed.errors)).toBe("completed");
  expect(calls).toEqual({ a: 1, b: 2, judge: 1 });
  expect(completed.units.at(-1)?.outputs.comparison).toMatchObject({ status: "scored", winner: "a" });
});
