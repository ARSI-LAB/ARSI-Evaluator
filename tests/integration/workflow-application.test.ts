import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { stringify } from "yaml";
import { inspectWorkflow, runWorkflow, retryWorkflow, initializeWorkflow, exportWorkflow } from "../../src/application/workflow.js";
import { runCli } from "../../src/cli/main.js";
import { Evaluator } from "../../src/application/evaluator.js";
import { warmupWorkflow } from "../../src/application/workflow-warmup.js";
import { workflowObject } from "../../src/core/workflow/values.js";
import { defaultNetworkConfigPath } from "../../src/config/network.js";

const cleanup: (() => Promise<void>)[] = [];
// CLI/SDK scenarios perform multiple persisted runs against a real local HTTP server.
vi.setConfig({ testTimeout: 30_000 });
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

test("initializing a template does not read or replace invalid runtime network settings", async () => {
  const root = await mkdtemp(join(tmpdir(), "arsi-workflow-init-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const network = defaultNetworkConfigPath();
  const previous = await readFile(network, "utf8").catch(error => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  await mkdir(dirname(network), { recursive: true });
  const invalid = "version: invalid-runtime-network\n";
  await writeFile(network, invalid);
  try {
    const configPath = join(root, "evaluate.yaml");
    await initializeWorkflow("application.evaluate", configPath);
    expect(await readFile(configPath, "utf8")).toContain("workflow: application.evaluate");
    expect(await readFile(network, "utf8")).toBe(invalid);
  } finally {
    if (previous === undefined) await rm(network);
    else await writeFile(network, previous);
  }
});

test("Jobs YAML exports a portable plan while preserving client output and TLS configuration", async () => {
  const root = await mkdtemp(join(tmpdir(), "arsi-workflow-jobs-config-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const configPath = join(root, "evaluate.yaml"), exported = join(root, "nested", "expanded.yaml");
  const input = { schemaVersion: 2, workflow: "application.evaluate",
    deployment: { kind: "ray-jobs", endpoint: "https://cluster.example:9443", caFile: "cert.pem" },
    output: { directory: "download" },
    with: { model: { model: "fixture", apiKeyEnv: "MODEL_KEY" }, cases: [] },
  };
  await writeFile(configPath, stringify(input));
  await mkdir(join(root, "nested"));
  const original = await inspectWorkflow({ configPath, env: {} });
  expect(original.document.pathBase).toBe(".");
  expect(original.document.output.directory).toBe("results");
  await exportWorkflow({ configPath, env: {} }, exported);
  const expanded = await inspectWorkflow({ configPath: exported, env: {} });
  expect(expanded.document).toEqual(original.document);
  const text = await readFile(exported, "utf8");
  expect(text).toContain("ray-jobs");
  expect(text).toContain("download");
  await writeFile(configPath, stringify({ ...input, pathBase: "../local-only" }));
  await expect(inspectWorkflow({ configPath, env: {} })).rejects.toThrow("pathBase");
});

test.each([
  ["application.evaluate", null], ["benchmark.evaluate", null], ["results.rescore", null],
  ["memory.qa", "workflow-memory"], ["application.compare", "workflow-compare"], ["pelican.svg", "workflow-pelican"],
] as const)("%s can be discovered, initialized and inspected without credentials", async (type, plugin) => {
  const root = await mkdtemp(join(tmpdir(), "arsi-workflow-starter-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const patchPath = plugin ? join(import.meta.dirname, "../../plugins", plugin, "cordis.patch.yaml") : undefined;
  const configPath = join(root, "evaluate.yaml"), output: string[] = [], errors: string[] = [];
  expect(await runCli(["workflow", "list", "--json", ...(patchPath ? ["--patch", patchPath] : [])],
    { out: text => output.push(text), error: text => errors.push(text) }), errors.join("\n")).toBe(0);
  expect(JSON.parse(output.join("\n")).some((item: { name: string }) => item.name === type)).toBe(true);
  await initializeWorkflow(type, configPath, patchPath);
  const plan = await inspectWorkflow({ configPath, ...(patchPath ? { patchPath } : {}), env: {} });
  expect(plan.document.workflow.steps.length).toBeGreaterThan(0);
}, 15_000);

test("JSONL cases produce a public collection and reject changed data on a completed resume", async () => {
  const root = await mkdtemp(join(tmpdir(), "arsi-workflow-jsonl-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const requests: string[] = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    requests.push(body);
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ choices: [{ message: { content: "private-answer" } }] }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); }));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No server address");
  const configPath = join(root, "eval.yaml"), dataPath = join(root, "cases.jsonl");
  const source = JSON.stringify({ id: "a", request: { prompt: "question" }, reference: "private-answer" }) + "\n";
  await writeFile(dataPath, source);
  await writeFile(configPath, stringify({ schemaVersion: 2, workflow: "application.evaluate", with: {
    model: { model: "fixture", endpoint: `http://127.0.0.1:${address.port}/v1` }, casesFile: "cases.jsonl",
  } }));
  const first = await runWorkflow({ configPath, env: {} });
  expect(first.record.status, JSON.stringify(first.record.errors)).toBe("completed");
  expect(requests).toHaveLength(1);
  expect(requests[0]).not.toContain("private-answer");
  const loaded = first.record.steps.find(step => step.plugin === "data.cases-jsonl");
  const collection = workflowObject(loaded?.outputs.cases), artifact = workflowObject(collection.artifact);
  expect(collection.count).toBe(1);
  expect(await readFile(join(first.directory, String(artifact.path)), "utf8")).not.toContain("private-answer");
  await writeFile(dataPath, source.replace("question", "changed question"));
  const resumed = await runWorkflow({ configPath, env: {}, resume: first.record.runId });
  expect(resumed.record.status).toBe("failed");
  expect(resumed.record.errors[0]?.message).toContain("Dataset changed");
  expect(requests).toHaveLength(1);
}, 15_000);

test("one template configuration runs, inspects and resumes without repeating requests", async () => {
  const root = await mkdtemp(join(tmpdir(), "arsi-workflow-app-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  let calls = 0;
  const server = createServer((request, response) => {
    calls++;
    expect(request.headers.authorization).toBe("Bearer isolated-workflow-token");
    request.resume();
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ choices: [{ message: { content: "4" }, finish_reason: "stop" }], usage: { total_tokens: 2 } }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); }));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No server address");
  const file = join(root, "eval.yaml");
  const starter = join(root, "starter.yaml");
  expect(await runCli(["init", "--workflow", "application.evaluate", "--output", starter], { out() {}, error() {} })).toBe(0);
  expect((await inspectWorkflow({ configPath: starter })).document.workflow.steps).toHaveLength(3);
  await writeFile(file, stringify({ schemaVersion: 2, workflow: "application.evaluate", with: {
    model: { model: "fixture", endpoint: `http://127.0.0.1:${address.port}/v1`, apiKeyEnv: "WORKFLOW_TOKEN" },
    cases: [{ id: "addition", request: { question: "2 + 2" }, reference: "4" }],
  } }));
  const inspected = await inspectWorkflow({ configPath: file });
  expect(inspected.document.workflow.steps).toHaveLength(3);
  const exported = join(root, "custom", "eval.yaml");
  await mkdir(join(root, "custom"));
  const exportErrors: string[] = [];
  expect(await runCli(["inspect", file, "--output", exported], { out() {}, error: value => exportErrors.push(value) }), exportErrors.join("\n")).toBe(0);
  const expanded = await inspectWorkflow({ configPath: exported });
  expect(expanded.document).toEqual(inspected.document);
  // Exporting into another directory preserves relative resource paths and result location.
  expect(expanded.document.pathBase).toBe(root);
  expect(calls).toBe(0);
  const env = { WORKFLOW_TOKEN: "isolated-workflow-token" };
  await warmupWorkflow({ configPath: file, env });
  expect(calls).toBe(0);
  const first = await runWorkflow({ configPath: file, env });
  expect(first.record.status).toBe("completed");
  expect(calls).toBe(1);
  const resumed = await runWorkflow({ configPath: file, resume: first.record.runId, env });
  expect(resumed.record.status).toBe("completed");
  expect(calls).toBe(1);
  const sdk = new Evaluator();
  const sdkResult = await sdk.run({ configPath: file, resume: first.record.runId, env });
  expect(sdkResult.kind).toBe("workflow");
  const report = await sdk.report(first.directory);
  expect(await readFile(report, "utf8")).toContain("exact-match");
  expect(calls).toBe(1);
  expect(await readFile(join(first.directory, "plan.json"), "utf8")).not.toContain("isolated-workflow-token");
  expect(JSON.parse(await readFile(join(first.directory, "run.json"), "utf8")).businessComplete).toBe(true);
  const output: string[] = [], errors: string[] = [];
  const exit = await runCli(["run", file, "--dry-run"], { out: value => output.push(value), error: value => errors.push(value) });
  expect(exit).toBe(2);
  expect(errors.join("\n")).toContain("does not provide a preview operation");
  expect(calls).toBe(1);
  const savedPlan = await readFile(join(first.directory, "plan.json"), "utf8");
  const original = await readFile(file, "utf8");
  await writeFile(file, original.replace("fixture", "different-model"));
  await expect(runWorkflow({ configPath: file, resume: first.record.runId, env })).rejects.toThrow("Cannot resume");
  expect(await readFile(join(first.directory, "plan.json"), "utf8")).toBe(savedPlan);
});

test("saved workflow retry runs only selected failures and keeps successful samples", async () => {
  const root = await mkdtemp(join(tmpdir(), "arsi-workflow-retry-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const failures = new Set(["b", "c"]), calls: string[] = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const prompt = JSON.parse(body).messages[0].content as string;
    calls.push(prompt);
    if (failures.has(prompt)) { response.statusCode = 500; response.end("unavailable"); return; }
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); }));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No server address");
  const configPath = join(root, "retry.yaml");
  await writeFile(configPath, stringify({ schemaVersion: 2, workflow: "application.evaluate", run: { onError: "continue" }, with: {
    model: { model: "fixture", endpoint: `http://127.0.0.1:${address.port}/v1`, maxAttempts: 1 },
    cases: ["a", "b", "c"].map(id => ({ id, request: { prompt: id }, reference: "ok" })),
  } }));
  const first = await runWorkflow({ configPath, env: {} });
  expect(first.record.status).toBe("failed");
  expect(calls).toEqual(["a", "b", "c"]);
  failures.delete("b");
  const selected = await retryWorkflow(first.directory, { taskIds: ["b"], env: {} });
  expect(selected.record.status).toBe("failed");
  expect(calls).toEqual(["a", "b", "c", "b"]);
  await expect(retryWorkflow(first.directory, { taskIds: ["a"], env: {} })).rejects.toThrow("failed or interrupted");
  failures.clear();
  const last = await retryWorkflow(first.directory, { env: {} });
  expect(last.record.status).toBe("completed");
  expect(calls).toEqual(["a", "b", "c", "b", "c"]);
});

test("rescoring creates a separate run, preserves model groups and never calls the targets again", async () => {
  const root = await mkdtemp(join(tmpdir(), "arsi-workflow-rescore-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const calls: string[] = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const model = String(JSON.parse(body).model); calls.push(model);
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ choices: [{ message: { content: model === "judge" ? JSON.stringify({ score: 0.8, reason: "new rubric" }) : "ok" } }] }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); }));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No server address");
  const endpoint = `http://127.0.0.1:${address.port}/v1`, configPath = join(root, "source.yaml");
  await writeFile(configPath, stringify({ schemaVersion: 2, workflow: "application.evaluate", with: {
    variants: ["a", "b"].map(id => ({ id, config: { model: id, endpoint } })),
    cases: [{ id: "case", request: { prompt: "question" }, reference: "ok" }],
  } }));
  const source = await runWorkflow({ configPath, env: {} });
  expect(source.record.status).toBe("completed");
  const original = await readFile(join(source.directory, "run.json"), "utf8");
  const scoringConfig = join(root, "score.yaml");
  await writeFile(scoringConfig, stringify({ schemaVersion: 2, workflow: "results.rescore", with: {
    source: source.directory, judge: { model: "judge", endpoint }, rubric: "Use a new rubric.",
  } }));
  const scored = await runWorkflow({ configPath: scoringConfig, env: {} });
  expect(scored.record.status, JSON.stringify(scored.record.steps.filter(step => step.errors.length))).toBe("completed");
  expect(scored.record.runId).not.toBe(source.record.runId);
  expect(calls).toEqual(["a", "b", "judge", "judge"]);
  expect(scored.record.outputs.metrics).toMatchObject({ scores: { "a:rubric": { count: 1, mean: 0.8 }, "b:rubric": { count: 1, mean: 0.8 } } });
  expect(scored.record.outputs.source).toMatchObject({ runId: source.record.runId });
  expect(await readFile(join(source.directory, "run.json"), "utf8")).toBe(original);
}, 15_000);

test("online retry admits one fresh attempt while another sample is still running", async () => {
  const root = await mkdtemp(join(tmpdir(), "arsi-workflow-online-retry-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const failed = Promise.withResolvers<void>(), retryCalled = Promise.withResolvers<void>(), releaseSlow = Promise.withResolvers<void>();
  const calls: string[] = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const sample = String(JSON.parse(body).messages[0].content); calls.push(sample);
    if (sample === "a" && calls.filter(value => value === "a").length === 1) { response.statusCode = 500; response.end(); return; }
    if (sample === "b") await releaseSlow.promise;
    else retryCalled.resolve();
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); }));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No server address");
  const configPath = join(root, "evaluate.yaml");
  await writeFile(configPath, stringify({ schemaVersion: 2, workflow: "application.evaluate", run: { onError: "continue" }, with: {
    model: { model: "fixture", endpoint: `http://127.0.0.1:${address.port}/v1`, maxAttempts: 1 }, concurrency: 2,
    cases: ["a", "b"].map(id => ({ id, request: { prompt: id }, reference: "ok" })),
  } }));
  const running = runWorkflow({ configPath, env: {}, onEvent(event) {
    if (event.message === "Execution unit a: failed") failed.resolve();
  } });
  try {
    await failed.promise;
    const directories = await readdir(join(root, "results"));
    const directory = join(root, "results", directories[0] ?? "missing");
    const rejected = await retryWorkflow(directory, { taskIds: ["b"], requestId: "active-case", env: {} });
    expect(rejected.queued).toBe(false);
    expect(rejected.request.status).toBe("rejected");
    const requestId = "online-retry-once";
    const submitted = await retryWorkflow(directory, { taskIds: ["a"], requestId, env: {} });
    expect(submitted.queued).toBe(true);
    await retryCalled.promise;
    await retryWorkflow(directory, { taskIds: ["a"], requestId, env: {} });
    expect(calls.filter(value => value === "a")).toHaveLength(2);
    releaseSlow.resolve();
    const result = await running;
    expect(result.record.status).toBe("completed");
    expect(result.record.units.filter(unit => unit.caseId === "a").map(unit => unit.status)).toEqual(["failed", "completed"]);
    expect(result.record.units.filter(unit => unit.caseId === "b")).toHaveLength(1);
    expect(JSON.parse(await readFile(join(directory, "retry-control.json"), "utf8")).requests).toMatchObject([
      { requestId: "active-case", status: "rejected" }, { requestId, status: "completed" },
    ]);
  } finally { releaseSlow.resolve(); await running; }
}, 20_000);
