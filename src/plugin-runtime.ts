import { Context, type Plugin } from "@deepseek-ai/cordis";
import { fileURLToPath } from "node:url";
import { loadPluginPatch, PATCH_METADATA_ID, resolvePlugin } from "./config/plugin-patch.js";
import { BUILTIN_RUNTIME_ID, loadBuiltinRuntimeDigest } from "./core/builtin-runtime.js";
import { PACKAGE_RUNTIME_ID, loadPackageDigest } from "./core/package-provenance.js";
import { apply as registryPlugin } from "./core/registry.js";
import * as builtins from "./plugins/index.js";
import { validateProfiles } from "./config/profiles.js";

/** The tracer package ships next to the runtime in both source and dist layouts. */
const TRACER_PATCH = fileURLToPath(new URL("../plugins/tracer/cordis.patch.yaml", import.meta.url));
/** Bundled tracer CLI entrypoint; the plugin owns its Collector subcommands. */
export const TRACER_CLI = fileURLToPath(new URL("../plugins/tracer/dist/cli.js", import.meta.url));

async function loadExperimentPlugins(
  ctx: Context,
  patchPath: string | undefined,
  options: PluginRuntimeOptions = {},
): Promise<{
  patch: Awaited<ReturnType<typeof loadPluginPatch>>;
  pluginVersions: Record<string, string>;
  reportingProviders: Record<string, string>;
}> {
  const patch = await loadPluginPatch(patchPath);
  const pluginVersions: Record<string, string> = Object.create(null) as Record<string, string>;
  pluginVersions[BUILTIN_RUNTIME_ID] = await loadBuiltinRuntimeDigest();
  pluginVersions[PACKAGE_RUNTIME_ID] = await loadPackageDigest();
  if (patch.patchDigest !== null) pluginVersions[PATCH_METADATA_ID] = patch.patchDigest;
  if (options.tracer) {
    const tracerPatch = await loadPluginPatch(TRACER_PATCH);
    for (const entry of tracerPatch.entries) {
      const resolved = await resolvePlugin(entry, TRACER_PATCH);
      pluginVersions[resolved.id] = resolved.version;
      await ctx.plugin(asCordisPlugin(resolved.plugin, resolved.id));
    }
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
  return { patch, pluginVersions, reportingProviders };
}

function asCordisPlugin(value: unknown, id: string): Plugin {
  if (typeof value === "function") return value as Plugin;
  if (value !== null && typeof value === "object" && "apply" in value) {
    return value as Plugin;
  }
  throw new TypeError(`plugin ${id} does not export a Cordis plugin entry`);
}

export type PluginRuntimeOptions = {
  /** Load the bundled external tracer store plugin in addition to the user patch. */
  tracer?: boolean;
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
