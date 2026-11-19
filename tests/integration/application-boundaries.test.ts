import { expect, test, vi } from "vitest";
import { compileWorkflow, executeWorkflow, jsonPort, parseWorkflowDocument, WorkflowDefinitions, workflowObject } from "../../src/index.js";
import type { WorkflowRunRecord, WorkflowStore } from "../../src/index.js";
import * as pluginRegistry from "../../src/application/plugins/open-registry.js";

test("public workflow kernel runs caller definitions and storage without loading application plugins", async () => {
  const open = vi.spyOn(pluginRegistry, "openPluginRegistry").mockImplementation(async () => { throw new Error("unexpected plugin loading"); });
  const saved: WorkflowRunRecord[] = [];
  const store: WorkflowStore = { async save(record) { saved.push(structuredClone(record)); }, artifacts() {
    return { async read() { throw new Error("unused artifact read"); }, async write() { throw new Error("unused artifact write"); } };
  } };
  let created = 0, disposed = 0;
  const definitions = new WorkflowDefinitions();
  definitions.registerResource({ type: "counter", apiVersion: 1, version: "1", capabilities: ["counter/v1"], resources: {},
    validateConfig: workflowObject, async create() { created++; return { value: 42, identity: {}, async dispose() { disposed++; } }; },
  });
  definitions.registerStep({ type: "read", apiVersion: 1, version: "1", effects: "read", inputs: {}, outputs: { result: jsonPort() },
    resources: { counter: { capability: "counter/v1" } }, validateConfig: workflowObject,
    async execute(_inputs, _config, context) { return workflowObject({ result: context.resource("counter") }); },
  });
  try {
    const plan = compileWorkflow(parseWorkflowDocument({ schemaVersion: 2,
      resources: { counter: { use: "counter", scope: "run" } }, workflow: {
        steps: [{ id: "read", use: "read", resources: { counter: "counter" } }], outputs: { result: { ref: "read.outputs.result" } },
      } }), definitions);
    const result = await executeWorkflow(plan, definitions, { store, signal: new AbortController().signal });
    expect(result).toMatchObject({ status: "completed", outputs: { result: 42 } });
    expect(saved.at(-1)).toEqual(result);
    expect(created).toBe(1); expect(disposed).toBe(1);
    expect(open).not.toHaveBeenCalled();
  } finally { open.mockRestore(); }
});
