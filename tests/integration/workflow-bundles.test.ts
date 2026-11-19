import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { parse } from "yaml";
import { exportWorkflow, readWorkflowConfiguration } from "../../src/application/workflow.js";
import { openPluginRegistry } from "../../src/application/plugins/open-registry.js";
import { parseDeployment } from "../../src/config/deployment.js";
import { bundleComposeOverride, deploymentPlan, type ServiceState } from "../../scripts/ray-smoke/ensure.mjs";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function directory() { const root = await mkdtemp(join(tmpdir(), "workflow-bundles-")); roots.push(root); return root; }

test("Benchmark groups declare their bundles and exported paths still resolve from another directory", async () => {
  const root = await directory(), configPath = join(root, "eval.yaml"), destination = join(root, "nested", "expanded.yaml");
  await mkdir(join(root, "nested"));
  await writeFile(configPath, JSON.stringify({ schemaVersion: 2, workflow: "benchmark.evaluate",
    deployment: { kind: "ray-jobs", managedLocal: true, bundles: { second: "../external-second" } }, with: {
      benchmark: { name: "gsm8k", solver: { name: "agentbundle", config: { path: "./bundles/unused-base" } } },
      services: { default: { model: "fixture", base_url: "https://model.invalid", apiKeyEnv: "MODEL_KEY" } }, scheduler: "ray",
      variants: ["first", "second", "first"].map((name, index) => ({ id: `group-${index}`, solver: { name: "agentbundle", config: { path: `./bundles/${name}` } } })),
    } }));
  const registry = await openPluginRegistry();
  try {
    const original = await readWorkflowConfiguration(configPath, registry, {});
    expect(original.deployment?.bundles).toEqual({ first: join(root, "bundles", "first"), second: join(root, "..", "external-second") });
    expect(JSON.stringify(original.plan)).not.toContain(root);
    await exportWorkflow({ configPath, env: {} }, destination);
    const exported = await readWorkflowConfiguration(destination, registry, {});
    expect(exported.deployment).toEqual(original.deployment);
    expect(exported.plan.document).toEqual(original.plan.document);
    expect(parse(await readFile(destination, "utf8")).deployment.bundles).toEqual(original.deployment?.bundles);
  } finally { await registry.dispose(); }
});

test("deployment rejects invalid bundle names and local mounts on external clusters", () => {
  expect(() => parseDeployment({ kind: "ray-jobs", managedLocal: true, bundles: { "../escape": "bundle" } })).toThrow("Bundle names");
  expect(() => parseDeployment({ kind: "ray-jobs", managedLocal: true, bundles: { bundle: 42 } })).toThrow("non-empty string");
  expect(() => parseDeployment({ kind: "ray-jobs", endpoint: "https://cluster.invalid", caFile: "cert", bundles: { bundle: "./bundle" } })).toThrow("managedLocal");
});

test("Compose mounts bundles from different parents read-only and detects changed mount sets", async () => {
  const root = await directory(), first = join(root, "first $BUNDLE_TEST_UNDEFINED"), second = join(root, "other", "second");
  for (const path of [first, second]) { await mkdir(path, { recursive: true }); await writeFile(join(path, "bundle.yaml"), "name: fixture\n"); }
  const initial = await bundleComposeOverride({ first, second }, root);
  const reversed = await bundleComposeOverride({ second, first }, root);
  expect(initial.digest).toBe(reversed.digest);
  const document = JSON.parse(await readFile(initial.path, "utf8"));
  for (const name of ["head", "worker-a", "worker-b"]) {
    expect(document.services[name].volumes).toEqual([
      { type: "bind", source: (await realpath(first)).replaceAll("$", () => "$$"), target: "/builtin-experiment/bundles/first", read_only: true, bind: { create_host_path: false } },
      { type: "bind", source: await realpath(second), target: "/builtin-experiment/bundles/second", read_only: true, bind: { create_host_path: false } },
    ]);
  }
  const states: Record<string, ServiceState> = Object.fromEntries(["head", "worker-a", "worker-b", "gateway", "coordinator", "docker-a", "docker-b"].map(name =>
    [name, { id: name, imageId: "image", running: true, health: "healthy", bundleDigest: initial.digest }]));
  expect(deploymentPlan("current", { id: "image", fingerprint: "current" }, states, initial.digest).ready).toBe(true);
  const removed = await bundleComposeOverride({ first }, root);
  expect(deploymentPlan("current", { id: "image", fingerprint: "current" }, states, removed.digest).ready).toBe(false);
  await expect(bundleComposeOverride({ missing: join(root, "missing") }, root)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(bundleComposeOverride({ bad: "relative" }, root)).rejects.toThrow("absolute source");
});
