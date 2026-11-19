import { dirname, join, resolve } from "node:path";
import { expect, test } from "vitest";
import { readWorkflowConfiguration } from "../../src/application/workflow.js";
import { openPluginRegistry } from "../../src/application/plugins/open-registry.js";
import { parseEffectiveConfig } from "../../src/config/effective.js";
import { expectRecord } from "../../src/core/validation/input.js";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { parse } from "yaml";
import { resolveManagedLocalBundlePath } from "../../src/application/ray/managed-local.js";
import { AgentBundleSolver, parseAgentBundleConfig } from "../../src/plugins/solvers/agentbundle.js";

const playbook = (file: string) => resolve("playbook", file.startsWith("deepswe") ? "deepswe" : "workbuddy", file);

const environment = {
  JUDGE_MODEL_NAME: "judge",
  JUDGE_MODEL_ENDPOINT: "https://judge.invalid/v1",
  JUDGE_MODEL_API_KEY: "judge-secret",
  MODEL_NAME: "controlled-model",
  MODEL_ENDPOINT: "https://example.invalid/v1",
  MODEL_API_KEY: "controlled-secret",
  EVALUATOR_JOBS_TOKEN: "controlled-jobs-token",
};

async function configuration(path: string, env: NodeJS.ProcessEnv = environment) {
  const registry = await openPluginRegistry();
  try {
    const result = await readWorkflowConfiguration(path, registry, env, resolve("playbook/network/official.yaml"));
    const binding = result.plan.document.workflow.resources.benchmark?.config.experiment;
    if (!binding || !("value" in binding)) throw new Error("Missing Benchmark configuration");
    return { ...result, experiment: parseEffectiveConfig(expectRecord(binding.value, "Benchmark configuration")) };
  } finally { await registry.dispose(); }
}

test.each([
  ["deepswe-simpleagent.yaml", "local", "simpleagent"],
  ["deepswe-ray.yaml", "ray", "simpleagent"],
  ["deepswe-agentbundle-ray.yaml", "ray", "agentbundle"],
] as const)("DeepSWE playbook %s selects Harbor with the %s scheduler and %s solver", async (file, scheduler, solver) => {
  const loaded = await configuration(playbook(file), environment);
  expect(loaded.experiment).toMatchObject({
    benchmark: { name: "harbor", config: { dataset: "deepswe@1.1", source: { kind: "github" }, scoring: { errorValues: [-1] } } },
    environment: { name: "docker" },
    solver: { name: solver },
    scheduler: { name: scheduler },
  });
  if (scheduler === "ray") {
    expect(loaded.experiment.scheduler.config).toMatchObject({ concurrency: 2, deployment: "ray-jobs" });
    expect(loaded.deployment).toMatchObject({ kind: "ray-jobs", managedLocal: true });
  }
  expect(loaded.experiment.run).toMatchObject({ taskIds: null, maxTasks: null });
  expect(loaded.experiment.run?.timeoutSeconds).toBe(18000);
  expect(JSON.stringify(loaded.plan)).not.toContain("controlled-secret");
});

test("DeepSWE playbooks keep the original model endpoint while isolated containers see a mapped one", async () => {
  const loaded = await configuration(resolve("playbook/deepswe/deepswe-simpleagent.yaml"), environment);
  expect(loaded.experiment.services.default).toMatchObject({ endpoint: "https://example.invalid/v1" });
});

test("explicit Ray Client configuration compiles a direct connection without Jobs deployment", async () => {
  const root = await mkdtemp(join(tmpdir(), "deepswe-config-"));
  try {
    const input = parse(await readFile(playbook("deepswe-ray.yaml"), "utf8"));
    input.with.scheduler = { name: "ray", config: { endpoint: "local", concurrency: 1,
      collector: { certFile: "cert.pem", keyFile: "key.pem" } } };
    const file = join(root, "direct.yaml");
    await writeFile(file, JSON.stringify(input));
    const loaded = await configuration(file);
    expect(loaded.deployment).toBeUndefined();
    expect(loaded.plan.document.workflow.resources.ray?.config.endpoint).toEqual({ value: "local" });
    expect(loaded.plan.document.workflow.resources.benchmarkExecutor?.use).toBe("benchmark.ray-executor");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("the DeepSWE DSH bundle verifies with pinned provenance", async () => {
  const loaded = await configuration(resolve("playbook/deepswe/deepswe-agentbundle-ray.yaml"), environment);
  expect(parseAgentBundleConfig(loaded.experiment.solver.config)).toEqual({ path: "./bundles/dsh-deepswe" });
  const model = loaded.experiment.services.default;
  if (!model) throw new Error("Missing default service");
  const auth = { value: environment.MODEL_API_KEY, reference: "MODEL_API_KEY" };
  const bundle = resolve("tests/fixtures/agentbundle/dsh-deepswe");
  const solver = new AgentBundleSolver(bundle, model, auth, { installation: async () => ({ id: "fixture-dsh", files: [], commands: [], probes: [] }) });
  const provenance = await solver.provenance(AbortSignal.timeout(15_000));
  expect(provenance).toMatchObject({ harness: "dsh", harnessVersion: "0.2.2-rc.1" });
  expect(provenance.bundle).toMatch(/^sha256:[a-f0-9]{64}$/u);
});

test.each([
  ["deepswe-agentbundle-ray.yaml", "dsh-deepswe"],
  ["workbuddy-code-agentbundle-ray.yaml", "dsh-workbuddy-code"],
  ["workbuddy-office-agentbundle-ray.yaml", "dsh-workbuddy-office"],
  ["workbuddy-sec-agentbundle-ray.yaml", "dsh-workbuddy-sec"],
  ["workbuddy-web-agentbundle-ray.yaml", "dsh-workbuddy-web"],
] as const)("built-in %s declares its fixture bundle path explicitly", async (file, bundle) => {
  const loaded = await configuration(playbook(file), environment);
  const config = parseAgentBundleConfig(loaded.experiment.solver.config);
  expect(config.path).toBe(`./bundles/${bundle}`);
  expect(resolveManagedLocalBundlePath(dirname(playbook(file)), config.path)).toBe(
    resolve("tests/fixtures/agentbundle", bundle),
  );
});

test("the built-in pi Ray playbook resolves the sibling product bundle", async () => {
  const loaded = await configuration(resolve("playbook/workbuddy/workbuddy-office-pi-ray.yaml"), environment);
  const config = parseAgentBundleConfig(loaded.experiment.solver.config);
  expect(config).toMatchObject({
    path: "./bundles/pi",
    pi: { settings: { version: 1, office: { enabled: true, readOnly: false } } },
  });
  expect(resolveManagedLocalBundlePath(dirname(playbook("workbuddy-office-pi-ray.yaml")), config.path)).toBe(
    resolve("../pi/bundles/pi"),
  );
});

test("the local pi playbook uses the same AgentBundle Pi adapter", async () => {
  const loaded = await configuration(resolve("playbook/workbuddy/workbuddy-office-pi.yaml"), environment);
  expect(loaded.experiment.solver.name).toBe("agentbundle");
  expect(parseAgentBundleConfig(loaded.experiment.solver.config)).toMatchObject({
    path: "../../../pi/bundles/pi",
    pi: { settings: { version: 1, office: { enabled: true, readOnly: false } } },
  });
  expect(loaded.experiment.scheduler).toMatchObject({ name: "local", config: { concurrency: 1 } });
});

test("managed local bundle mapping includes classified playbooks and excludes sibling directories", () => {
  expect(resolveManagedLocalBundlePath(resolve("playbook/deepswe"), "./bundles/dsh-deepswe"))
    .toBe(resolve("tests/fixtures/agentbundle/dsh-deepswe"));
  expect(resolveManagedLocalBundlePath(resolve("playbook-other/deepswe"), "./bundles/dsh-deepswe"))
    .toBe(resolve("playbook-other/deepswe/bundles/dsh-deepswe"));
});

test.each(["workbuddy-web-simpleagent.yaml", "workbuddy-web-ray.yaml", "workbuddy-web-agentbundle-ray.yaml"])("%s binds an independent judge service and redacts both credentials", async file => {
  const loaded = await configuration(playbook(file), environment);
  expect(loaded.experiment.benchmark.name).toBe("harbor");
  expect(loaded.experiment.verifier).toMatchObject({ name: "harbor-python", service: "judge" });
  expect(loaded.experiment.services.judge).toMatchObject({ name: "judge", endpoint: "https://judge.invalid/v1" });
  expect(JSON.stringify(loaded.plan)).toContain("JUDGE_MODEL_API_KEY");
  expect(JSON.stringify(loaded.plan)).not.toContain("judge-secret");
  expect(JSON.stringify(loaded.plan)).not.toContain("controlled-secret");
  const missing = { ...environment, JUDGE_MODEL_API_KEY: undefined };
  expect((await configuration(playbook(file), missing)).plan).toEqual(loaded.plan);
});

test.each([
  "workbuddy-office-ray.yaml", "workbuddy-office-agentbundle-ray.yaml",
  "workbuddy-office-pi.yaml", "workbuddy-office-pi-ray.yaml",
  "workbuddy-office-dify.yaml", "workbuddy-code-simpleagent.yaml",
  "workbuddy-code-ray.yaml", "workbuddy-code-agentbundle-ray.yaml",
  "workbuddy-sec-simpleagent.yaml", "workbuddy-sec-ray.yaml", "workbuddy-sec-agentbundle-ray.yaml",
])("%s preserves upstream programmatic grading without judge credentials", async file => {
  const loaded = await configuration(playbook(file), {
    ...environment, JUDGE_MODEL_NAME: undefined, JUDGE_MODEL_ENDPOINT: undefined, JUDGE_MODEL_API_KEY: undefined,
    DIFY_BASE_URL: "https://dify.invalid",
    DIFY_BUNDLE_PATH: resolve(".scratch/dify-bundle"), DIFY_REGISTRY_PATH: resolve(".scratch/dify-registry.json"),
  });
  expect(loaded.experiment.verifier?.service).toBeUndefined();
  expect(loaded.experiment.services.judge).toBeUndefined();
  if (!file.includes("-sec-")) {
    expect(loaded.experiment.verifier).toMatchObject({ name: "harbor-python", config: { requireService: false } });
  }
});
