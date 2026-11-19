import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { stringify } from "yaml";
import { exportWorkflow, inspectWorkflow, readWorkflowConfiguration } from "../../src/application/workflow.js";
import { warmupWorkflowPlan } from "../../src/application/workflow-warmup.js";
import { openPluginRegistry } from "../../src/application/plugins/open-registry.js";
import { compileWorkflow } from "../../src/core/workflow/compile.js";
import { parseWorkflowDocument } from "../../src/config/workflow-schema.js";
import { workflowPlanCredentialNames } from "../../src/core/workflow/credentials.js";
import { networkRuntimeProvider, openWorkflowNetwork, requireNetwork } from "../../src/plugins/resources/network-runtime.js";
import { NetworkRuntime } from "../../src/infrastructure/network/runtime.js";
import { runCli } from "../../src/cli/main.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close(); });

test("network files export unresolved references and credential values do not change the plan", async () => {
  const root = await mkdtemp(join(tmpdir(), "workflow-network-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const configPath = join(root, "workflow.yaml"), networkConfigPath = join(root, "network.yaml"), exported = join(root, "expanded.yaml");
  const template = { proxy: { https: "${CUSTOM_PROXY}" }, sources: { huggingface: "${DATA_ENDPOINT}" } };
  await writeFile(networkConfigPath, stringify(template));
  await writeFile(configPath, stringify({ schemaVersion: 2, workflow: "application.evaluate", with: { model: { model: "fixture", endpoint: "https://model.example/v1" }, cases: [] } }));
  const options = { configPath, networkConfigPath, env: {} };
  const plan = await inspectWorkflow(options);
  const changedCredentials = await inspectWorkflow({ ...options, env: { CUSTOM_PROXY: "http://user:private-value@proxy.example:8080", HTTP_PROXY: "http://node-proxy:8080" } });
  expect(changedCredentials.fingerprint).toBe(plan.fingerprint);
  const output: string[] = [], errors: string[] = [];
  expect(await runCli(["inspect", configPath, "--network", networkConfigPath],
    { out: text => output.push(text), error: text => errors.push(text) }), errors.join("\n")).toBe(0);
  expect(JSON.parse(output.join("\n")).document).toEqual(plan.document);
  await exportWorkflow(options, exported);
  expect((await inspectWorkflow({ configPath: exported, env: {} })).document).toEqual(plan.document);
  const text = await readFile(exported, "utf8");
  expect(text).toContain("${CUSTOM_PROXY}");
  expect(text).not.toContain("private-value");
  const registry = await openPluginRegistry();
  try { expect(workflowPlanCredentialNames(plan, registry.ctx.evaluator.workflows)).toEqual(expect.arrayContaining(["CUSTOM_PROXY", "DATA_ENDPOINT", "HTTP_PROXY"])); }
  finally { await registry.dispose(); }
});

test("network template validation defers referenced image methods until execution", async () => {
  const template = { docker: { benchmarks: { fixture: { method: "${IMAGE_METHOD}", provider: "huggingface", baseUrl: "${IMAGE_ARCHIVE}" } } } };
  expect(networkRuntimeProvider.validateConfig({ template })).toEqual({ template });
  const env: Record<string, string> = { IMAGE_METHOD: "archive", IMAGE_ARCHIVE: "https://images.example/archive" };
  const runtime = { directory: ".", resolvePath: (path: string) => path, credential: async (name: string) => env[name] };
  const network = await openWorkflowNetwork(template, { runtime });
  try { expect(network.settings.docker.benchmarks.fixture).toMatchObject({ method: "archive", provider: "huggingface" }); }
  finally { await network.dispose(); }
  env.IMAGE_METHOD = "invalid";
  await expect(openWorkflowNetwork(template, { runtime })).rejects.toThrow("method must be");
});

test("network clients resolve node credentials asynchronously and retain their source template", async () => {
  const template = { proxy: { https: "${CUSTOM_PROXY}" }, sources: { huggingface: "https://saved.example" } };
  const env: Record<string, string> = { CUSTOM_PROXY: "http://worker:worker-password@proxy.example:8080", HF_ENDPOINT: "https://node.example" };
  const network = await openWorkflowNetwork(template, { runtime: { directory: ".", resolvePath: path => path, credential: async name => env[name] } });
  try {
    expect(network.settings.proxy.host.https).toBe(env.CUSTOM_PROXY);
    expect(network.sourceUrl("https://huggingface.co/datasets/a")).toBe("https://node.example/datasets/a");
    expect(JSON.stringify(network.document.template)).not.toContain("worker-password");
    expect(network.secrets).toContain("worker-password");
  } finally { await network.dispose(); }
});

test.each([
  [{ sources: { unknown: "https://example.com" } }, "Unknown"],
  [{ proxy: { https: 12 } }, "URL"],
  [{ proxy: { https: "http://user:literal-secret@proxy.example" } }, "credentials"],
  [{ sources: { python: { extraIndexes: "${EXTRA_INDEX}" } } }, "array"],
])("network validation rejects invalid templates before execution: %j", (template, message) => {
  expect(() => networkRuntimeProvider.validateConfig({ template })).toThrow(String(message));
});

test.each(["success", "failure", "cancel"])("warmup uses distinct network dependencies and releases clients after %s", async mode => {
  const registry = await openPluginRegistry(), seen: string[] = [], messages: string[] = [];
  const controller = new AbortController();
  const dispose = vi.spyOn(NetworkRuntime.prototype, "dispose");
  try {
    registry.ctx.evaluator.registerResource({ type: "fixture.prepare-network", apiVersion: 1, version: "1", capabilities: [], sharing: "shared",
      resources: { network: { capability: "network.access/v1" } }, validateConfig: () => ({}),
      async create() { throw new Error("Evaluation resources must not be created by warmup"); }, async recover() {},
      async warmup(_config, context) {
        seen.push(requireNetwork(context.resource("network")).settings.sources.huggingface);
        context.log("fixture-proxy-password");
        if (seen.length === 2) {
          if (mode === "cancel") controller.abort(new Error("fixture warmup cancelled"));
          context.signal.throwIfAborted();
          if (mode === "failure") throw new Error("fixture warmup failed");
        }
      },
    });
    const document = parseWorkflowDocument({ schemaVersion: 2, workflow: { resources: {
      firstNetwork: { use: "network.runtime", scope: "run", config: { template: { value: { sources: { huggingface: "https://first.example" } } } } },
      secondNetwork: { use: "network.runtime", scope: "run", config: { template: { value: { sources: { huggingface: "https://second.example" } } } } },
      first: { use: "fixture.prepare-network", scope: "run", resources: { network: "firstNetwork" } },
      second: { use: "fixture.prepare-network", scope: "run", resources: { network: "secondNetwork" } },
    }, steps: [] } });
    const plan = compileWorkflow(document, registry.ctx.evaluator.workflows);
    const result = warmupWorkflowPlan(plan, registry, { signal: controller.signal,
      env: { HTTPS_PROXY: "http://user:fixture-proxy-password@proxy.example" }, onEvent: event => { messages.push(event.message); } });
    if (mode === "failure") await expect(result).rejects.toThrow("fixture warmup failed");
    else if (mode === "cancel") await expect(result).rejects.toThrow("fixture warmup cancelled");
    else await result;
    expect(messages.join("\n")).not.toContain("fixture-proxy-password");
    expect(seen).toEqual(["https://first.example", "https://second.example"]);
    expect(dispose).toHaveBeenCalledTimes(2);
  } finally { await registry.dispose(); }
});


test("network file origins stay local and do not change the compiled plan", async () => {
  const root = await mkdtemp(join(tmpdir(), "workflow-network-origins-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const configPath = join(root, "named-experiment.yaml"), first = join(root, "first-network.yaml"), second = join(root, "second-network.yaml");
  await writeFile(configPath, stringify({ schemaVersion: 2, workflow: "application.evaluate", with: {
    model: { model: "fixture", endpoint: "https://unused.invalid" }, cases: [],
  } }));
  for (const file of [first, second]) await writeFile(file, "{}");
  const registry = await openPluginRegistry();
  try {
    const a = await readWorkflowConfiguration(configPath, registry, {}, first);
    const b = await readWorkflowConfiguration(configPath, registry, {}, second);
    expect(a.plan).toEqual(b.plan);
    expect(a.origins.configurationFile).toBe(configPath);
    expect(Object.values(a.origins.resourceFiles)).toEqual([first]);
    expect(Object.values(b.origins.resourceFiles)).toEqual([second]);
    expect(JSON.stringify(a.plan)).not.toContain("first-network.yaml");
    expect(JSON.stringify(a.plan)).not.toContain("named-experiment.yaml");
  } finally { await registry.dispose(); }
});
