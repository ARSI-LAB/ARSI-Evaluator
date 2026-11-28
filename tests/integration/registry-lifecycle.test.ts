import { registerNativeResource } from "arsi-evaluator";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "vitest";
import { stringify } from "yaml";
import { runCli } from "../../src/cli/main.js";
import { createNativeResource } from "../../src/plugins/workflows/benchmark/component-resource.js";
import { openPluginRegistry } from "../../src/application/plugins/open-registry.js";
import { inspectWorkflow } from "../../src/application/workflow.js";

test("Registry disposal releases a simpleagent's staged bundle", async () => {
  const root = await mkdtemp(join(tmpdir(), "staging-lifecycle-"));
  const registry = await openPluginRegistry();
  const solver = await createNativeResource(registry.ctx, "solver", { name: "simpleagent", config: { bundle: { path: join(import.meta.dirname, "../fixtures/pi-bundle") } } }, {
    configDirectory: root, resolvePath: path => resolve(root, path), solverService: "default",
    services: { default: { model: { name: "fixture", endpoint: "https://fixture.invalid", api: "openai-completions", provider: null }, auth: { value: "fixture-key", reference: null } } },
  });
  try {
    if (!solver.runtimeInstallation) throw new Error("Missing Pi runtime installation");
    const installation = await solver.runtimeInstallation(AbortSignal.timeout(5000));
    const bundle = installation.files.find(file => file.target === "bundle")?.source;
    if (!bundle) throw new Error("Missing staged bundle");
    await access(bundle);
    await registry.dispose();
    await registry.dispose();
    await expect(access(bundle)).rejects.toMatchObject({ code: "ENOENT" });
  } finally { await registry.dispose(); await rm(root, { recursive: true, force: true }); }
});

test.each([{ flags: [] }, { flags: ["--dry-run"] }])("a command shares one registry and releases its effects: $flags", async ({ flags }) => {
  const root = await mkdtemp(join(tmpdir(), "registry-lifecycle-"));
  try {
    const log = join(root, "lifecycle.txt");
    await writeFile(join(root, "plugin.mjs"), `import { appendFileSync } from "node:fs";
import { registerNativeResource } from "arsi-evaluator";
export const inject = ["evaluator"];
export function apply(ctx) {
  const log = ${JSON.stringify(pathToFileURL(log).href)};
  appendFileSync(new URL(log), "registered\\n");
  ctx.effect(() => () => appendFileSync(new URL(log), "disposed\\n"));
  registerNativeResource(ctx, "benchmark", "fixture", value => value, () => ({
    async resolveSource() { return { source: "fixture", revision: "1", files: [], metadata: null }; },
    async *enumerate() { throw new Error("fixture enumeration failure"); },
    async prepare() { throw new Error("unused"); },
    async verify() { throw new Error("unused"); }
  }));
}`);
    const patch = join(root, "patch.yaml");
    await writeFile(patch, stringify([{ insert: [{ id: "lifecycle", name: "./plugin.mjs" }] }]));
    const config = join(root, "experiment.yaml");
    await writeFile(config, stringify({ schemaVersion: 2, workflow: "benchmark.evaluate", with: { services: { default: { model: "fixture", base_url: "https://fixture.invalid" } },
      benchmark: "fixture" }, output: { directory: "./results" } }));
    const errors: string[] = [];
    expect(await runCli(["run", config, "--patch", patch, "--api-key", "fixture-key", ...flags],
      { out() {}, error: text => { errors.push(text); } })).toBe(flags.length ? 2 : 1);
    expect(errors.join("\n")).toContain("fixture enumeration failure");
    expect(await readFile(log, "utf8")).toBe("registered\ndisposed\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("invalid service references fail before any factory, including standalone assembly", async () => {
  const root = await mkdtemp(join(tmpdir(), "service-validation-"));
  try {
    const log = join(root, "factory.txt");
    await writeFile(join(root, "plugin.mjs"), `import { appendFileSync } from "node:fs";
import { registerNativeResource } from "arsi-evaluator";
export const inject = ["evaluator"];
export function apply(ctx) {
  registerNativeResource(ctx, "verifier", "controlled", value => value, () => {
    appendFileSync(new URL(${JSON.stringify(pathToFileURL(log).href)}), "created");
    throw new Error("verifier factory must not run");
  });
}`);
    const patchPath = join(root, "patch.yaml"), file = join(root, "experiment.yaml");
    await writeFile(patchPath, stringify([{ insert: [{ id: "controlled", name: "./plugin.mjs" }] }]));
    const config = { services: { default: { model: "fixture", base_url: "https://fixture.invalid", api_key: "${KEY}" } },
      benchmark: { name: "simpleqa", config: { judgeService: "default" }, verifier: "controlled" } };
    config.benchmark.config.judgeService = "missing";
    await writeFile(file, stringify({ schemaVersion: 2, workflow: "benchmark.evaluate", with: { ...config,
      services: { default: { model: "fixture", base_url: "https://fixture.invalid", apiKeyEnv: "KEY" } } } }));
    await expect(inspectWorkflow({ configPath: file, patchPath, env: {} })).rejects.toThrow(/judgeService references unknown service missing/);
    for (const flags of [[], ["--dry-run"]]) {
      const errors: string[] = [];
      expect(await runCli(["run", file, "--patch", patchPath, "--api-key", "private-key", ...flags],
        { out() {}, error: text => { errors.push(text); } })).toBe(2);
      expect(errors.join("\n")).toContain("unknown service missing");
    }
    await expect(readFile(log, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.each([false, true])("caller registry releases factory resources, fail=%s", async fail => {
  const root = await mkdtemp(join(tmpdir(), "factory-ownership-"));
  const resource = join(root, "resource.txt");
  const log = join(root, "lifecycle.txt");
  const patchPath = join(root, "patch.yaml");
  try {
    await writeFile(join(root, "plugin.mjs"), `import { appendFileSync, writeFileSync, rmSync } from "node:fs";
import { registerNativeResource } from "arsi-evaluator";
export const inject = ["evaluator"];
export function apply(ctx) {
  const log = new URL(${JSON.stringify(pathToFileURL(log).href)});
  appendFileSync(log, "registered\\n");
  registerNativeResource(ctx, "benchmark", "resource-fixture", config => config, config => {
    const resource = new URL(${JSON.stringify(pathToFileURL(resource).href)});
    writeFileSync(resource, "allocated");
    ctx.effect(() => () => { rmSync(resource); appendFileSync(log, "released\\n"); });
    if (config.fail) throw new Error("factory failed after allocation");
    return {
      async resolveSource() { return { source: "fixture", revision: "1", files: [], metadata: null }; },
      async *enumerate() { yield { id: "a", recordKey: "a" }; },
      async prepare() { throw new Error("unused"); },
      async verify() { throw new Error("unused"); }
    };
  });
}`);
    await writeFile(patchPath, stringify([{ insert: [{ id: "resource-fixture", name: "./plugin.mjs" }] }]));
    const registry = await openPluginRegistry(patchPath);
    try {
      const assembled = createNativeResource(registry.ctx, "benchmark", { name: "resource-fixture", config: { fail } }, {
        configDirectory: root, resolvePath: path => resolve(root, path), services: {}, solverService: "default",
      });
      if (fail) await expect(assembled).rejects.toThrow("factory failed after allocation");
      else {
        const benchmark = await assembled;
        expect(await benchmark.resolveSource(null, AbortSignal.timeout(5000))).toMatchObject({ source: "fixture" });
      }
      expect(await readFile(resource, "utf8")).toBe("allocated");
      expect(await readFile(log, "utf8")).toBe("registered\n");
    } finally { await registry.dispose(); }
    await expect(access(resource)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(log, "utf8")).toBe("registered\nreleased\n");


  } finally { await rm(root, { recursive: true, force: true }); }
});
