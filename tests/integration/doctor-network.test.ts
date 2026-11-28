import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse, stringify } from "yaml";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { Evaluator } from "arsi-evaluator";
import { runCli, parseArgs } from "../../src/cli/main.js";
import { diagnoseNetwork } from "../../src/infrastructure/network/diagnostics.js";
import { openPluginRegistry } from "../../src/application/plugins/open-registry.js";
import { readWorkflowConfiguration } from "../../src/application/workflow.js";
import { maintainWorkflowPlan } from "../../src/application/workflow-maintenance.js";
import { defaultNetworkConfigPath } from "../../src/config/network.js";

vi.mock("../../src/infrastructure/network/diagnostics.js", () => ({ diagnoseNetwork: vi.fn() }));
const roots: string[] = [];
const experiment = stringify({ schemaVersion: 2, workflow: "benchmark.evaluate", with: {
  services: { default: { model: "fixture", base_url: "https://model.invalid/v1", apiKeyEnv: "TEST_KEY" } },
  benchmark: "gsm8k", environment: "local",
} });
function doctorReport(text: string) { return JSON.parse(text).find((row: { provider: string }) => row.provider === "benchmark.runtime").output.groups[0]; }
function networkTemplate(text: string) { return JSON.parse(text).document.workflow.resources.coordinatorNetwork.config.template.value; }
beforeEach(() => vi.stubEnv("TEST_KEY", "fixture-secret"));
afterEach(async () => { vi.resetAllMocks(); vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

test("doctor creates the default YAML and names the failed field and recommendation", async () => {
  vi.mocked(diagnoseNetwork).mockImplementation(async (_network, _signal, options) => {
    const probe = { name: "huggingface", location: "fixture", target: "https://huggingface.co/test", route: "direct",
      status: "failed" as const, elapsedMs: 1, evidence: "connect ECONNREFUSED", guidance: { yamlFields: ["sources.huggingface"], action: "Change the source and retry doctor" } };
    options?.progress?.(probe);
    return [probe];
  });
  const root = await mkdtemp(join(tmpdir(), "doctor-network-default-")); roots.push(root);
  const file = join(root, "experiment.yaml");
  await writeFile(file, experiment);
  const out: string[] = [], errors: string[] = [];
  expect(await runCli(["doctor", file], { out: text => out.push(text), error: text => errors.push(text) })).toBe(1);
  const report = doctorReport(out.at(-1)!);
  expect(report.network.retryCommand).toContain(file);
  expect(report.network).toMatchObject({ configPath: defaultNetworkConfigPath(), status: "failed",
    recommendedCommand: expect.stringContaining("--network"), probes: [expect.objectContaining({ name: "huggingface" })] });
  const defaultConfig = parse(await readFile(defaultNetworkConfigPath(), "utf8"));
  expect(defaultConfig).toMatchObject({ sources: { huggingface: "https://huggingface.co" } });
  expect(errors.join("\n")).toContain(defaultNetworkConfigPath());
  expect(errors.join("\n")).toContain("sources.huggingface");
  expect(errors.join("\n")).toContain("mirrors.yaml");
  expect(() => parseArgs(["doctor"])).toThrow();
}, 30000);

test("experiment doctor preserves configuration checks and uses the selected network YAML", async () => {
  const root = await mkdtemp(join(tmpdir(), "doctor-network-")); roots.push(root);
  await mkdir(join(root, "data"));
  const file = join(root, "experiment.yaml"), network = join(root, "network.yaml");
  await writeFile(file, experiment);
  await writeFile(network, "sources:\n  huggingface: https://hub.test\n");
  vi.mocked(diagnoseNetwork).mockImplementation(async (runtime, _signal, options) => {
    expect(runtime.settings.sources.huggingface).toBe("https://hub.test");
    expect(options.plan).toEqual({ host: ["huggingface"], docker: false, dockerBuild: false });
    return [];
  });
  const out: string[] = [], errors: string[] = [];
  expect(await runCli(["doctor", file, "--network", network], { out: text => out.push(text), error: text => errors.push(text) }), errors.join("\n")).toBe(0);
  expect(doctorReport(out.at(-1)!)).toMatchObject({ checks: expect.arrayContaining([expect.objectContaining({ name: "configuration", status: "passed" })]),
    network: { configPath: resolve(network), status: "passed" } });
  const options = { configPath: file, networkConfigPath: network, env: { TEST_KEY: "sdk-only-key" } };
  const evaluator = new Evaluator();
  await expect(evaluator.doctor({ ...options, env: {} })).rejects.toThrow(/TEST_KEY/);
  const { checks, network: networkReport } = doctorReport(out.at(-1)!);
  expect(await evaluator.doctor(options)).toEqual({ checks, network: networkReport });
  vi.mocked(diagnoseNetwork).mockResolvedValue([{ name: "cached", location: "host", target: "fixture", route: "direct", status: "not-checked", elapsedMs: 0, evidence: "cache" }]);
  expect((await evaluator.doctor(options)).network.status).toBe("incomplete");
  expect(await runCli(["doctor", file, "--network", network], { out: () => {}, error: () => {} })).toBe(1);
});

test("SDK doctor preserves cancellation and redacts configuration aliases on load failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "sdk-doctor-invalid-")); roots.push(root);
  const configPath = join(root, "experiment.yaml"), networkConfigPath = join(root, "network.yaml");
  await writeFile(configPath, JSON.stringify({
    benchmark: "gsm8k",
    services: { default: { model: "fixture", base_url: "https://model.invalid/v1", api_key: "${CUSTOM_ALIAS}" } },
  }));
  await writeFile(networkConfigPath, "{}\n");
  const value = "private-fixture-value";
  const options = { configPath, networkConfigPath, patchPath: join(root, value + ".yaml"), env: { CUSTOM_ALIAS: value } };
  const signal = AbortSignal.abort(new Error("doctor cancelled"));
  const evaluator = new Evaluator();
  await expect(evaluator.doctor({ ...options, signal })).rejects.toBe(signal.reason);
  const outcome = evaluator.doctor(options);
  await expect(outcome).rejects.toThrow(/\[redacted\]/);
  await expect(outcome).rejects.not.toThrow(value);
});

test.each([
  ["gsm8k local data", "benchmark:\n  name: gsm8k\n  config:\n    localPath: ./data\nenvironment: local\n",
    { host: [], docker: false, dockerBuild: false }],
  ["Terminal-Bench 4 archive", "benchmark:\n  name: terminalbench\n  version: '4.0'\nenvironment: docker\n",
    { host: ["npm"], docker: true, dockerBuild: false,
      datasetUrl: "https://github.com/harbor-framework/terminal-bench/releases/download/v4.0.0/terminal-bench-prebuilt-v4.0.0.tar.gz" }],
] as const)("doctor scopes probes to %s", async (_label, experiment, plan) => {
  const root = await mkdtemp(join(tmpdir(), "doctor-probe-plan-")); roots.push(root);
  await mkdir(join(root, "data"));
  const file = join(root, "experiment.yaml");
  await writeFile(file, JSON.stringify({ schemaVersion: 2, workflow: "benchmark.evaluate", with: {
    services: { default: { model: "fixture", base_url: "https://model.invalid/v1", apiKeyEnv: "TEST_KEY" } }, ...parse(experiment),
  } }));
  vi.mocked(diagnoseNetwork).mockResolvedValue([]);
  await runCli(["doctor", file], { out: () => {}, error: () => {} });
  expect(diagnoseNetwork).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ plan }));
});


test.each(["", "# default sources\n", "{}\n"])("inspect accepts an empty network file (%j) without download probes", async content => {
  const root = await mkdtemp(join(tmpdir(), "inspect-network-")); roots.push(root);
  const file = join(root, "experiment.yaml"), network = join(root, "network.yaml");
  await writeFile(file, experiment);
  await writeFile(network, content);
  const out: string[] = [], errors: string[] = [];
  expect(await runCli(["inspect", file, "--network", network], { out: text => out.push(text), error: text => errors.push(text) }), errors.join("\n")).toBe(0);
  expect(diagnoseNetwork).not.toHaveBeenCalled();
  expect(networkTemplate(out.at(-1)!)).toEqual({});
  expect(out.join("\n")).not.toContain("fixture-secret");
});

test("inspect retains the network template and never expands proxy credentials", async () => {
  const root = await mkdtemp(join(tmpdir(), "inspect-network-env-")); roots.push(root);
  const file = join(root, "experiment.yaml"), network = join(root, "network.yaml");
  await writeFile(file, experiment);
  await writeFile(network, "proxy:\n  https: http://yaml.test\nsources:\n  huggingface: https://yaml.test\n");
  vi.stubEnv("HTTPS_PROXY", "http://user:proxy-secret@env.test");
  vi.stubEnv("HF_ENDPOINT", "https://env.test");
  const out: string[] = [], errors: string[] = [];
  expect(await runCli(["inspect", file, "--network", network], { out: text => out.push(text), error: text => errors.push(text) }), errors.join("\n")).toBe(0);
  expect(networkTemplate(out.at(-1)!)).toEqual({ sources: { huggingface: "https://yaml.test" }, proxy: { https: "http://yaml.test" } });
  expect(out.join("\n")).not.toContain("proxy-secret");
  expect(diagnoseNetwork).not.toHaveBeenCalled();
});


test("maintenance without submitting-host origins never invents configuration filenames", async () => {
  const root = await mkdtemp(join(tmpdir(), "doctor-no-origins-")); roots.push(root);
  const file = join(root, "experiment.yaml"), network = join(root, "network.yaml");
  await writeFile(file, experiment); await writeFile(network, "{}");
  vi.mocked(diagnoseNetwork).mockResolvedValue([{ name: "download", location: "worker", target: "https://unused.invalid", route: "direct",
    status: "failed", elapsedMs: 1, evidence: "connect ECONNREFUSED" }]);
  const registry = await openPluginRegistry(), messages: string[] = [];
  try {
    const { plan } = await readWorkflowConfiguration(file, registry, process.env, network);
    const results = await maintainWorkflowPlan(plan, registry, { request: { operation: "doctor", options: {} },
      onEvent: event => messages.push(event.message) });
    const report = doctorReport(JSON.stringify(results));
    expect(report.network).toMatchObject({ configPath: null, retryCommand: null, recommendedCommand: null });
    expect(messages.join("\n")).toContain("submitting configuration");
    expect(messages.join("\n")).not.toContain("--network 'template'");
    expect(messages.join("\n")).not.toContain("workflow.yaml");
  } finally { await registry.dispose(); }
});
