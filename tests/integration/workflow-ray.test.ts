import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, readFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { expect, test } from "vitest";
import { stringify } from "yaml";
import { runWorkflow, retryWorkflow } from "../../src/application/workflow.js";
import { LocalWorkflowStore } from "../../src/plugins/stores/workflow-local.js";
import type { ProgressEvent } from "../../src/core/progress/progress.js";

const command = promisify(execFile);
// Run in an isolated Linux container: this test owns its Ray head and stops it at the end.
test.skipIf(process.env.EVALUATOR_WORKFLOW_RAY_TESTS !== "1").each(["auto", "local"])("real Ray %s executes variants, artifacts, retry, cleanup recovery and cancellation", async endpoint => {
  const directory = await mkdtemp(join(tmpdir(), "workflow-ray-"));
  const calls: string[] = [];
  let fail = true;
  let failCleanup = false, allocations = 0;
  let onAllocate: (() => void) | undefined;
  const namespaces = new Set<string>();
  const upstream = createServer((request, response) => {
    void (async () => {
      if (request.url?.startsWith("/state/")) {
        expect(request.headers.authorization).toBe("Bearer coordinator-only-memory-fixture");
        if (request.method === "POST") { allocations++; namespaces.add(request.url); onAllocate?.(); }
        else if (failCleanup) { failCleanup = false; response.writeHead(503); response.end(); return; }
        else namespaces.delete(request.url);
        response.end("{}"); return;
      }
      let body = ""; for await (const chunk of request) body += String(chunk);
      const value = JSON.parse(body);
      const prompt = String(value.messages[0].content), model = String(value.model);
      calls.push(`${model}:${prompt}`);
      expect(request.headers.authorization).toBe(model === "a" ? "Bearer worker-only-fixture-key" : "Bearer coordinator-only-model-fixture");
      if (fail && prompt === "fail") { response.writeHead(400); response.end("fixture failure"); return; }
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ choices: [{ message: { content: "4" }, finish_reason: "stop" }], usage: { total_tokens: 3 } }));
    })().catch(() => { response.writeHead(500); response.end("fixture error"); });
  });
  await new Promise<void>(done => upstream.listen(0, "127.0.0.1", done));
  const address = upstream.address(); if (!address || typeof address === "string") throw new Error("Missing model fixture port");
  const cert = join(directory, "cert.pem"), key = join(directory, "key.pem"), nodeConfig = join(directory, "node.json");
  const token = "workflow-ray-fixture-transfer-token-20261110";
  const patch = join(directory, "plugins.yaml");
  const environment: NodeJS.ProcessEnv = { ...process.env, EVALUATOR_NODE_CONFIG: nodeConfig, EVALUATOR_TRANSFER_TOKEN: token, WORKFLOW_TEST_API_KEY: "worker-only-fixture-key" };
  const previousEnvironment = Object.fromEntries(["EVALUATOR_NODE_CONFIG", "EVALUATOR_TRANSFER_TOKEN", "WORKFLOW_TEST_API_KEY"].map(name => [name, process.env[name]]));
  for (const name of Object.keys(previousEnvironment)) process.env[name] = environment[name];
  try {
    await command("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-keyout", key, "-out", cert,
      "-subj", "/CN=localhost", "-addext", "subjectAltName=IP:127.0.0.1", "-addext", "basicConstraints=critical,CA:TRUE"]);
    await writeFile(nodeConfig, JSON.stringify({ nodeExecutable: process.execPath, workerEntry: resolve("dist/application/ray/node-worker.js"),
      workflowWorkerEntry: resolve("dist/application/ray/workflow-worker.js"), configDirectory: directory, outputRoot: join(directory, "node"), caFile: cert, pluginPatchPath: patch }));
    await writeFile(patch, stringify([{ insert: [{ id: "workflow-fixture", name: resolve("tests/fixtures/ray/workflow-plugin.mjs") },
      { id: "native-fixture", name: resolve("tests/fixtures/ray/plugin.mjs") }] }]));
    if (endpoint === "auto") await command("ray", ["start", "--head", "--port=0", "--num-cpus=2", '--resources={"evaluator_slot":2}', "--include-dashboard=false", "--disable-usage-stats"],
      { env: environment, timeout: 90_000 });
    const networkConfigPath = join(directory, "network.yaml");
    await writeFile(networkConfigPath, stringify({ sources: { huggingface: "${NETWORK_TEST_HF}" } }));
    const submitterEnvironment = { EVALUATOR_NETWORK_CONFIG: networkConfigPath, NETWORK_TEST_HF: "https://workflow-network.example", WORKFLOW_DATASET_TOKEN: "coordinator-only-dataset-fixture", ...environment, WORKFLOW_TEST_API_KEY: "submitter-shadow-must-not-win",
      COORDINATOR_ONLY_CREDENTIAL: "coordinator-only-model-fixture", COORDINATOR_ONLY_MEMORY: "coordinator-only-memory-fixture" };
    const config = join(directory, "workflow.yaml");
    await writeFile(config, stringify({ schemaVersion: 2, workflow: "application.evaluate", output: { directory: join(directory, "runs") },
      run: { timeoutSeconds: 90, cleanupTimeoutSeconds: 30, onError: "continue" }, with: {
        concurrency: 2, variants: ["a", "b"].map(id => ({ id, config: { model: id, endpoint: `http://127.0.0.1:${address.port}/v1`,
          apiKeyEnv: id === "a" ? "WORKFLOW_TEST_API_KEY" : "COORDINATOR_ONLY_CREDENTIAL", maxAttempts: 1 } })),
        cases: [{ id: "first", request: { prompt: "ok" }, reference: "4" }, { id: "second", request: { prompt: "fail" }, reference: "4" }],
        scheduler: { name: "ray", config: { endpoint, concurrency: 2, heartbeatTimeoutMs: 30_000,
          collector: { certFile: cert, keyFile: key, publicUrl: "https://127.0.0.1:18443", host: "127.0.0.1", port: 18443 } } },
      } }));
    const first = await runWorkflow({ configPath: config, patchPath: patch, env: submitterEnvironment });
    expect(first.record.status, JSON.stringify(first.record.errors)).toBe("failed");
    expect(first.record.units.map(unit => unit.status).sort(), JSON.stringify(first.record.steps)).toEqual(["completed", "completed", "failed", "failed"]);
    expect(first.record.resources.every(resource => resource.state === "released")).toBe(true);
    expect(first.record.artifacts.length).toBeGreaterThan(0);
    expect(await new LocalWorkflowStore(first.directory).read()).toEqual(first.record);
    fail = false;
    const second = await retryWorkflow(first.directory, { patchPath: patch, env: submitterEnvironment, taskIds: ["second"] });
    expect(second.record.status, JSON.stringify(second.record.errors)).toBe("completed");
    expect(calls.filter(call => call.endsWith(":ok"))).toHaveLength(2);
    expect(calls.filter(call => call.endsWith(":fail"))).toHaveLength(4);
    expect(second.record.units).toHaveLength(6);
    expect(await readFile(join(first.directory, "run.json"), "utf8")).not.toContain("worker-only-fixture-key");
    const benchmarkConfig = join(directory, "benchmark.yaml");
    await writeFile(benchmarkConfig, stringify({ schemaVersion: 2, workflow: "benchmark.evaluate",
      output: { directory: join(directory, "benchmark-runs") }, run: { timeoutSeconds: 180, cleanupTimeoutSeconds: 45, onError: "continue" }, with: {
        benchmark: { name: "ray-fixture", config: { expectedNetworkEndpoint: "https://workflow-network.example", requireDatasetAccess: true, hfToken: { credential: "WORKFLOW_DATASET_TOKEN" } }, solver: { name: "ray-fixture", config: { countSolves: true } } },
        services: { default: { model: "fixture", base_url: "http://fixture.invalid", apiKeyEnv: "COORDINATOR_ONLY_CREDENTIAL" } },
        environment: "local", scheduler: { name: "ray", config: { endpoint, concurrency: 1,
          collector: { certFile: cert, keyFile: key, publicUrl: "https://127.0.0.1:18443", host: "127.0.0.1", port: 18443 } } },
        variants: [{ id: "first", solver: { name: "ray-fixture", config: { countSolves: true, failOnceTask: "task-0", progress: true } } }, { id: "second" }],
        run: { onError: "continue", maxTasks: 1, preparation: { mode: "batch", concurrency: 1 } },
      } }));
    const progress: ProgressEvent[] = [];
    const benchmark = await runWorkflow({ configPath: benchmarkConfig, patchPath: patch, env: submitterEnvironment,
      onEvent: event => { if (event.progress) progress.push(event.progress); } });
    expect(progress.some(event => event.phase === "solve" && event.taskId === "task-0")).toBe(true);
    expect(progress.some(event => event.live?.lines.some(line => line.includes("remote-live-preview")))).toBe(true);
    expect(progress.some(event => event.failure?.message.includes("Injected one-time solver failure"))).toBe(true);
    expect(JSON.stringify(progress)).not.toContain("coordinator-only-model-fixture");
    expect(JSON.stringify(benchmark.record)).not.toContain("remote-live-preview");
    expect(benchmark.record.status, JSON.stringify({ errors: benchmark.record.errors, steps: benchmark.record.steps, units: benchmark.record.units })).toBe("failed");
    expect(benchmark.record.units, JSON.stringify(benchmark.record.errors)).toHaveLength(2);
    expect(benchmark.record.steps.filter(step => step.plugin === "benchmark.start")).toHaveLength(2);
    expect(benchmark.record.artifacts.filter(artifact => artifact.protocol === "arsi.benchmark-evidence/v1")).toHaveLength(2);
    expect(await readFile(join(directory, "solve-count.txt"), "utf8")).toBe("2");
    const successful = benchmark.record.units.find(unit => unit.status === "completed");
    expect(successful?.variantId).toBe("second");
    const retriedBenchmark = await retryWorkflow(benchmark.directory, { patchPath: patch, env: submitterEnvironment, taskIds: ["task-0"] });
    expect(retriedBenchmark.record.status, JSON.stringify({ errors: retriedBenchmark.record.errors, units: retriedBenchmark.record.units })).toBe("completed");
    expect(retriedBenchmark.record.units).toHaveLength(3);
    expect(retriedBenchmark.record.units.find(unit => unit.variantId === "second")).toEqual(successful);
    expect(await readFile(join(directory, "solve-count.txt"), "utf8")).toBe("3");
    const metrics = retriedBenchmark.record.outputs.metrics as { groups: { metrics: Record<string, { rate: number; verified: number; pending: number }> }[] };
    expect(metrics.groups).toHaveLength(2);
    for (const group of metrics.groups) expect(group.metrics["success-rate"]).toMatchObject({ rate: 1, verified: 1, pending: 0 });
    const resumedBenchmark = await runWorkflow({ configPath: benchmarkConfig, patchPath: patch, env: submitterEnvironment, resume: benchmark.record.runId });
    expect(resumedBenchmark.record.status, JSON.stringify(resumedBenchmark.record.errors)).toBe("completed");
    expect(await readFile(join(directory, "solve-count.txt"), "utf8")).toBe("3");
    const cleanupConfig = join(directory, "cleanup.yaml");
    const cleanupDocument = { schemaVersion: 2, output: { directory: join(directory, "cleanup-runs") },
      run: { timeoutSeconds: 90, cleanupTimeoutSeconds: 30 }, resources: {
        execution: { use: "executor.ray", scope: "run", resources: { connection: "ray" } },
        ray: { use: "ray.connection", scope: "run", config: { endpoint, concurrency: 1,
          collector: { certFile: cert, keyFile: key, publicUrl: "https://127.0.0.1:18443", host: "127.0.0.1", port: 18443 } } },
      }, workflow: { steps: [{ id: "samples", forEach: { items: { value: [{ id: "artifact" }] }, mode: "units", executor: "execution" },
        resources: { state: { use: "fixture.namespace", scope: "attempt", config: { endpoint: `http://127.0.0.1:${address.port}/state`, apiKeyEnv: "COORDINATOR_ONLY_MEMORY" } } },
        steps: [{ id: "write", use: "fixture.large-artifact", config: { wait: false }, resources: { state: "state" } }], outputs: { artifact: { ref: "write.outputs.artifact" } } }],
        outputs: { results: { ref: "samples.outputs.results" } } } };
    await writeFile(cleanupConfig, stringify({ ...cleanupDocument, workflow: { ...cleanupDocument.workflow, steps: [
      { id: "guard", use: "fixture.ray-guard", resources: { connection: "ray" } }, ...cleanupDocument.workflow.steps,
    ] } }));
    failCleanup = true;
    const dirty = await runWorkflow({ configPath: cleanupConfig, patchPath: patch, env: submitterEnvironment });
    expect(dirty.record.status, JSON.stringify(dirty.record.errors)).toBe("failed");
    expect(dirty.record.businessComplete, JSON.stringify(dirty.record.steps)).toBe(true);
    expect(namespaces.size).toBe(1);
    expect(dirty.record.artifacts[0]?.size).toBe(1_100_000);
    const recovered = await runWorkflow({ configPath: cleanupConfig, patchPath: patch, env: submitterEnvironment, resume: dirty.record.runId });
    expect(recovered.record.status, JSON.stringify(recovered.record.errors)).toBe("completed");
    expect(namespaces.size).toBe(0);
    expect(allocations).toBe(1);
    expect(recovered.record.units).toHaveLength(1);
    expect(await new LocalWorkflowStore(recovered.directory).read()).toEqual(recovered.record);
    const cancelConfig = join(directory, "cancel.yaml"), cancelDocument = structuredClone(cleanupDocument);
    const write = cancelDocument.workflow.steps[0]?.steps[0];
    if (!write) throw new Error("Missing cancellation fixture step");
    write.config.wait = true;
    await writeFile(cancelConfig, stringify(cancelDocument));
    const cancel = new AbortController();
    onAllocate = () => setTimeout(() => cancel.abort(new Error("fixture cancellation")), 200);
    const cancelled = await runWorkflow({ configPath: cancelConfig, patchPath: patch, env: submitterEnvironment, signal: cancel.signal });
    expect(cancelled.record.status).toBe("cancelled");
    expect(cancelled.record.units[0]?.status).toBe("cancelled");
    expect(cancelled.record.units[0]?.cleanupStatus, JSON.stringify(cancelled.record.resources)).toBe("cleaned");
    expect(namespaces.size).toBe(0);
    expect(cancelled.record.resources.every(resource => resource.state === "released")).toBe(true);
    expect(await new LocalWorkflowStore(cancelled.directory).read()).toEqual(cancelled.record);
    const inspect = async (root: string): Promise<void> => {
      for (const entry of await readdir(root, { withFileTypes: true })) {
        const path = join(root, entry.name);
        if (entry.isDirectory()) await inspect(path);
        else {
          const content = await readFile(path);
          for (const secret of ["worker-only-fixture-key", "submitter-shadow-must-not-win", "coordinator-only-model-fixture", "coordinator-only-memory-fixture"])
            expect(content.includes(Buffer.from(secret)), path).toBe(false);
        }
      }
    };
    await inspect(directory);
  } finally {
    upstream.closeAllConnections(); await new Promise<void>(done => upstream.close(() => done()));
    await command("ray", ["stop", "--force"], { env: environment, timeout: 30_000 }).catch(() => {});
    for (const [name, value] of Object.entries(previousEnvironment)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    await rm(directory, { recursive: true, force: true });
  }
}, 240_000);
