import "../fixtures/network-fetch.js";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { inspectWorkflow, exportWorkflow } from "../../src/application/workflow.js";
import { openPluginRegistry } from "../../src/application/plugins/open-registry.js";
import { nativeResourceTransport, openNativeResource } from "../../src/plugins/workflows/benchmark/component-resource.js";
import { workflowPlanCredentialNames } from "../../src/core/workflow/credentials.js";
import { NetworkRuntime } from "../../src/infrastructure/network/runtime.js";
import { networkDocument } from "../../src/config/network-schema.js";
import { DEFINED_BENCHMARKS } from "../../src/plugins/benchmarks/agent-harness/definitions/index.js";
import { projectPortableSelection, validatePortableSelection } from "../../src/infrastructure/ray/protocol.js";

afterEach(() => { vi.restoreAllMocks(); });

test.each(DEFINED_BENCHMARKS)("$definition.name keeps credentials out of plans and resolves current credentials when opened", async ({ definition, source }) => {
  const root = await mkdtemp(join(tmpdir(), "workflow-dataset-auth-")), registry = await openPluginRegistry();
  const configPath = join(root, "eval.yaml"), exported = join(root, "exported.yaml");
  const network = new NetworkRuntime(networkDocument({ sources: { huggingface: "https://fixture-hf.invalid" } }, {}));
  try {
    const settings = ["healthbench", "simpleqa", "math500"].includes(definition.name) ? { judgeService: "judge" } : {};
    const model = { model: "fixture", base_url: "https://model.invalid", apiKeyEnv: "MODEL_TOKEN" };
    const input = { schemaVersion: 2, workflow: "benchmark.evaluate", with: {
      benchmark: { name: definition.name, config: { ...settings, hfToken: { credential: "DATASET_TOKEN" } } },
      services: { default: model, judge: model },
    } };
    await writeFile(configPath, JSON.stringify(input));
    const plan = await inspectWorkflow({ configPath, env: {} });
    expect(workflowPlanCredentialNames(plan, registry.ctx.evaluator.workflows)).toEqual(expect.arrayContaining(["DATASET_TOKEN", "MODEL_TOKEN"]));
    await exportWorkflow({ configPath, env: { DATASET_TOKEN: "private-dataset-value" } }, exported);
    expect(await readFile(exported, "utf8")).not.toContain("private-dataset-value");
    expect((await inspectWorkflow({ configPath: exported, env: {} })).document).toEqual(plan.document);
    const selection = { name: definition.name, config: { ...settings, hfToken: { credential: "DATASET_TOKEN" } } };
    const lookup = (role: string, name: string) => nativeResourceTransport(registry.ctx.evaluator.workflows, role, name);
    expect(projectPortableSelection(selection, "benchmark", lookup)).toEqual(selection);
    expect(() => validatePortableSelection({ ...selection, config: { hfToken: { credential: "DATASET_TOKEN", value: "injected" } } }, "benchmark", lookup)).toThrow();
    let token = "private-dataset-value";
    const paths = source.selections.map(item => item.path ?? `${item.prefix}fixture.${item.format}`);
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, options) => {
      expect(new Headers(options?.headers).get("Authorization")).toBe(`Bearer ${token}`);
      return String(url).includes("/api/datasets/") ? new Response(JSON.stringify({ sha: "a".repeat(40), siblings: paths.map(rfilename => ({ rfilename })) })) : new Response("fixture data");
    });
    const runtime = { configDirectory: root, resolvePath: (path: string) => join(root, path), services: { judge: { model: { name: "fixture", endpoint: "https://model.invalid", api: "openai-completions", provider: null }, auth: { value: "fixture", reference: null } } }, solverService: "default", network };
    const resource = await openNativeResource(registry.ctx, "benchmark", { ...selection, config: { ...selection.config, cacheDir: "cache" } }, runtime,
      async name => name === "DATASET_TOKEN" ? "private-dataset-value" : undefined);
    try { await resource.value.resolveSource(null, AbortSignal.timeout(5_000)); }
    finally { await resource.dispose(); }
    expect(fetch).toHaveBeenCalledTimes(paths.length + 1);
    token = "rotated-dataset-value";
    const rotated = await openNativeResource(registry.ctx, "benchmark", { ...selection, config: { ...selection.config, cacheDir: "rotated-cache" } }, runtime,
      async name => name === "DATASET_TOKEN" ? token : undefined);
    try { await rotated.value.resolveSource(null, AbortSignal.timeout(5_000)); }
    finally { await rotated.dispose(); }
    expect(JSON.stringify(plan)).not.toContain(token);
    await expect(openNativeResource(registry.ctx, "benchmark", selection, runtime, async () => undefined)).rejects.toThrow("Missing credential DATASET_TOKEN");
    await writeFile(configPath, JSON.stringify({ ...input, with: { ...input.with, benchmark: { name: definition.name, config: { ...settings, hfToken: "inline-secret" } } } }));
    await expect(inspectWorkflow({ configPath, env: {} })).rejects.toThrow("credential: ENV_NAME");
  } finally { await network.dispose(); await registry.dispose(); await rm(root, { recursive: true, force: true }); }
});
