import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { stringify } from "yaml";
import { inspectWorkflow, exportWorkflow } from "../../src/application/workflow.js";
import { benchmarkExperiment } from "../fixtures/workflow/benchmark-plan.js";
import { createNativeResource } from "../../src/plugins/workflows/benchmark/component-resource.js";
import { openPluginRegistry } from "../../src/application/plugins/open-registry.js";
import { runCli } from "../../src/cli/main.js";
import { parseUserConfig } from "../../src/config/user-schema.js";
import { resolveConfig } from "../../src/config/resolve.js";
import { parseConfigProfile } from "../../src/config/profile-schema.js";
import { assertJsonValue } from "../../src/core/validation/input.js";
import { fingerprintConfig, fingerprintResumeConfig } from "../../src/core/results/run-manifest.js";
import { projectRemoteJob, validateRemoteJob } from "../../src/infrastructure/ray/protocol.js";

vi.setConfig({ testTimeout: 30_000 });
const roots: string[] = [];
const services = { default: { model: "fixture/model", base_url: "http://127.0.0.1:8000/v1", api_key: "${HARDWARE_TEST_KEY}" } };
const env = { ...process.env, HARDWARE_TEST_KEY: "fixture-key" };
function resumeFingerprint(value: unknown): string { assertJsonValue(value); return fingerprintResumeConfig(value); }
function fingerprint(value: unknown): string { assertJsonValue(value); return fingerprintConfig(value); }
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function configFile(value: Record<string, unknown>) {
  const root = await mkdtemp(join(tmpdir(), "hardware-config-")); roots.push(root);
  const file = join(root, "experiment.yaml");
  await writeFile(file, stringify({ schemaVersion: 2, workflow: "benchmark.evaluate", with: { services: { default: { model: "fixture/model", base_url: "http://127.0.0.1:8000/v1", apiKeyEnv: "HARDWARE_TEST_KEY" } }, benchmark: "agentx", ...value } }));
  return { root, file };
}

test.each([undefined, "npu", "gpu"] as const)("hardware %s survives loading, export, persistence and plugin creation", async hardware => {
  const { root, file } = await configFile(hardware === undefined ? {} : { hardware });
  const plan = await inspectWorkflow({ configPath: file, env });
  const experiment = benchmarkExperiment(plan);
  const expected = hardware ?? "npu";
  expect(experiment.hardware).toBe(expected);
  const exported = join(root, "export.yaml");
  await exportWorkflow({ configPath: file, env }, exported);
  expect(benchmarkExperiment(await inspectWorkflow({ configPath: exported, env })).hardware).toBe(expected);
  const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected network access"));
  const registry = await openPluginRegistry();
  try {
    await createNativeResource(registry.ctx, "solver", experiment.solver, {
      configDirectory: root, resolvePath: path => join(root, path), hardware: expected,
      services: { default: { model: experiment.services.default!, auth: { value: "fixture-key", reference: null } } }, solverService: "default",
    });
  } finally { await registry.dispose(); }
  expect(fetch).not.toHaveBeenCalled();
});

test.each([null, "GPU", "cuda", "cpu", "", 0, {}, []])("rejects invalid hardware %j", hardware => {
  expect(() => parseUserConfig({ services, benchmark: "agentx", hardware })).toThrow("hardware must be npu or gpu");
});

test("Profile hardware defaults apply unless overridden by YAML", () => {
  const profile = parseConfigProfile({ id: "fixture", role: "benchmark", defaults: { hardware: "gpu" } });
  expect(resolveConfig("experiment.yaml", parseUserConfig({ services, benchmark: "fixture" }), [profile]).hardware).toBe("gpu");
  expect(resolveConfig("experiment.yaml", parseUserConfig({ services, benchmark: "fixture", hardware: "npu" }), [profile]).hardware).toBe("npu");
});

test("historical NPU config fingerprint is preserved; GPU cannot resume it", async () => {
  const experiment = resolveConfig("experiment.yaml", parseUserConfig({ services, benchmark: "agentx" }), []);
  const historical = { ...experiment, services: { default: { ...experiment.services.default, apiKey: "${HARDWARE_TEST_KEY}" } } };
  delete historical.hardware;
  const { output: _output, ...original } = historical;
  expect(resumeFingerprint(historical)).toBe(fingerprint(original));
  expect(resumeFingerprint({ ...historical, hardware: "npu" })).toBe(fingerprint(original));
  expect(resumeFingerprint({ ...historical, hardware: "gpu" })).not.toBe(fingerprint(original));
  expect(resumeFingerprint({ ...historical, hardware: "npu", network: { benchmarkName: "fixture", template: {} } })).toBe(fingerprint(original));
  expect(resumeFingerprint({ ...historical, hardware: "gpu", network: { benchmarkName: "fixture", template: {} } }))
    .toBe(resumeFingerprint({ ...historical, hardware: "gpu" }));
});

test.each(["npu", "gpu"] as const)("Ray job preserves %s and rejects invalid wire values", async hardware => {
  const config = resolveConfig("experiment.yaml", parseUserConfig({ services, benchmark: "fixture", hardware }), []);
  const network = { benchmarkName: "fixture", template: { sources: { huggingface: "https://hf.example" } } };
  const job = projectRemoteJob({ config, network,
    job: { runId: "run", taskId: "task", attemptId: "attempt", ref: { id: "task", recordKey: "task" }, configFingerprint: "config" },
    run: { runId: "run", configFingerprint: "config", pluginVersions: {}, source: { source: "fixture", revision: "1", files: [], metadata: {} } },
    packageDigest: `sha256:${"a".repeat(64)}`, uploadEndpoint: "https://collector.invalid", previousAttempts: [] });
  const restored = validateRemoteJob(JSON.parse(JSON.stringify(job)));
  expect(restored.safeConfig.hardware).toBe(hardware);
  expect(restored.safeConfig.network).toEqual(network);
  expect(() => validateRemoteJob({ ...job, safeConfig: { ...job.safeConfig, hardware: "cuda" } })).toThrow("hardware");
  const old = structuredClone(job); delete old.safeConfig.hardware;
  expect(validateRemoteJob(old).safeConfig.hardware).toBeUndefined();
});



test.each([
  ["playbook/kernel/existing.yaml", "npu"],
  ["playbook/agentx/agentx-gpu-api.yaml", "gpu"],
] as const)("hardware example %s resolves without hardware or model access", async (file, hardware) => {
  const plan = await inspectWorkflow({ configPath: file, env: { ...env, MODEL_NAME: "fixture/model", MODEL_ENDPOINT: "http://127.0.0.1:8000/v1",
    MODEL_API_KEY: "fixture-key", KERNEL_MANIFEST: "missing.json", KERNEL_EVAL_PYTHON: "python", KERNEL_EVAL_PLACEHOLDER: "unused" } });
  expect(benchmarkExperiment(plan).hardware).toBe(hardware);
});

test.each([undefined, { vllm: { endpoint: "http://127.0.0.1:8000/metrics" } }])("GPU AgentX supports API replay and engine telemetry %j", async telemetry => {
  const { file } = await configFile({ hardware: "gpu", benchmark: { name: "agentx", solver: { config: telemetry ? { telemetry } : {} } } });
  const experiment = benchmarkExperiment(await inspectWorkflow({ configPath: file, env }));
  expect(experiment.hardware).toBe("gpu");
  expect(experiment.solver.config.telemetry).toEqual(telemetry);
});

test.each([
  { name: "kernel", config: { manifest: "missing.json" } },
  { name: "agentx", solver: { config: { telemetry: { ascend: { mode: "local", devices: [{ deviceId: 0 }] } } } } },
  { name: "agentx", solver: { config: { telemetry: { ascend: { endpoint: "http://127.0.0.1:9999/metrics", deviceId: 0, chipId: 0 } } } } },
])("GPU rejects unsupported combination before source/model/device work: %j", async benchmark => {
  const { file } = await configFile({ hardware: "gpu", benchmark });
  vi.stubEnv("HARDWARE_TEST_KEY", "fixture-key");
  const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected network request"));
  for (const args of [["doctor", file], ["run", file, "--dry-run"], ["run", file]]) {
    const messages: string[] = [];
    const code = await runCli(args, { out: message => { messages.push(message); }, error: message => { messages.push(message); } });
    expect(code).not.toBe(0);
    expect(messages.join("\n")).toMatch(/Kernel GPU backend is not implemented|telemetry.ascend requires hardware=npu/);
    expect(messages.join("\n")).not.toContain("ENOENT");
  }
  expect(fetch).not.toHaveBeenCalled();
});
