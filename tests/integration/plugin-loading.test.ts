import { hasNativeResource, registerNativeResource } from "arsi-evaluator";
import { join, resolve } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { afterEach, describe, expect, test } from "vitest";

import { createNativeResource, prepareNativeResource } from "../../src/plugins/workflows/benchmark/component-resource.js";
import { inspectWorkflow, runWorkflow } from "../../src/application/workflow.js";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { loadPluginPatch } from "../../src/config/plugin-patch.js";
import { loadPluginModule } from "../../src/application/plugins/load-module.js";
import { openPluginRegistry } from "../../src/application/plugins/open-registry.js";
import { apply as registryPlugin } from "../../src/application/plugins/registry.js";
import { LocalEnvironment } from "../../src/plugins/environments/local/environment.js";
import { DockerEnvironment } from "../../src/plugins/environments/docker/environment.js";
import { PINNED_NODE_IMAGE } from "../../src/infrastructure/containers/runtime-contract.js";
import { LocalScheduler } from "../../src/plugins/schedulers/local/scheduler.js";
import { SimpleAgentSolver } from "../../src/plugins/solvers/simpleagent.js";
import { HarborBenchmark } from "../../src/plugins/benchmarks/agent-harness/protocols/harbor/index.js";
import { mixedSnapshot } from "../fixtures/results/mixed-run/fixture.js";
import { PACKAGE_RUNTIME_ID } from "../../src/core/results/runtime-identity.js";
import { loadPackageDigest } from "../../src/infrastructure/provenance/package.js";

type FixtureState = {
  created: string[];
  disposed: string[];
  factoryInputs: Array<{
    role: string;
    config: unknown;
    auth: string | null;
    configDirectory: string | null;
    resolvedPath: string | null;
  }>;
};

const fixture = (...parts: string[]) =>
  join(import.meta.dirname, "..", "fixtures", "plugins", ...parts);

function state(): FixtureState {
  return (globalThis as typeof globalThis & { __t02FixtureState?: FixtureState })
    .__t02FixtureState ??= { created: [], disposed: [], factoryInputs: [] };
}

afterEach(() => {
  delete (globalThis as typeof globalThis & { __t02FixtureState?: FixtureState })
    .__t02FixtureState;
});

describe("Cordis evaluator registry", () => {
  test("rolls back a registration when plugin apply fails", async () => {
    const ctx = new Context();
    await ctx.plugin(registryPlugin);

    const failing = {
      inject: ["evaluator"],
      apply(pluginContext: Context) {
        registerNativeResource(pluginContext,
          "metrics",
          "orphan",
          () => ({}),
          () => ({ name: "orphan", async compute() { return null; } }),
        );
        throw new Error("apply failed after register");
      },
    };

    await expect(ctx.plugin(failing)).rejects.toThrow("apply failed after register");
    expect(hasNativeResource(ctx.evaluator.workflows, "metrics", "orphan")).toBe(false);
    await ctx.fiber.dispose();
  });

  test("removes direct registrations when their caller plugin unloads", async () => {
    const ctx = new Context();
    await ctx.plugin(registryPlugin);
    const plugin = {
      inject: ["evaluator"],
      apply(pluginContext: Context) {
        registerNativeResource(pluginContext,
          "metrics",
          "temporary",
          () => ({}),
          () => ({ name: "temporary", async compute() { return null; } }),
        );
      },
    };

    const fiber = ctx.plugin(plugin);
    await fiber;
    expect(hasNativeResource(ctx.evaluator.workflows, "metrics", "temporary")).toBe(true);
    await fiber.dispose();
    expect(hasNativeResource(ctx.evaluator.workflows, "metrics", "temporary")).toBe(false);
    await ctx.fiber.dispose();
  });

  test("rejects duplicate role and name registrations without an orphan", async () => {
    const ctx = new Context();
    await ctx.plugin(registryPlugin);
    const first = ctx.plugin({
      inject: ["evaluator"],
      apply(pluginContext: Context) {
        registerNativeResource(pluginContext,
          "metrics",
          "duplicate",
          () => ({}),
          () => ({ name: "first", async compute() { return null; } }),
        );
      },
    });
    await first;

    await expect(ctx.plugin({
      inject: ["evaluator"],
      apply(pluginContext: Context) {
        registerNativeResource(pluginContext,
          "metrics",
          "duplicate",
          () => ({}),
          () => ({ name: "second", async compute() { return null; } }),
        );
      },
    })).rejects.toThrow(/duplicate/i);

    expect(hasNativeResource(ctx.evaluator.workflows, "metrics", "duplicate")).toBe(true);
    await first.dispose();
    expect(hasNativeResource(ctx.evaluator.workflows, "metrics", "duplicate")).toBe(false);
    await ctx.fiber.dispose();
  });
});

describe("plugin resources", () => {
  test.each([undefined, fixture("valid", "cordis.patch.yaml")])("registers repository plugins with patch %s", async patchPath => {
    const registry = await openPluginRegistry(patchPath);
    try {
      expect(hasNativeResource(registry.ctx.evaluator.workflows, "benchmark", "aisbench")).toBe(true);
      expect(hasNativeResource(registry.ctx.evaluator.workflows, "benchmark", "docops")).toBe(true);
      expect(hasNativeResource(registry.ctx.evaluator.workflows, "metrics", "fixture-metrics")).toBe(patchPath !== undefined);
    } finally { await registry.dispose(); }
  });

  test("accepts the old explicit repository patch without registering its plugin twice", async () => {
    const patchPath = resolve(import.meta.dirname, "../../plugins/aisbench/cordis.patch.yaml");
    const registry = await openPluginRegistry(patchPath);
    try {
      expect(hasNativeResource(registry.ctx.evaluator.workflows, "benchmark", "docops")).toBe(true);
      expect(hasNativeResource(registry.ctx.evaluator.workflows, "benchmark", "aisbench")).toBe(true);
      expect(registry.pluginVersions["aisbench-plugin"]).toMatch(/^sha256:/u);
      expect(registry.entries.find(entry => entry.id === "aisbench-plugin")?.bundledVersion)
        .toBe(registry.pluginVersions["aisbench-plugin"]);
    } finally { await registry.dispose(); }
  });

  test("returns no entries when no patch file is selected", async () => {
    const loaded = await loadPluginPatch();
    expect(loaded.entries).toEqual([]);
    expect(loaded.patchDigest).toBeNull();
    expect(loaded.patchPath).toBeNull();
  });

  test("loads the patch file selected by its explicit path", async () => {
    const patchPath = fixture("valid", "cordis.patch.yaml");
    const loaded = await loadPluginPatch(patchPath);
    expect(loaded.entries.map(entry => entry.id)).toEqual(["fixture-seven-roles"]);
    expect(loaded.patchPath).toBe(resolve(patchPath));
  });

  test("rejects an explicitly selected patch that does not exist", async () => {
    await expect(loadPluginPatch(fixture("valid", "missing.patch.yaml"))).rejects.toThrow();
  });

  test("records distributed runtime and package digests", async () => {
    const registry = await openPluginRegistry(fixture("valid", "cordis.patch.yaml"));
    try {
      expect(registry.pluginVersions["arsi-evaluator:builtin-runtime"]).toMatch(/^sha256:[a-f0-9]{64}$/u);
      expect(registry.pluginVersions[PACKAGE_RUNTIME_ID]).toBe(await loadPackageDigest());
      expect(registry.reportingProviders["metrics:fixture-metrics"]).toBe("fixture-seven-roles");
      expect(registry.reportingProviders["reporter:fixture-reporter"]).toBe("fixture-seven-roles");
    } finally { await registry.dispose(); }
  });

  test("opens third-party resources with model credentials and paths, and releases their plugin effects", async () => {
    const registry = await openPluginRegistry(fixture("valid", "cordis.patch.yaml"));
    const directory = fixture("valid");
    const runtime = { configDirectory: directory, resolvePath: (path: string) => resolve(directory, path), solverService: "default",
      services: { default: { model: { name: "fixture", endpoint: "https://fixture.invalid", api: "openai-completions", provider: null }, auth: { value: "fixture-secret", reference: null } } } };
    try {
      for (const role of ["benchmark", "environment", "solver", "metrics", "reporter", "store", "scheduler"] as const)
        await createNativeResource(registry.ctx, role, { name: `fixture-${role}`, config: { marker: role, ...(role === "benchmark" ? { cacheDir: "./cache" } : {}) } },
          role === "metrics" || role === "reporter" ? { configDirectory: directory, resolvePath: runtime.resolvePath } : runtime);
      expect(state().factoryInputs).toHaveLength(7);
      expect(state().factoryInputs.every(({ role, auth }) => auth === (["metrics", "reporter"].includes(role) ? null : "fixture-secret"))).toBe(true);
      expect(state().factoryInputs.find(item => item.role === "benchmark")).toMatchObject({ configDirectory: directory, resolvedPath: fixture("valid", "cache") });
    } finally { await registry.dispose(); }
    expect(state().disposed).toContain("fixture-seven-roles");
  });

  test("built-in resources create without executing models, containers or downloads", async () => {
    const registry = await openPluginRegistry();
    const runtime = { configDirectory: fixture("valid"), resolvePath: (path: string) => resolve(fixture("valid"), path), solverService: "default",
      services: { default: { model: { name: "fixture", endpoint: "https://fixture.invalid", api: "openai-completions", provider: null }, auth: { value: "fixture-secret", reference: null } } } };
    try {
      expect(await createNativeResource(registry.ctx, "solver", { name: "simpleagent", config: {} }, runtime)).toBeInstanceOf(SimpleAgentSolver);
      expect(await createNativeResource(registry.ctx, "scheduler", { name: "local", config: { concurrency: 2 } }, runtime)).toBeInstanceOf(LocalScheduler);
      expect(await createNativeResource(registry.ctx, "environment", { name: "local", config: {} }, runtime)).toBeInstanceOf(LocalEnvironment);
      for (const platform of ["auto", "linux/amd64", "linux/arm64"])
        expect(await createNativeResource(registry.ctx, "environment", { name: "docker", config: { dockerExecutable: "not-installed-fixture-docker", platform, nodeImage: PINNED_NODE_IMAGE, imageOverrides: { "fixture/base:1": "fixture/public-cache:1" } } }, runtime)).toBeInstanceOf(DockerEnvironment);
      const metrics = await Promise.all(["success-rate", "duration", "usage"].map(name => createNativeResource(registry.ctx, "metrics", { name, config: {} }, runtime)));
      expect(metrics.map(metric => metric.name)).toEqual(["success-rate", "duration", "usage"]);
      expect(await metrics[0]!.compute(mixedSnapshot)).toMatchObject({ selected: 4, passed: 1, rate: 1 / 3 });
      const reporter = await createNativeResource(registry.ctx, "reporter", { name: "markdown", config: {} }, runtime);
      expect(await reporter.render(mixedSnapshot, {})).toContain("未完成");
      for (const name of ["harbor-shell", "harbor-python"]) {
        const verifier = await createNativeResource(registry.ctx, "verifier", { name, config: {} }, runtime);
        const benchmark = await createNativeResource(registry.ctx, "benchmark", { name: "harbor", config: { dataset: "terminal-bench@2.0", taskProfiles: { custom: { workdir: "/app", extraPaths: ["/data"] } } } }, { ...runtime, verifier });
        expect(benchmark).toBeInstanceOf(HarborBenchmark);
      }
      await expect(createNativeResource(registry.ctx, "verifier", { name: "harbor-python", config: { requireService: true } }, runtime)).rejects.toThrow(/explicit verifier.service/);
    } finally { await registry.dispose(); }
  });

  test("resource validators reject invalid private options and retired registrations", async () => {
    const registry = await openPluginRegistry();
    try {
      const invalid = [
        { role: "solver", name: "simpleagent", config: { apiKey: "wrong-place" } },
        { role: "scheduler", name: "local", config: { concurrency: 0 } },
        { role: "environment", name: "local", config: { arbitrary: true } },
        ...[{ pullProxy: "socks5://localhost:7890" }, { privileged: true }, { platform: "linux/386" }, { imageOverrides: { "fixture/base:1": false } }, { nodeImage: "node:24" }]
          .map(config => ({ role: "environment" as const, name: "docker", config })),
        ...[{ unexpected: true }, { taskProfiles: { custom: { workdir: "/", extraPaths: [] } } }, { taskProfiles: { custom: { workdir: "/app", extraPaths: [], mounts: [] } } }]
          .map(config => ({ role: "benchmark" as const, name: "harbor", config: { dataset: "terminal-bench@2.0", ...config } })),
        ...["workbuddybench", "deepswebench"].map(name => ({ role: "benchmark" as const, name, config: {} })),
      ] satisfies { role: import("../../src/core/contracts/plugin.js").PluginRole; name: string; config: unknown }[];
      for (const { role, ...selection } of invalid) expect(() => prepareNativeResource(registry.ctx, role, selection), `${role}:${selection.name}`).toThrow();
    } finally { await registry.dispose(); }
  });

  test.each(["benchmark", "reporter"])("workflow validates late %s options before invoking any factory", async role => {
    const root = await mkdtemp(join(tmpdir(), "plugin-validation-"));
    try {
      const configPath = join(root, "eval.yaml");
      await writeFile(configPath, JSON.stringify({ schemaVersion: 2, workflow: "benchmark.evaluate", with: {
        services: { default: { model: "fixture", base_url: "https://fixture.invalid" } },
        benchmark: { name: "fixture-benchmark", config: { marker: role === "benchmark" ? "wrong" : "benchmark" } },
        reporter: { name: "fixture-reporter", config: { marker: role === "reporter" ? "wrong" : "reporter" } },
      } }));
      await expect(inspectWorkflow({ configPath, patchPath: fixture("valid", "cordis.patch.yaml"), env: {} })).rejects.toThrow(new RegExp(`${role}.*marker`));
      expect(state().created).toEqual([]);
      expect(state().disposed).toContain("fixture-seven-roles");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("workflow releases plugin effects when a later factory fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "plugin-factory-failure-"));
    try {
      const configPath = join(root, "eval.yaml");
      await writeFile(configPath, JSON.stringify({ schemaVersion: 2, workflow: "benchmark.evaluate", with: {
        services: { default: { model: "fixture", base_url: "https://fixture.invalid" } },
        benchmark: "fixture-benchmark", environment: "fixture-environment",
      }, output: { directory: "./results" } }));
      const result = await runWorkflow({ configPath, patchPath: fixture("factory-failing", "cordis.patch.yaml"), env: {} });
      expect(result.record.status).toBe("failed");
      expect(JSON.stringify(result.record)).toContain("fixture environment factory failed");
      expect(state().created).toEqual(["benchmark"]);
      expect(state().disposed).toContain("factory-failing");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("plugin apply failures release registered effects", async () => {
    await expect(openPluginRegistry(fixture("failing", "cordis.patch.yaml"))).rejects.toThrow("fixture apply failed");
    expect(state().disposed).toContain("failing");
  });

  test("duplicate registration unloads both plugin scopes", async () => {
    await expect(openPluginRegistry(fixture("duplicate", "cordis.patch.yaml"))).rejects.toThrow(/duplicate.*benchmark.*fixture-benchmark/i);
    expect(state().disposed).toEqual(expect.arrayContaining(["duplicate-first", "duplicate-second"]));
  });

  test("resolves npm package entries from the patch project", async () => {
    const resolved = await loadPluginModule(
      { id: "yaml-package", name: "yaml" },
      fixture("valid", "cordis.patch.yaml"),
    );

    expect(resolved.id).toBe("yaml-package");
    expect(resolved.version).toBe("2.9.1");
    expect(resolved.plugin).toBeTruthy();
  });

  test("reserves the patch metadata id from plugin entries", async () => {
    await expect(loadPluginPatch(fixture("metadata-collision", "cordis.patch.yaml")))
      .rejects.toThrow(/cordis\.patch\.yaml.*reserved/i);
  });

  test("reserves the builtin runtime provenance id from plugin entries", async () => {
    await expect(loadPluginPatch(fixture("builtin-collision", "cordis.patch.yaml")))
      .rejects.toThrow(/builtin-runtime.*reserved/i);
  });
});
