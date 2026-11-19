import { maintainWorkflow } from "../../src/application/workflow-maintenance.js";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";
import { createGatewayCertificate } from "../fixtures/ray/gateway-certificate.js";
import { parse, stringify } from "yaml";
import { runWorkflow, retryWorkflow } from "../../src/application/workflow.js";
import { warmupWorkflow } from "../../src/application/workflow-warmup.js";
import type { WorkflowEvent } from "../../src/core/contracts/workflow.js";
import type { ProgressEvent } from "../../src/core/progress/progress.js";
import { rebuildWorkflowReport } from "../../src/application/workflow-report.js";

const command = promisify(execFile);
// Isolated Linux container only. Mount the built checkout at /workspace and /opt/evaluator.
test.skipIf(process.env.EVALUATOR_WORKFLOW_JOBS_TESTS !== "1")("real Ray Jobs executes a workflow with memory-only credentials and resumes from uploaded evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "wj-")), security = join(root, "security"), jobs = join(root, "j");
  const token = randomUUID() + randomUUID(), transferToken = randomUUID() + randomUUID(), secret = "jobs-model-memory-fixture-authentication";
  const calls: string[] = [];
  let fail = true, gateway: ChildProcess | undefined, tracer: ChildProcess | undefined;
  let tracerReader: DatabaseSync | undefined;
  let blocked: (() => void) | undefined, blockArrived: (() => void) | undefined;
  // This spans cluster startup and successive Jobs, including an independent resume after retry.
  const signal = AbortSignal.timeout(300_000);
  const upstream = createServer((request, response) => {
    void (async () => {
      let body = ""; for await (const chunk of request) body += String(chunk);
      const prompt = String(JSON.parse(body).messages[0].content); calls.push(prompt);
      expect(request.headers.authorization).toBe(`Bearer ${secret}`);
      if (prompt === "hold") await new Promise<void>(done => { blocked = done; blockArrived?.(); });
      if (fail && prompt === "b") { response.writeHead(400); response.end(); return; }
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
    })().catch(() => { response.writeHead(500); response.end(); });
  });
  try {
    await mkdir(security); await mkdir(jobs);
    await createGatewayCertificate(security);
    await writeFile(join(security, "jobs-token"), token);
    await writeFile(join(security, "token"), transferToken);
    const patchPath = join(root, "plugins.yaml"), nodeConfig = join(root, "node.json");
    await writeFile(patchPath, stringify([{ insert: [{ id: "native-fixture", name: resolve("tests/fixtures/ray/plugin.mjs") }] }]));
    await writeFile(nodeConfig, JSON.stringify({ nodeExecutable: process.execPath, workerEntry: resolve("dist/application/ray/node-worker.js"),
      workflowWorkerEntry: resolve("dist/application/ray/workflow-worker.js"), configDirectory: root, outputRoot: join(root, "node"),
      caFile: join(security, "cert.pem"), pluginPatchPath: patchPath }));
    const clusterEnv = { ...process.env, EVALUATOR_NODE_CONFIG: nodeConfig, EVALUATOR_TRANSFER_TOKEN: transferToken,
      EVALUATOR_COLLECTOR_ORIGIN: "https://127.0.0.1" };
    await command("ray", ["start", "--head", "--port=0", "--num-cpus=2", "--include-dashboard=true", "--dashboard-host=127.0.0.1",
      "--dashboard-port=28265", '--resources={"evaluator_slot":2}', "--disable-usage-stats"], { timeout: 90_000, env: clusterEnv });
    gateway = spawn(process.execPath, [resolve("src/application/ray/entries/jobs-gateway.mjs")], { stdio: ["ignore", "pipe", "pipe"], env: {
      ...clusterEnv, EVALUATOR_PLUGIN_PATCH_PATH: patchPath, EVALUATOR_JOBS_ROOT: jobs, EVALUATOR_JOBS_SECURITY: security, EVALUATOR_JOBS_PORT: "28443",
      EVALUATOR_RAY_DASHBOARD: "http://127.0.0.1:28265", EVALUATOR_JOBS_PROGRESS_ORIGIN: "https://127.0.0.1:28443",
    } });
    await new Promise<void>((done, reject) => {
      const timer = setTimeout(() => reject(new Error("Jobs gateway did not start")), 10_000);
      gateway?.once("exit", () => { clearTimeout(timer); reject(new Error("Jobs gateway exited")); });
      gateway?.stdout?.on("data", chunk => { if (String(chunk).includes("listening")) { clearTimeout(timer); done(); } });
      gateway?.stderr?.on("data", () => {});
    });
    await new Promise<void>(done => upstream.listen(0, "127.0.0.1", done));
    const address = upstream.address(); if (!address || typeof address === "string") throw new Error("Missing model fixture port");
    const configPath = join(root, "eval.yaml");
    await writeFile(configPath, stringify({ schemaVersion: 2, workflow: "application.evaluate",
      deployment: { kind: "ray-jobs", endpoint: "https://127.0.0.1:28443", caFile: join(security, "cert.pem"), tokenEnv: "JOBS_GATEWAY_TOKEN" },
      output: { directory: "download" }, run: { onError: "continue" },
      with: { scheduler: { name: "ray", config: { concurrency: 1 } }, model: { model: "fixture", apiKeyEnv: "JOBS_MODEL_AUTH",
        endpoint: `http://127.0.0.1:${address.port}/v1`, maxAttempts: 1 },
        cases: ["a", "b"].map(id => ({ id, request: { prompt: id }, reference: "ok" })) },
    }));
    const networkConfigPath = join(root, "network.yaml");
    await writeFile(networkConfigPath, stringify({ sources: { huggingface: "${NETWORK_TEST_HF}" } }));
    const logs: string[] = [], progress: ProgressEvent[] = [];
    const options = { configPath, patchPath, signal,
      env: { EVALUATOR_NETWORK_CONFIG: networkConfigPath, NETWORK_TEST_HF: "https://workflow-network.example", WORKFLOW_DATASET_TOKEN: "coordinator-only-dataset-fixture", JOBS_GATEWAY_TOKEN: token, JOBS_MODEL_AUTH: secret }, onEvent(event: WorkflowEvent) { logs.push(event.message); if (event.progress) progress.push(event.progress); } };
    expect((await warmupWorkflow(options)).every(item => item.status === "not-required")).toBe(true);
    expect(calls).toEqual([]);
    const maintenanceFile = join(root, "maintenance.yaml");
    await writeFile(maintenanceFile, stringify({ schemaVersion: 2,
      deployment: { kind: "ray-jobs", endpoint: "https://127.0.0.1:28443", caFile: join(security, "cert.pem"), tokenEnv: "JOBS_GATEWAY_TOKEN" },
      resources: { probe: { use: "fixture.maintenance", config: { apiKeyEnv: "JOBS_MODEL_AUTH" } } }, workflow: { steps: [] },
    }));
    const maintained = await maintainWorkflow({ ...options, configPath: maintenanceFile }, { operation: "doctor", options: {} })
      .catch(cause => { throw new Error(`Maintenance failed: ${logs.join("\n").replaceAll(secret, "[redacted]")}`, { cause }); });
    expect(maintained).toMatchObject([{ status: "passed", output: { checked: true, privateValue: "[redacted]" } }]);
    expect(calls).toEqual([]);
    const first = await runWorkflow(options).catch(cause => {
      throw new Error(`Initial Jobs execution failed: ${logs.join("\n").replaceAll(secret, "[redacted]")}`, { cause });
    });
    expect(first.record.units.map(unit => unit.status)).toEqual(["completed", "failed"]);
    const runId = first.record.runId;
    // All files here belong to this test; simulate loss of the cluster's retained run.
    await rm(join(jobs, "workflow-runs", runId), { recursive: true });
    fail = false;
    const retryOptions = { ...options, taskIds: ["b"], requestId: "retry-b" };
    const second = await retryWorkflow(first.directory, retryOptions).catch(cause => {
      throw new Error(`Jobs resume failed: ${logs.join("\n").replaceAll(secret, "[redacted]")}`, { cause });
    });
    expect(second.record.status).toBe("completed");
    expect(second.request.status).toBe("completed");
    const repeated = await retryWorkflow(first.directory, retryOptions);
    expect(repeated.request).toEqual(second.request);
    expect(repeated.record.units).toHaveLength(3);
    expect(second.record.units).toHaveLength(3);
    expect(second.record.units[0]).toEqual(first.record.units[0]);
    expect(calls).toEqual(["a", "b", "b"]);
    const benchmarkConfig = join(root, "benchmark.yaml");
    await writeFile(benchmarkConfig, stringify({ schemaVersion: 2, workflow: "benchmark.evaluate",
      output: { directory: "benchmark-results" }, run: { timeoutSeconds: 120, cleanupTimeoutSeconds: 30, onError: "continue" },
      with: {
        deployment: { kind: "ray-jobs", endpoint: "https://127.0.0.1:28443", caFile: join(security, "cert.pem"), tokenEnv: "JOBS_GATEWAY_TOKEN" },
        benchmark: { name: "ray-fixture", config: { expectedNetworkEndpoint: "https://workflow-network.example", requireDatasetAccess: true, hfToken: { credential: "WORKFLOW_DATASET_TOKEN" } }, solver: { name: "ray-fixture", config: { countSolves: true, failOnceTask: "task-0", progress: true } } },
        services: { default: { model: "fixture", base_url: "http://fixture.invalid", apiKeyEnv: "JOBS_MODEL_AUTH" } },
        environment: "local", scheduler: { name: "ray", concurrency: 1 },
        run: { maxTasks: 2, onError: "continue", preparation: { mode: "batch", concurrency: 1 } },
      },
    }));
    const { JOBS_MODEL_AUTH: _modelAuth, ...previewEnv } = options.env;
    const preview = await maintainWorkflow({ ...options, env: previewEnv, configPath: benchmarkConfig }, { operation: "preview", options: {} })
      .catch(cause => { throw new Error(`Benchmark preview failed: ${logs.join("\n").replaceAll(secret, "[redacted]")}`, { cause }); });
    expect(preview).toContainEqual(expect.objectContaining({ provider: "benchmark.runtime", status: "passed",
      output: { groups: [{ id: "default", taskIds: ["task-0", "task-1"] }] } }));
    const nativeWarmup = await warmupWorkflow({ ...options, configPath: benchmarkConfig });
    expect(nativeWarmup).toContainEqual(expect.objectContaining({ provider: "benchmark.runtime", status: "passed",
      summary: "Image warmup: 2/2 tasks ready; 0 failed", details: [] }));
    await expect(readFile(join(root, "solve-count.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    const tracerUrl = "http://127.0.0.1:28787", tracerDb = join(root, "traces.db");
    tracer = spawn(process.execPath, [resolve("dist/plugins/tracer/collector/main.js"),
      "--host", "127.0.0.1", "--port", "28787", "--db", tracerDb, "--spool", join(root, "spool")]);
    await expect.poll(async () => (await fetch(tracerUrl + "/healthz").catch(() => null))?.ok).toBe(true);
    const native = await runWorkflow({ ...options, configPath: benchmarkConfig, plugins: [{ id: "tracer", config: { url: tracerUrl, autostart: false } }] });
    expect(progress.some(event => event.phase === "solve" && event.taskId === "task-0")).toBe(true);
    expect(progress.some(event => event.live?.lines.some(line => line.includes("remote-live-preview")))).toBe(true);
    expect(progress.some(event => event.failure?.message.includes("Injected one-time solver failure"))).toBe(true);
    expect(JSON.stringify(progress)).not.toContain(secret);
    expect(JSON.stringify(native.record)).not.toContain("remote-live-preview");
    expect(native.record.status, JSON.stringify(native.record.errors)).toBe("failed");
    expect(native.record.units.map(unit => unit.status)).toEqual(["failed", "completed"]);
    const collector = tracerReader = new DatabaseSync(tracerDb, { readOnly: true });
    const events = (attemptId: string) => collector.prepare("SELECT type FROM events WHERE epoch=? AND attempt=? ORDER BY seq")
      .all(native.record.runId, attemptId).map(row => row.type);
    const outcomes = () => collector.prepare("SELECT task_id, success FROM outcomes WHERE epoch=? ORDER BY task_id").all(native.record.runId);
    expect(events(native.record.units[0]!.attemptId)).toEqual(["start"]);
    expect(events(native.record.units[1]!.attemptId)).toEqual(["start", "end"]);
    expect(outcomes()).toEqual([{ task_id: "task-0", success: 0 }, { task_id: "task-1", success: 1 }]);
    expect(await readFile(join(root, "solve-count.txt"), "utf8")).toBe("2");
    await rm(join(jobs, "workflow-runs", native.record.runId), { recursive: true });
    const nativeRetryOptions = { ...options, taskIds: ["task-0"], requestId: "native-retry" };
    const nativeRetried = await retryWorkflow(native.directory, nativeRetryOptions);
    expect(nativeRetried.record.status, JSON.stringify(nativeRetried.record.errors)).toBe("completed");
    expect(nativeRetried.record.units).toHaveLength(3);
    expect(nativeRetried.record.units.slice(0, 2)).toEqual(native.record.units);
    expect((await retryWorkflow(native.directory, nativeRetryOptions)).request).toEqual(nativeRetried.request);
    const resumed = await runWorkflow({ ...options, configPath: benchmarkConfig, resume: native.record.runId });
    expect(resumed.record.status).toBe("completed");
    expect(resumed.record.units).toEqual(nativeRetried.record.units);
    const last = nativeRetried.record.units[2]!.attemptId;
    expect(events(last)).toEqual(["start", "end"]);
    expect(collector.prepare("SELECT success, reward, attempt_id FROM outcomes WHERE epoch=? AND task_id=?").get(native.record.runId, "task-0"))
      .toEqual({ success: 1, reward: 1, attempt_id: last });
    expect(JSON.parse(await readFile(join(nativeRetried.directory, "workflow-reporting.json"), "utf8")).configDirectory).toBe(root);
    expect(await readFile(await rebuildWorkflowReport(nativeRetried.directory), "utf8")).toContain("Evaluator report");
    expect(await readFile(join(root, "solve-count.txt"), "utf8")).toBe("3");
    const autoConfig = join(root, "automatic.yaml");
    const autoDocument = parse(await readFile(benchmarkConfig, "utf8"));
    autoDocument.output.directory = "automatic-results";
    autoDocument.with.run.maxTasks = 1;
    autoDocument.with.benchmark.solver.config = { countSolves: true, truncateOnceTask: "task-0" };
    await writeFile(autoConfig, stringify(autoDocument));
    const automatic = await runWorkflow({ ...options, configPath: autoConfig });
    expect(automatic.record.status, JSON.stringify(automatic.record.errors)).toBe("completed");
    expect(automatic.record.units.map(unit => unit.status)).toEqual(["failed", "completed"]);
    const automaticNative = JSON.parse(await readFile(join(automatic.directory, "benchmark-evidence", automatic.record.runId, "manifest.json"), "utf8"));
    expect(automaticNative.preparationRounds).toHaveLength(2);
    expect(automatic.record.artifacts.filter(artifact => artifact.protocol === "arsi.benchmark-selection/v1")).toHaveLength(2);
    expect(await readFile(join(root, "solve-count.txt"), "utf8")).toBe("5");
    const onlineConfig = join(root, "online.yaml");
    await writeFile(onlineConfig, stringify({ schemaVersion: 2, workflow: "application.evaluate",
      deployment: { kind: "ray-jobs", endpoint: "https://127.0.0.1:28443", caFile: join(security, "cert.pem"), tokenEnv: "JOBS_GATEWAY_TOKEN" },
      output: { directory: "online-results" }, run: { onError: "continue" },
      with: { concurrency: 1, model: { model: "fixture", apiKeyEnv: "JOBS_MODEL_AUTH", endpoint: `http://127.0.0.1:${address.port}/v1`, maxAttempts: 1 },
        cases: ["b", "hold"].map(id => ({ id, request: { prompt: id }, reference: "ok" })) },
    }));
    fail = true;
    const holding = new Promise<void>(done => { blockArrived = done; });
    const online = runWorkflow({ ...options, configPath: onlineConfig });
    online.catch(() => {});
    try {
      await Promise.race([holding, online.then(() => { throw new Error("Online Job ended before the held case"); })]);
      const entries = (await readdir(join(root, "online-results"))).filter(name => !name.startsWith("."));
      expect(entries).toHaveLength(1);
      const directory = join(root, "online-results", entries[0]!);
      await expect(readFile(join(directory, "run.json"))).rejects.toMatchObject({ code: "ENOENT" });
      fail = false;
      const queued = await retryWorkflow(directory, { ...options, taskIds: ["b"], requestId: "online-b" });
      expect(queued.queued).toBe(true);
      blocked?.();
      const finished = await online;
      expect(finished.record.status, JSON.stringify(finished.record.errors)).toBe("completed");
      expect(finished.record.units).toHaveLength(3);
    } finally { blocked?.(); await online; }
    const inspect = async (directory: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) await inspect(path);
        else {
          const bytes = await readFile(path);
          for (const value of [secret, "coordinator-only-dataset-fixture"]) expect(bytes.includes(Buffer.from(value)), path).toBe(false);
        }
      }
    };
    await inspect(jobs);
    expect(logs.join("\n")).not.toContain(secret);
    expect(logs.join("\n")).not.toContain("coordinator-only-dataset-fixture");
  } finally {
    tracerReader?.close();
    upstream.closeAllConnections(); await new Promise<void>(done => upstream.close(() => done()));
    for (const child of [gateway, tracer]) {
      if (!child || child.exitCode !== null || child.signalCode !== null) continue;
      const exited = new Promise<void>(done => child.once("exit", () => done())); child.kill(); await exited;
    }
    await command("ray", ["stop", "--force"], { timeout: 30_000 }).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
}, 330_000);
