import { Context, type Plugin } from "@deepseek-ai/cordis";
import { pathToFileURL } from "node:url";
import { loadPluginPatch, PATCH_METADATA_ID, resolvePlugin } from "./config/plugin-patch.js";
import { BUILTIN_RUNTIME_ID, loadBuiltinRuntimeDigest } from "./core/builtin-runtime.js";
import { PACKAGE_RUNTIME_ID, loadPackageDigest } from "./core/package-provenance.js";
import { apply as registryPlugin } from "./core/registry.js";
import { pluginCommands } from "./plugins-commands.js";
import * as builtins from "./plugins/index.js";
import { validateProfiles } from "./config/profiles.js";

async function loadExperimentPlugins(
  ctx: Context,
  patchPath: string | undefined,
  options: PluginRuntimeOptions = {},
): Promise<{
  patch: Awaited<ReturnType<typeof loadPluginPatch>>;
  pluginVersions: Record<string, string>;
  reportingProviders: Record<string, string>;
  bundledPlugins: string[];
}> {
  const patch = await loadPluginPatch(patchPath);
  const pluginVersions: Record<string, string> = Object.create(null) as Record<string, string>;
  pluginVersions[BUILTIN_RUNTIME_ID] = await loadBuiltinRuntimeDigest();
  pluginVersions[PACKAGE_RUNTIME_ID] = await loadPackageDigest();
  if (patch.patchDigest !== null) pluginVersions[PATCH_METADATA_ID] = patch.patchDigest;
  // Bundled plugins ship with the runtime and are loaded by the ids recorded in the command index.
  const bundledPlugins: string[] = [];
  for (const id of options.plugins ?? []) {
    const bundled = pluginCommands().find(command => command.id === id && command.bundled);
    if (bundled === undefined || bundled.entryFile === null) {
      throw new Error(`the bundled ${id} plugin is missing; run "pnpm build" to compile plugins/${id}`);
    }
    pluginVersions[bundled.id] = bundled.version;
    await ctx.plugin(asCordisPlugin(await import(pathToFileURL(bundled.entryFile).href), bundled.id));
    bundledPlugins.push(bundled.id);
  }
  const reportingProviders: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const entry of patch.entries) {
    const previous = new Set(ctx.evaluator.entries().map(entry => `${entry.role}:${entry.name}`));
    if (patch.patchPath === null) throw new TypeError("plugin patch entries require an explicit patch path");
    const resolved = await resolvePlugin(entry, patch.patchPath);
    pluginVersions[resolved.id] = resolved.version;
    await ctx.plugin(asCordisPlugin(resolved.plugin, resolved.id));
    for (const selection of ctx.evaluator.entries())
      if ((selection.role === "metrics" || selection.role === "reporter") && !previous.has(`${selection.role}:${selection.name}`)) {
        reportingProviders[`${selection.role}:${selection.name}`] = entry.id;
      }
  }
  return { patch, pluginVersions, reportingProviders, bundledPlugins };
}

function asCordisPlugin(value: unknown, id: string): Plugin {
  if (typeof value === "function") return value as Plugin;
  if (value !== null && typeof value === "object" && "apply" in value) {
    return value as Plugin;
  }
  throw new TypeError(`plugin ${id} does not export a Cordis plugin entry`);
}

export type PluginRuntimeOptions = {
  /** Bundled plugin ids from the command index; each must declare "bundled": true in its manifest. */
  plugins?: string[];
};

export async function openPluginRegistry(patchPath?: string, options: PluginRuntimeOptions = {}) {
  const ctx = new Context();
  try {
    await ctx.plugin(registryPlugin);
    await ctx.plugin(builtins);
    const metadata = await loadExperimentPlugins(ctx, patchPath, options);
    validateProfiles(ctx.evaluator.profiles());
    let disposed = false;
    return { ctx, ...metadata, async dispose() {
      if (disposed) return;
      disposed = true;
      await ctx.fiber.dispose();
    } };
  } catch (error) {
    await ctx.fiber.dispose();
    throw error;
  }
}

export type PluginRegistry = Awaited<ReturnType<typeof openPluginRegistry>>;
