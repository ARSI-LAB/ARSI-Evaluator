import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { parse } from "yaml";
import { memoryProvider, memorySteps, memoryTemplate } from "../../plugins/workflow-memory/index.js";
import { WorkflowDefinitions } from "../../src/core/workflow/catalog.js";
import { workflowBuiltinSteps } from "../../src/plugins/steps/workflow-builtins.js";
import { compileWorkflow } from "../../src/core/workflow/compile.js";
import { parseWorkflowDocument } from "../../src/config/workflow-schema.js";
import { executeWorkflow } from "../../src/core/workflow/execute.js";
import { LocalWorkflowStore } from "../../src/plugins/stores/workflow-local.js";
import { workflowObject } from "../../src/core/workflow/values.js";
import { httpMemoryProvider } from "../../plugins/workflow-memory/http.js";
import { createServer } from "node:http";
import type { JsonValue } from "../../src/core/contracts/task.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

test("external memory template retains past sessions without revealing future history", async () => {
  const root = await mkdtemp(join(tmpdir(), "ember-memory-flow-")); roots.push(root);
  const definitions = new WorkflowDefinitions();
  for (const definition of [...workflowBuiltinSteps, ...memorySteps]) definitions.registerStep(definition);
  definitions.registerResource(memoryProvider);
  definitions.registerTemplate(memoryTemplate);
  const yaml = workflowObject(parse(await readFile(new URL("../../playbook/workflows/memory.yaml", import.meta.url), "utf8")));
  const plan = compileWorkflow(parseWorkflowDocument(memoryTemplate.expand(workflowObject(yaml.with))), definitions);
  const result = await executeWorkflow(plan, definitions, { store: new LocalWorkflowStore(root), signal: new AbortController().signal });
  expect(result.status, JSON.stringify(result.steps.filter(step => step.errors.length))).toBe("completed");
  expect(result.outputs.metrics).toMatchObject({ total: 1, completed: 1, scores: { "default:exact-match": { count: 4, mean: 1 } } });
  expect(result.resources).toHaveLength(1);
  expect(result.resources[0]?.state).toBe("released");
});

test("HTTP memory namespaces are isolated and removed after all sessions", async () => {
  const root = await mkdtemp(join(tmpdir(), "ember-http-memory-")); roots.push(root);
  const namespaces = new Map<string, Map<string, JsonValue>>(), created: string[] = [], queries: JsonValue[] = [];
  const server = createServer(async (request, response) => {
    try {
      const [, , encoded, suffix] = (request.url ?? "").split("/");
      const namespace = decodeURIComponent(encoded ?? "");
      const chunks: Uint8Array[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = chunks.length ? workflowObject(JSON.parse(Buffer.concat(chunks).toString("utf8"))) : {};
      response.setHeader("content-type", "application/json");
      if (request.method === "PUT") { namespaces.set(namespace, new Map()); created.push(namespace); response.end("{}"); return; }
      if (request.method === "DELETE") { namespaces.delete(namespace); response.writeHead(204).end(); return; }
      const memory = namespaces.get(namespace);
      if (!memory) { response.writeHead(404).end("{}"); return; }
      if (suffix === "history" && Array.isArray(body.entries)) {
        for (const value of body.entries) { const item = workflowObject(value); memory.set(String(item.key), item.value ?? null); }
        response.end("{}"); return;
      }
      const value = memory.get(String(body.key)) ?? null; queries.push(value); response.end(JSON.stringify(value));
    } catch { response.writeHead(500).end("{}"); }
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  try {
    const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing server address");
    const definitions = new WorkflowDefinitions();
    for (const definition of [...workflowBuiltinSteps, ...memorySteps]) definitions.registerStep(definition);
    definitions.registerResource(httpMemoryProvider);
    const plan = compileWorkflow(parseWorkflowDocument(memoryTemplate.expand({ report: false, concurrency: 2,
      memory: { use: "example.memory-http", config: { endpoint: `http://127.0.0.1:${address.port}` } },
      cases: ["a", "b"].map(id => ({ id, sessions: [
        { history: [], questions: [{ key: "secret", reference: "null" }] },
        { history: [{ key: "secret", value: id }], questions: [{ key: "secret", reference: id }] },
      ] })),
    })), definitions);
    const record = await executeWorkflow(plan, definitions, { store: new LocalWorkflowStore(root), signal: new AbortController().signal });
    expect(record.status, JSON.stringify(record.steps.flatMap(step => step.errors))).toBe("completed");
    expect(new Set(created).size).toBe(2);
    expect(namespaces.size).toBe(0);
    expect(queries.filter(value => value === null)).toHaveLength(2);
    expect(record.resources.every(resource => resource.state === "released" && typeof resource.identity.namespace === "string")).toBe(true);
  } finally {
    await new Promise<void>((done, reject) => { server.close(error => error ? reject(error) : done()); server.closeAllConnections(); });
  }
});
