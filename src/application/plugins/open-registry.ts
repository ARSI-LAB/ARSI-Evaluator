import { Context, type Plugin } from "@deepseek-ai/cordis";
import { loadPluginPatch, PATCH_METADATA_ID } from "../../config/plugin-patch.js";
import type { RunPluginEntry } from "../../core/contracts/result.js";
import type { PluginActivation, StoreDecorator } from "../../core/contracts/plugin-extension.js";
import type { PluginFactoryContext } from "../../core/contracts/plugin.js";
import { BUILTIN_RUNTIME_ID, PACKAGE_RUNTIME_ID } from "../../core/results/runtime-identity.js";
import { loadBuiltinRuntimeDigest } from "../../infrastructure/provenance/builtin-runtime.js";
import { bundledPluginPatchPath, loadPackageDigest } from "../../infrastructure/provenance/package.js";
import { apply as registryPlugin } from "./registry.js";
import * as builtins from "../../plugins/index.js";
import { validateProfiles } from "../../config/profile-schema.js";
import { loadPluginModule } from "./load-module.js";
import { readPluginCatalog, loadInstalledPlugin } from "./catalog.js";
import { expectRecord } from "../../core/validation/input.js";

export type PluginRuntimeOptions = {
  /** Installed or explicit patch plugin IDs; registering does not activate their extensions. */
  plugins?: string[];
};

async function loadExperimentPlugins(
  ctx: Context,
  patchPath: string | undefined,
  options: PluginRuntimeOptions = {},
): Promise<{
  patch: Awaited<ReturnType<typeof loadPluginPatch>>;
  entries: RunPluginEntry[];
  pluginVersions: Record<string, string>;
  reportingProviders: Record<string, string>;
  loadPlugins(ids: readonly string[]): Promise<void>;
  loadRecordedPlugins(value: unknown): Promise<void>;
  prepareStoreDecorators(selections: readonly PluginActivation[]): ((runtime: PluginFactoryContext) => StoreDecorator | Promise<StoreDecorator>)[];
}> {
  const patch = await loadPluginPatch(patchPath);
  const pluginVersions: Record<string, string> = Object.create(null) as Record<string, string>;
  pluginVersions[BUILTIN_RUNTIME_ID] = await loadBuiltinRuntimeDigest();
  pluginVersions[PACKAGE_RUNTIME_ID] = await loadPackageDigest();
  if (patch.patchDigest !== null) pluginVersions[PATCH_METADATA_ID] = patch.patchDigest;
  const bundled = await loadPluginPatch(bundledPluginPatchPath());
  const catalog = readPluginCatalog();
  const entries = new Map<string, RunPluginEntry>();
  const reportingProviders: Record<string, string> = Object.create(null) as Record<string, string>;
  const decorators = new Map<string, string[]>();
  const loaded = new Set<string>();

  async function register(id: string, version: string, plugin: unknown): Promise<void> {
    const previous = new Set(ctx.evaluator.entries().map(entry => `${entry.role}:${entry.name}`));
    const before = new Set(ctx.evaluator.storeDecoratorNames());
    await ctx.plugin(asCordisPlugin(plugin, id));
    pluginVersions[id] = version;
    loaded.add(id);
    decorators.set(id, ctx.evaluator.storeDecoratorNames().filter(name => !before.has(name)));
    for (const selection of ctx.evaluator.entries()) {
      if ((selection.role === "metrics" || selection.role === "reporter") && !previous.has(`${selection.role}:${selection.name}`)) {
        reportingProviders[`${selection.role}:${selection.name}`] = id;
      }
    }
  }

  for (const source of [bundled, patch]) {
    if (source.patchPath === null) continue;
    for (const entry of source.entries) {
      const resolved = await loadPluginModule(entry, source.patchPath);
      const existing = entries.get(entry.id);
      if (existing && existing.bundledVersion !== resolved.version) {
        throw new TypeError(`plugin patch id ${entry.id} conflicts with a bundled plugin`);
      }
      if (source === bundled) {
        entries.set(entry.id, { ...entry, bundledVersion: resolved.version });
      } else {
        if (!existing) entries.set(entry.id, entry);
      }
      if (existing) continue;
      await register(entry.id, resolved.version, resolved.plugin);
    }
  }

  async function loadPlugins(ids: readonly string[]): Promise<void> {
    for (const id of ids) {
      if (loaded.has(id)) continue;
      const installed = catalog.find(plugin => plugin.id === id);
      if (!installed) throw new TypeError(`Plugin ${id} is not installed; rebuild the package or supply --patch`);
      await register(id, installed.version, await loadInstalledPlugin(installed));
    }
    validateProfiles(ctx.evaluator.profiles());
  }

  // Nodes import only preinstalled modules identified by the coordinator's locked versions.
  // Importing registers factories; it does not activate coordinator-only extensions.
  async function loadRecordedPlugins(value: unknown): Promise<void> {
    const versions = expectRecord(value, "recorded plugin versions");
    if (Object.values(versions).some(version => typeof version !== "string")) throw new TypeError("Invalid recorded plugin version");
    await loadPlugins(catalog.filter(plugin => Object.hasOwn(versions, plugin.id)).map(plugin => plugin.id));
  }

  function prepareStoreDecorators(selections: readonly PluginActivation[]) {
    return selections.flatMap(selection => {
      if (!loaded.has(selection.id)) throw new TypeError(`Plugin ${selection.id} has not been loaded`);
      return (decorators.get(selection.id) ?? []).map(name => ctx.evaluator.prepareStoreDecorator(name, selection.config));
    });
  }

  await loadPlugins(options.plugins ?? []);
  return { patch, entries: [...entries.values()], pluginVersions, reportingProviders, loadPlugins, loadRecordedPlugins, prepareStoreDecorators };
}

function asCordisPlugin(value: unknown, id: string): Plugin {
  if (typeof value === "function") return value as Plugin;
  if (value !== null && typeof value === "object" && "apply" in value) {
    return value as Plugin;
  }
  throw new TypeError(`plugin ${id} does not export a Cordis plugin entry`);
}

export async function openPluginRegistry(patchPath?: string, options: PluginRuntimeOptions = {}) {
  const ctx = new Context();
  try {
    await ctx.plugin(registryPlugin);
    await ctx.plugin(builtins);
    const metadata = await loadExperimentPlugins(ctx, patchPath, options);
    validateProfiles(ctx.evaluator.profiles());
    let disposed = false;
    return {
      ctx,
      ...metadata,
      async dispose() {
        if (disposed) return;
        disposed = true;
        await ctx.fiber.dispose();
      },
    };
  } catch (error) {
    await ctx.fiber.dispose();
    throw error;
  }
}

export type PluginRegistry = Awaited<ReturnType<typeof openPluginRegistry>>;
