import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { openPluginRegistry } from "../../src/application/plugins/open-registry.js";
import { maintainWorkflow, maintainWorkflowPlan } from "../../src/application/workflow-maintenance.js";
import { executeWorkflowMaintenanceJob } from "../../src/application/ray/workflow-job.js";
import { parseMaintenanceResults } from "../../src/core/workflow/maintenance.js";
import { compileWorkflow } from "../../src/core/workflow/compile.js";
import { parseWorkflowDocument } from "../../src/config/workflow-schema.js";
import { workflowObject } from "../../src/core/workflow/values.js";
import { runCli } from "../../src/cli/main.js";
import { DockerEnvironment } from "../../src/plugins/environments/docker/environment.js";
import { diagnoseNetwork } from "../../src/infrastructure/network/diagnostics.js";

vi.mock("../../src/infrastructure/network/diagnostics.js", () => ({ diagnoseNetwork: vi.fn(async () => []) }));
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

test.each(["success", "failure", "cancel"])("resource maintenance %s never creates evaluation state and closes dependencies", async mode => {
  const registry = await openPluginRegistry(), controller = new AbortController();
  const events: string[] = [], logs: string[] = [];
  try {
    registry.ctx.evaluator.registerResource({ type: "fixture.client", apiVersion: 1, version: "1", capabilities: ["fixture.client/v1"],
      availableDuringMaintenance: true, resources: {}, validateConfig: workflowObject,
      async create() { events.push("open"); return { identity: {}, value: "client", async dispose(signal) { expect(signal.aborted).toBe(false); events.push("close"); } }; },
    });
    registry.ctx.evaluator.registerResource({ type: "fixture.evaluation", apiVersion: 1, version: "1", capabilities: ["fixture.client/v1"],
      availableDuringMaintenance: true, resources: {}, validateConfig: workflowObject,
      async create() { throw new Error("Unused evaluation dependency was started"); },
    });
    registry.ctx.evaluator.registerResource({ type: "fixture.probe", apiVersion: 1, version: "1", capabilities: [],
      resources: { client: { capability: "fixture.client/v1" }, evaluation: { capability: "fixture.client/v1" } }, validateConfig: workflowObject,
      credentials: () => ["PROBE_AUTH"],
      async create() { throw new Error("Evaluation resource was created"); },
      maintenance: { doctor: { resources: ["client"], credentials: () => ["PROBE_AUTH"], validateRequest: workflowObject, async execute(_config, _request, context) {
        expect(context.resource("client")).toBe("client"); events.push("probe");
        const secret = await context.runtime.credential("PROBE_AUTH"); context.log(`value=${secret}`);
        if (mode === "failure") throw new Error(`probe failed ${secret}`);
        if (mode === "cancel") { controller.abort(new Error("cancelled")); context.signal.throwIfAborted(); }
        return { status: "passed", output: { secret: secret ?? null } };
      } } },
    });
    const document = parseWorkflowDocument({ schemaVersion: 2, resources: {
      client: { use: "fixture.client" }, evaluation: { use: "fixture.evaluation" },
      probe: { use: "fixture.probe", resources: { client: "client", evaluation: "evaluation" } },
    }, workflow: { steps: [] } });
    const plan = compileWorkflow(document, registry.ctx.evaluator.workflows, registry.pluginVersions);
    const request = { operation: "doctor", options: {} };
    const work = maintainWorkflowPlan(plan, registry, { request, signal: controller.signal,
      env: { PROBE_AUTH: 'maintenance-fixture-"private\\value' }, onEvent: event => logs.push(event.message) });
    if (mode === "success") {
      const results = await work;
      expect(results.find(result => result.provider === "fixture.probe")).toMatchObject({ status: "passed", output: { secret: "[redacted]" } });
    } else await expect(work).rejects.toThrow(mode === "failure" ? "probe failed [redacted]" : "cancelled");
    expect(events).toEqual(["open", "probe", "close"]);
    expect(logs.join("\n")).not.toContain('maintenance-fixture-"private\\value');
  } finally { await registry.dispose(); }
});

test("Jobs validates maintenance requests and locked plans without creating a run", async () => {
  const registry = await openPluginRegistry();
  try {
    let calls = 0;
    registry.ctx.evaluator.registerResource({ type: "fixture.jobs-maintenance", apiVersion: 1, version: "1", capabilities: [],
      resources: {}, validateConfig: workflowObject, async create() { throw new Error("Unexpected run"); },
      maintenance: { doctor: { resources: [], validateRequest(value) { const request = workflowObject(value); if (Object.keys(request).length) throw new Error("Unexpected options"); return request; },
        async execute() { calls++; return { status: "failed", output: { check: "missing tool" } }; } } },
    });
    const document = parseWorkflowDocument({ schemaVersion: 2, pathBase: ".", resources: { probe: { use: "fixture.jobs-maintenance" } }, workflow: { steps: [] } });
    const plan = compileWorkflow(document, registry.ctx.evaluator.workflows, registry.pluginVersions);
    const runtime = { root: ".", configDirectory: ".", signal: AbortSignal.timeout(5000), async credential() { throw new Error("Unrequested credential"); } };
    const input = { plan, maintenance: { operation: "doctor", options: {} } };
    expect(await executeWorkflowMaintenanceJob(input, registry, runtime)).toMatchObject([{ status: "failed", output: { check: "missing tool" } }]);
    await expect(executeWorkflowMaintenanceJob({ ...input, resumeRunId: "other" }, registry, runtime)).rejects.toThrow("cannot execute or resume");
    await expect(executeWorkflowMaintenanceJob({ ...input, plan: { ...plan, fingerprint: "changed" } }, registry, runtime)).rejects.toThrow("installed plugins changed");
    await expect(executeWorkflowMaintenanceJob({ ...input, maintenance: { operation: "doctor", options: { execute: true } } }, registry, runtime)).rejects.toThrow("Unexpected options");
    expect(calls).toBe(1);
  } finally { await registry.dispose(); }
});

async function benchmarkFile(environment: string) {
  const root = await mkdtemp(join(tmpdir(), "workflow-maintenance-")); roots.push(root);
  const file = join(root, "workflow.yaml");
  await writeFile(file, JSON.stringify({ schemaVersion: 2, workflow: "benchmark.evaluate", with: {
    benchmark: { name: "gsm8k", config: { hfToken: { credential: "MISSING_MAINTENANCE_DATASET" } } }, environment,
    services: { default: { model: "fixture", base_url: "http://unused.invalid", apiKeyEnv: "MISSING_MAINTENANCE_MODEL" } },
  } }));
  return file;
}

test("cleanup CLI previews by default, only --execute deletes, and requires no model or dataset credential", async () => {
  const file = await benchmarkFile("docker"), requests: boolean[] = [];
  vi.spyOn(DockerEnvironment.prototype, "cleanupImages").mockImplementation(async request => {
    requests.push(request.execute);
    return { nodeId: "local", daemonId: "fixture", items: [{ reference: "fixture", imageId: "sha256:fixture",
      status: request.execute ? "deleted" : "candidate", reason: "owned" }] };
  });
  for (const flags of [[], ["--execute"]]) {
    const output: string[] = [], errors: string[] = [];
    expect(await runCli(["cleanup", "images", file, ...flags], { out: text => output.push(text), error: text => errors.push(text) }), errors.join("\n")).toBe(0);
    expect(JSON.parse(output.join("\n")).find((item: { provider: string }) => item.provider === "benchmark.runtime")).toMatchObject({ status: "passed", output: { groups: [{ preview: flags.length === 0 }] } });
  }
  expect(requests).toEqual([false, true]);
  await expect(maintainWorkflow({ configPath: file, env: {} }, { operation: "cleanup-images", options: { execute: "yes" } })).rejects.toThrow("must be boolean");
  expect(requests).toEqual([false, true]);
});

test("doctor CLI reports missing credentials and network failures as failed checks", async () => {
  const file = await benchmarkFile("local"), output: string[] = [], errors: string[] = [];
  vi.mocked(diagnoseNetwork).mockResolvedValueOnce([{ name: "dataset", location: "fixture", target: "https://fixture.invalid", route: "direct", status: "failed", elapsedMs: 1, evidence: "unreachable" }]);
  expect(await runCli(["doctor", file], { out: text => output.push(text), error: text => errors.push(text) }), errors.join("\n")).toBe(1);
  const report = JSON.parse(output.join("\n")).find((item: { provider: string }) => item.provider === "benchmark.runtime");
  expect(report).toMatchObject({ status: "failed", output: { groups: [{ checks: expect.arrayContaining([
    expect.objectContaining({ name: "credential MISSING_MAINTENANCE_MODEL", status: "failed" }),
  ]), network: { status: "failed" } }] } });
});


test("warmup summaries survive the Jobs boundary and redact dynamically resolved credentials", async () => {
  const registry = await openPluginRegistry();
  try {
    registry.ctx.evaluator.registerResource({ type: "fixture.warmup-summary", apiVersion: 1, version: "1", capabilities: [],
      resources: {}, validateConfig: workflowObject, credentials: () => ["FIXTURE_AUTH"],
      async create() { throw new Error("Warmup created evaluation state"); },
      async warmup(_config, context) {
        const secret = await context.runtime.credential("FIXTURE_AUTH");
        return { status: "failed", output: { ready: 1, total: 2 }, summary: `Prepared 1/2: ${secret}`,
          details: [`case-b: download failed ${secret}`] };
      },
    });
    const plan = compileWorkflow(parseWorkflowDocument({ schemaVersion: 2, pathBase: ".",
      resources: { probe: { use: "fixture.warmup-summary" } }, workflow: { steps: [] } }), registry.ctx.evaluator.workflows, registry.pluginVersions);
    const results = await executeWorkflowMaintenanceJob({ plan, maintenance: { operation: "warmup", options: {} } }, registry,
      { root: ".", configDirectory: ".", signal: AbortSignal.timeout(5000), async credential() { return "dynamic-fixture-private"; } });
    expect(parseMaintenanceResults(JSON.parse(JSON.stringify(results)))).toMatchObject([{ status: "failed", output: { ready: 1, total: 2 },
      summary: "Prepared 1/2: [redacted]", details: ["case-b: download failed [redacted]"] }]);
    expect(() => parseMaintenanceResults([{ ...results[0], details: [42] }])).toThrow("Invalid maintenance details");
  } finally { await registry.dispose(); }
});
