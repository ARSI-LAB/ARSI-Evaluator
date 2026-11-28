import { readPluginCatalog, loadInstalledPlugin } from "./plugins/catalog.js";
import { Context, type Plugin } from "@deepseek-ai/cordis";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { WorkflowBlock, WorkflowObject, WorkflowPlan } from "../core/contracts/workflow.js";
import { workflowObject } from "../core/workflow/values.js";
import { expectNonEmptyString, expectRecord } from "../core/validation/input.js";
import { BUILTIN_RUNTIME_ID } from "../core/results/runtime-identity.js";
import { loadBuiltinRuntimeDigest } from "../infrastructure/provenance/builtin-runtime.js";
import { bundledPluginPatchPath } from "../infrastructure/provenance/package.js";
import { atomic } from "../infrastructure/filesystem/atomic-json.js";
import { apply as registryPlugin } from "./plugins/registry.js";
import { loadPluginModule } from "./plugins/load-module.js";
import type { PluginRegistry } from "./plugins/open-registry.js";
import * as builtins from "../plugins/index.js";

type ReportStep = { path: string; type: string; config: WorkflowObject; version: string; dependencies: string[] };

/** Host-local loading metadata, kept separate from portable plans sent to workers. */
export async function saveWorkflowReporting(plan: WorkflowPlan, registry: PluginRegistry, directory: string,
  configDirectory = plan.document.pathBase ?? ".") {
  const steps: ReportStep[] = [], ids = new Set<string>();
  const implementations: Record<string, string> = {};
  const visit = (body: WorkflowBlock, path: string) => {
    for (const node of body.steps) {
      const current = `${path}.${node.id}`;
      if (node.kind !== "step") { visit(node.body, current); continue; }
      const definition = registry.ctx.evaluator.workflows.step(node.use);
      if (!definition.report) continue;
      const dependencies = [...new Set(definition.report.dependencies?.(node.config) ?? [])];
      steps.push({ path: current, type: node.use, config: node.config, version: definition.version, dependencies });
      for (const key of [`step:${node.use}`, ...dependencies.map(type => `resource:${type}`)]) {
        const provider = registry.componentProviders[key];
        if (provider) ids.add(provider);
      }
      for (const type of dependencies) implementations[type] = registry.ctx.evaluator.workflows.resource(type).version;
    }
  };
  visit(plan.document.workflow, "workflow");
  await atomic(join(directory, "workflow-reporting.json"), { schemaVersion: 1, fingerprint: plan.fingerprint,
    configDirectory: resolve(configDirectory), patchPath: registry.patch.patchPath, steps, implementations,
    installed: [...ids].filter(id => !registry.entries.some(entry => entry.id === id)),
    entries: registry.entries.filter(entry => ids.has(entry.id)), versions: registry.pluginVersions });
}

export async function readWorkflowReporting(directory: string): Promise<Record<string, unknown> | undefined> {
  try {
    const input = expectRecord(JSON.parse(await readFile(join(directory, "workflow-reporting.json"), "utf8")), "saved reporting metadata");
    if (input.schemaVersion !== 1) throw new TypeError("Unsupported reporting metadata version");
    return input;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

/** Load only modules needed by report hooks and their declared rendering dependencies. */
export async function openWorkflowReporting(directory: string, fingerprint: string, current?: PluginRegistry) {
  const saved = await readWorkflowReporting(directory);
  const ctx = current?.ctx ?? new Context();
  const dispose = () => current ? Promise.resolve() : ctx.fiber.dispose();
  try {
    if (!current) { await ctx.plugin(registryPlugin); await ctx.plugin(builtins); }
    const steps: ReportStep[] = [];
    if (saved) {
      if (saved.fingerprint !== fingerprint) throw new TypeError("Reporting metadata belongs to another workflow");
      const versions = expectRecord(saved.versions, "reporting versions");
      if (versions[BUILTIN_RUNTIME_ID] !== await loadBuiltinRuntimeDigest()) throw new TypeError("Built-in reporting implementation differs from saved run");
      if (!Array.isArray(saved.entries) || !Array.isArray(saved.steps)) throw new TypeError("Invalid reporting plugin metadata");
      if (!current && Array.isArray(saved.installed)) for (const id of saved.installed) {
        const plugin = readPluginCatalog().find(entry => entry.id === id);
        if (!plugin || plugin.version !== versions[plugin.id]) throw new TypeError(`Installed reporting plugin changed: ${id}`);
        await ctx.plugin(await loadInstalledPlugin(plugin) as Plugin);
      }
      for (const value of current ? [] : saved.entries) {
        const entry = expectRecord(value, "reporting plugin");
        const id = expectNonEmptyString(entry.id, "plugin ID"), name = expectNonEmptyString(entry.name, "plugin name");
        const patchPath = entry.bundledVersion === undefined ? expectNonEmptyString(saved.patchPath, "reporting patch path") : bundledPluginPatchPath();
        const loaded = await loadPluginModule({ id, name }, patchPath);
        if (loaded.version !== (entry.bundledVersion ?? versions[id])) throw new TypeError(`Reporting plugin version differs from saved run: ${id}`);
        await ctx.plugin(loaded.plugin as Plugin);
      }
      const implementations = expectRecord(saved.implementations, "report dependency versions");
      for (const [type, version] of Object.entries(implementations)) if (ctx.evaluator.workflows.resource(type).version !== version)
        throw new TypeError(`Report dependency version changed: ${type}`);
      for (const value of saved.steps) {
        const step = expectRecord(value, "report step"), type = expectNonEmptyString(step.type, "report step type");
        const definition = ctx.evaluator.workflows.step(type);
        if (!definition.report || definition.version !== step.version) throw new TypeError(`Report step implementation changed: ${type}`);
        if (!Array.isArray(step.dependencies) || step.dependencies.some(value => typeof value !== "string")) throw new TypeError("Invalid report dependencies");
        const config = definition.validateConfig(step.config);
        const dependencies = [...new Set(definition.report.dependencies?.(config) ?? [])];
        if (JSON.stringify(dependencies) !== JSON.stringify(step.dependencies)) throw new TypeError("Report dependency declaration changed");
        steps.push({ path: expectNonEmptyString(step.path, "report step path"), type, config: workflowObject(config), version: definition.version, dependencies });
      }
    }
    return { ctx, steps, configDirectory: saved ? expectNonEmptyString(saved.configDirectory, "report config directory") : directory,
      dispose };
  } catch (error) { await dispose(); throw error; }
}
