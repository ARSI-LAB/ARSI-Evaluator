import { createNativeResource, hasNativeResource, nativeResourceTransport } from "arsi-evaluator";
import { Context } from "@deepseek-ai/cordis";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, test } from "vitest";

import { apply as registryPlugin } from "../../src/application/plugins/registry.js";
import {
  DocOpsBenchmark,
  DocOpsDockerEnvironment,
} from "../../plugins/docops/index.js";
import * as docOpsPlugin from "../../plugins/docops/index.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

test("DocOps remains external until its Cordis plugin is loaded", async () => {
  const ctx = new Context();
  await ctx.plugin(registryPlugin);
  expect(hasNativeResource(ctx.evaluator.workflows, "benchmark", "docops")).toBe(false);
  expect(hasNativeResource(ctx.evaluator.workflows, "environment", "docops-docker")).toBe(false);

  await ctx.plugin(docOpsPlugin);
  expect(hasNativeResource(ctx.evaluator.workflows, "benchmark", "docops")).toBe(true);
  expect(hasNativeResource(ctx.evaluator.workflows, "environment", "docops-docker")).toBe(true);
  const cache = await mkdtemp(join(tmpdir(), "docops-plugin-cache-"));
  roots.push(cache);
  const model = { name: "fixture", endpoint: null, provider: "openai", api: null } as const;
  const auth = { value: "", reference: null };
  const runtime = {
    model,
    auth,
    services: { default: { model, auth } },
    solverService: "default",
    configDirectory: cache,
    resolvePath: (path: string) => join(cache, path),
  };
  const benchmark = await createNativeResource(ctx, "benchmark", {
    name: "docops",
    config: { repository: "icip-cas/DocOps", revision: "main", cacheDir: "./cache" },
  }, runtime);
  expect(benchmark).toBeInstanceOf(DocOpsBenchmark);
  const environment = await createNativeResource(ctx, "environment", {
    name: "docops-docker",
    config: { profile: "amd", cacheDir: "./images" },
  }, runtime);
  expect(environment).toBeInstanceOf(DocOpsDockerEnvironment);
  expect(environment.supportsRuntimeInstallation).toBe(true);
  expect(environment.materialize).toBeTypeOf("function");
  expect(nativeResourceTransport(ctx.evaluator.workflows, "benchmark", "docops")).toEqual({ nodeLocal: { cacheDir: "cache" } });
  expect(nativeResourceTransport(ctx.evaluator.workflows, "environment", "docops-docker")).toEqual({ nodeLocal: { cacheDir: "cache", dockerExecutable: "docker" } });
  await ctx.fiber.dispose();
});
