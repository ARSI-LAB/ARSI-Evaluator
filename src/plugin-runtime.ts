import { Context, type Plugin } from "@deepseek-ai/cordis";
import { bundledPluginPatchPath, loadPluginPatch, PATCH_METADATA_ID, resolvePlugin } from "./config/plugin-patch.js";
import { BUILTIN_RUNTIME_ID, loadBuiltinRuntimeDigest } from "./core/builtin-runtime.js";
import { PACKAGE_RUNTIME_ID, loadPackageDigest } from "./core/package-provenance.js";
import { apply as registryPlugin } from "./core/registry.js";
import * as builtins from "./plugins/index.js";
import { validateProfiles } from "./config/profiles.js";
import type { RunPluginEntry } from "./core/contracts/result.js";

async function loadExperimentPlugins(
  ctx: Context,
  patchPath: string | undefined,
): Promise<{
  patch: Awaited<ReturnType<typeof loadPluginPatch>>;
  entries: RunPluginEntry[];
  pluginVersions: Record<string, string>;
  reportingProviders: Record<string, string>;
}> {
  const patch = await loadPluginPatch(patchPath);
  const pluginVersions: Record<string, string> = Object.create(null) as Record<string, string>;
  pluginVersions[BUILTIN_RUNTIME_ID] = await loadBuiltinRuntimeDigest();
  pluginVersions[PACKAGE_RUNTIME_ID] = await loadPackageDigest();
  if (patch.patchDigest !== null) pluginVersions[PATCH_METADATA_ID] = patch.patchDigest;
  const bundled = await loadPluginPatch(bundledPluginPatchPath());
  const entries = new Map<string, RunPluginEntry>();
  const reportingProviders: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const source of [bundled, patch]) {
    if (source.patchPath === null) continue;
    for (const entry of source.entries) {
      const resolved = await resolvePlugin(entry, source.patchPath);
      const existing = entries.get(entry.id);
      if (existing && existing.bundledVersion !== resolved.version) {
        throw new TypeError(`plugin patch id ${entry.id} conflicts with a bundled plugin`);
      }
      if (source === bundled) {
        entries.set(entry.id, { ...entry, bundledVersion: resolved.version });
      } else {
        // Preserve the explicit version lock, even when the bundled copy supplied the registration.
        pluginVersions[entry.id] = resolved.version;
        if (!existing) entries.set(entry.id, entry);
      }
      if (existing) continue;
      const previous = new Set(ctx.evaluator.entries().map(entry => `${entry.role}:${entry.name}`));
      await ctx.plugin(asCordisPlugin(resolved.plugin, resolved.id));
      for (const selection of ctx.evaluator.entries()) {
        if ((selection.role === "metrics" || selection.role === "reporter") && !previous.has(`${selection.role}:${selection.name}`)) {
          reportingProviders[`${selection.role}:${selection.name}`] = entry.id;
        }
      }
    }
  }
  return { patch, entries: [...entries.values()], pluginVersions, reportingProviders };
}

function asCordisPlugin(value: unknown, id: string): Plugin {
  if (typeof value === "function") return value as Plugin;
  if (value !== null && typeof value === "object" && "apply" in value) {
    return value as Plugin;
  }
  throw new TypeError(`plugin ${id} does not export a Cordis plugin entry`);
}

export async function openPluginRegistry(patchPath?: string) {
  const ctx = new Context();
  try {
    await ctx.plugin(registryPlugin);
    await ctx.plugin(builtins);
    const metadata = await loadExperimentPlugins(ctx, patchPath);
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
