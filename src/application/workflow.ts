import { parsePluginActivations, restorePluginActivations } from "../core/plugins/activation.js";
import type { PluginActivation } from "../core/contracts/plugin-extension.js";
import { configurationEnvironment } from "../config/environment.js";
import { resolveManagedLocalBundles } from "./ray/managed-local.js";
import type { RetryRequest } from "../core/contracts/retry-control.js";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";
import type { WorkflowConfigurationOrigins, WorkflowExecutorOptions, WorkflowObject, WorkflowPlan, WorkflowRunRecord } from "../core/contracts/workflow.js";
import { parseWorkflowDocument, parseCompiledWorkflowDocument, workflowConfiguration } from "../config/workflow-schema.js";
import { compileWorkflow } from "../core/workflow/compile.js";
import { executeWorkflowPlan, WorkflowCompletionError } from "./workflow-execution.js";
import { workflowObject } from "../core/workflow/values.js";
import { rejectUnknown } from "../core/validation/input.js";
import { openPluginRegistry, type PluginRegistry } from "./plugins/open-registry.js";
import { parseDeployment, type Deployment } from "../config/deployment.js";
import { workflowPlanCredentialNames } from "../core/workflow/credentials.js";
import { runWorkflowJobs, retryWorkflowJobs } from "./ray/workflow-jobs.js";
import { executeWorkflowRetry } from "./workflow-retry.js";
import { bindWorkflowNetwork } from "./workflow-network.js";
import { readWorkflowReporting, saveWorkflowReporting } from "./workflow-report-plugins.js";
import { locateRun } from "../infrastructure/filesystem/run-index.js";

export type WorkflowOptions = {
  configPath: string; patchPath?: string; networkConfigPath?: string; signal?: AbortSignal; resume?: string | boolean;
  env?: Record<string, string | undefined>;
  plugins?: PluginActivation[];
  overrides?: { plugins?: PluginActivation[] };
  parameterOverrides?: WorkflowObject;
  onEvent?: WorkflowExecutorOptions["onEvent"];
};

export async function listWorkflows(patchPath?: string) {
  const registry = await openPluginRegistry(patchPath);
  try {
    return registry.ctx.evaluator.workflows.templateTypes().map(type => {
      const template = registry.ctx.evaluator.workflows.template(type);
      return { name: type, version: template.version, example: template.example ?? null };
    });
  } finally { await registry.dispose(); }
}

function expand(value: unknown, env: Record<string, string | undefined>): unknown {
  if (typeof value === "string") return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => {
    if (/(?:KEY|TOKEN|PASSWORD|SECRET)$/i.test(name)) throw new TypeError(`Use apiKeyEnv or a resource credential binding instead of expanding ${name}`);
    const result = env[name];
    if (result === undefined) throw new TypeError(`Missing environment variable ${name}`);
    return result;
  });
  if (Array.isArray(value)) return value.map(item => expand(item, env));
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) =>
    [key, "use" in value && value.use === "network.runtime" && key === "config" ? item : expand(item, env)]));
  return value;
}

async function savedWorkflowPlugins(outputDirectory: string, resume: string | true, registry: PluginRegistry,
  requested: PluginActivation[]): Promise<PluginActivation[]> {
  const entries = resume === true ? (await readdir(outputDirectory, { withFileTypes: true }))
    .filter(entry => entry.isDirectory() && !entry.name.startsWith(".")).map(entry => entry.name) : [resume];
  const candidates: { plugins: PluginActivation[]; sources: unknown }[] = [];
  for (const id of entries) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id)) throw new TypeError("Invalid run ID");
    let saved: WorkflowObject;
    try { saved = workflowObject(JSON.parse(await readFile(join(outputDirectory, id, "plan.json"), "utf8"))); }
    catch (error) { if (resume === true && (error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    const previous = parseCompiledWorkflowDocument(saved.document);
    const binding = Object.values(previous.workflow.resources).find(resource => resource.use === "benchmark.runtime")?.config.plugins;
    candidates.push({ plugins: parsePluginActivations(binding && "value" in binding ? binding.value : undefined), sources: saved.sources });
  }
  // Jobs can select by endpoint and fingerprint when several receipts use the same extensions.
  const first = candidates[0];
  if (!first) throw new TypeError("Cannot find a workflow run to resume");
  if (candidates.some(candidate => JSON.stringify(candidate.plugins) !== JSON.stringify(first.plugins))) {
    if (requested.length) return requested;
    throw new TypeError("Specify a run ID to restore the plugin options of one workflow run");
  }
  if (candidates.length === 1) await registry.loadRecordedPlugins(first.sources);
  const selections = restorePluginActivations(first.plugins, requested);
  await registry.loadPlugins(selections.map(item => item.id));
  return selections;
}

export async function readWorkflowConfiguration(file: string, registry: PluginRegistry, env = process.env, networkConfigPath?: string, parameterOverrides: WorkflowObject = {}, execution?: Pick<WorkflowOptions, "plugins" | "overrides" | "resume">): Promise<{
  plan: WorkflowPlan; deployment?: Deployment; outputDirectory: string; origins: WorkflowConfigurationOrigins;
}> {
  let selections = parsePluginActivations(execution?.plugins ?? execution?.overrides?.plugins);
  await registry.loadPlugins(selections.map(item => item.id));
  const variables = configurationEnvironment(env);
  let raw = workflowObject(parse(await readFile(file, "utf8")), "workflow configuration");
  const declaredOutput = workflowObject(raw.output ?? {}).directory;
  let restored = false;
  if (execution?.resume && (typeof declaredOutput === "string" || raw.workflow === "benchmark.evaluate")) {
    const output = expand(declaredOutput ?? "results", variables);
    if (typeof output !== "string") throw new TypeError("Invalid workflow output directory");
    selections = await savedWorkflowPlugins(resolve(dirname(file), output), execution.resume, registry, selections);
    restored = true;
  }
  if (Object.keys(parameterOverrides).length) {
    if (typeof raw.workflow !== "string") throw new TypeError("Expanded workflows do not support template parameter overrides; edit their YAML");
    const template = registry.ctx.evaluator.workflows.template(raw.workflow);
    if (!template.overrideParameters) throw new TypeError(`Workflow ${raw.workflow} does not support command-line parameter overrides; edit its YAML`);
    raw.with = template.overrideParameters(workflowObject(raw.with ?? {}), parameterOverrides);
  }
  raw = workflowObject(expand(raw, variables));
  let document: WorkflowObject = raw;
  let templateVersion: { key: string; version: string } | undefined;
  if (typeof raw.workflow === "string") {
    rejectUnknown(raw, ["schemaVersion", "pathBase", "workflow", "with", "output", "run", "deployment"], "template configuration");
    if (raw.schemaVersion !== 2) throw new TypeError("Workflow configuration requires schemaVersion: 2");
    const template = registry.ctx.evaluator.workflows.template(raw.workflow);
    document = workflowObject(expand(template.expand(workflowObject(raw.with ?? {})), variables));
    templateVersion = { key: template.type, version: template.version };
    if (raw.output !== undefined) document.output = raw.output;
    if (raw.pathBase !== undefined) document.pathBase = raw.pathBase;
    if (raw.run !== undefined) document.run = { ...workflowObject(document.run ?? {}), ...workflowObject(raw.run) };
  }
  const deploymentValue = raw.deployment ?? document.deployment;
  let deployment = deploymentValue === undefined ? undefined : parseDeployment(deploymentValue);
  if (deployment?.managedLocal) {
    const generated = workflowObject(document.deployment ?? {}).bundles;
    const bundles = { ...workflowObject(generated ?? {}), ...deployment.bundles };
    deployment = parseDeployment({ ...deployment, bundles });
    deployment.bundles = resolveManagedLocalBundles(dirname(file), deployment.bundles);
  }
  const { deployment: _deployment, ...workflow } = document;
  const parsed = parseWorkflowDocument(workflow);
  const resourceFiles = await bindWorkflowNetwork(parsed, registry.ctx.evaluator.workflows, { env, ...(networkConfigPath ? { networkConfigPath } : {}) });
  const outputDirectory = resolve(dirname(file), parsed.output.directory);
  if (execution?.resume && !restored) selections = await savedWorkflowPlugins(outputDirectory, execution.resume, registry, selections);
  const benchmarkResources = Object.values(parsed.workflow.resources).filter(resource => resource.use === "benchmark.runtime");
  if (!benchmarkResources.length && registry.prepareStoreDecorators(selections).length)
    throw new TypeError("Store decorators require a Benchmark workflow");
  for (const resource of benchmarkResources) {
    if (selections.length) resource.config.plugins = { value: selections };
    const binding = resource.config.plugins;
    if (binding && "value" in binding) await registry.loadPlugins(parsePluginActivations(binding.value).map(item => item.id));
  }
  if (deployment) {
    if (parsed.pathBase !== undefined && parsed.pathBase !== ".") throw new TypeError("Jobs workflow pathBase must be '.'; resource paths refer to the deployed experiment directory");
    parsed.pathBase = ".";
    parsed.output.directory = "results";
  } else {
    parsed.pathBase = resolve(dirname(file), parsed.pathBase ?? ".");
    parsed.output.directory = outputDirectory;
  }
  const plan = compileWorkflow(parsed, registry.ctx.evaluator.workflows, { ...registry.pluginVersions,
    ...(templateVersion ? { [`template:${templateVersion.key}`]: templateVersion.version } : {}) });
  return { plan, outputDirectory, origins: { configurationFile: resolve(file), resourceFiles }, ...(deployment ? { deployment } : {}) };
}

export async function readWorkflowPlan(file: string, registry: PluginRegistry, env = process.env, networkConfigPath?: string, parameterOverrides?: WorkflowObject): Promise<WorkflowPlan> {
  return (await readWorkflowConfiguration(file, registry, env, networkConfigPath, parameterOverrides)).plan;
}

export async function inspectWorkflow(options: Pick<WorkflowOptions, "configPath" | "patchPath" | "env" | "networkConfigPath" | "parameterOverrides">): Promise<WorkflowPlan> {
  const registry = await openPluginRegistry(options.patchPath);
  try { return await readWorkflowPlan(resolve(options.configPath), registry, options.env, options.networkConfigPath, options.parameterOverrides); }
  finally { await registry.dispose(); }
}

export async function exportWorkflow(options: Pick<WorkflowOptions, "configPath" | "patchPath" | "env" | "networkConfigPath" | "parameterOverrides">, destination: string): Promise<void> {
  const registry = await openPluginRegistry(options.patchPath);
  try {
    const file = resolve(options.configPath);
    const { plan, deployment, outputDirectory } = await readWorkflowConfiguration(file, registry, options.env, options.networkConfigPath, options.parameterOverrides);
    await writeFile(resolve(destination), stringify({ ...workflowConfiguration(plan.document),
      output: { directory: outputDirectory },
      ...(deployment ? { deployment: { ...deployment, caFile: resolve(dirname(file), deployment.caFile) } } : {}),
    }), { flag: "wx", mode: 0o600 });
  } finally { await registry.dispose(); }
}

export async function initializeWorkflow(type: string, destination: string, patchPath?: string): Promise<void> {
  const registry = await openPluginRegistry(patchPath);
  try {
    const template = registry.ctx.evaluator.workflows.template(type);
    if (!template.example) throw new TypeError(`Workflow ${type} does not provide starter parameters`);
    const input = { schemaVersion: 2, workflow: type, with: template.example };
    // Validate examples without resolving credentials or executing any evaluation work.
    const document = parseWorkflowDocument(template.expand(template.example));
    // Validate starter wiring with the bundled defaults; generating YAML must not
    // require or modify the user's runtime network configuration.
    await bindWorkflowNetwork(document, registry.ctx.evaluator.workflows, {
      env: {}, networkConfigPath: fileURLToPath(new URL("../../playbook/network/official.yaml", import.meta.url)),
    });
    compileWorkflow(document, registry.ctx.evaluator.workflows);
    await writeFile(resolve(destination), stringify(input), { flag: "wx", mode: 0o600 });
  } finally { await registry.dispose(); }
}

export async function retryWorkflow(directory: string, options: {
  patchPath?: string; taskIds?: readonly string[]; requestId?: string; reason?: string;
  signal?: AbortSignal; env?: Record<string, string | undefined>;
  onEvent?: WorkflowExecutorOptions["onEvent"];
} = {}): Promise<{ record: WorkflowRunRecord; directory: string; queued: boolean; request: RetryRequest }> {
  const root = await locateRun(directory);
  const metadata = await readWorkflowReporting(root);
  const originalPatch = options.patchPath ?? (typeof metadata?.patchPath === "string" ? metadata.patchPath : undefined);
  const registry = await openPluginRegistry(originalPatch);
  try {
    const saved = workflowObject(JSON.parse(await readFile(join(root, "plan.json"), "utf8")));
    await registry.loadRecordedPlugins(saved.sources);
    const sources = { ...registry.pluginVersions };
    for (const key of Object.keys(workflowObject(saved.sources))) if (key.startsWith("template:"))
      sources[key] = registry.ctx.evaluator.workflows.template(key.slice("template:".length)).version;
    const plan = compileWorkflow(parseCompiledWorkflowDocument(saved.document), registry.ctx.evaluator.workflows, sources);
    if (saved.fingerprint !== plan.fingerprint) throw new TypeError("Saved workflow or installed plugins changed; retry requires the original implementations");
    let deployment: unknown;
    try { deployment = JSON.parse(await readFile(join(root, "workflow-deployment.json"), "utf8")); }
    catch (error) { if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") throw error; }
    if (deployment) return await retryWorkflowJobs(root, deployment, plan,
      workflowPlanCredentialNames(plan, registry.ctx.evaluator.workflows), options);
    return await executeWorkflowRetry(plan, registry, root, options);
  } finally { await registry.dispose(); }
}

export type WorkflowRunResult = { record: WorkflowRunRecord; directory: string };

/** Application cleanup errors retain the result already committed by the executor. */
export class WorkflowRunError extends Error {
  constructor(readonly phase: "config" | "execute" | "dispose", readonly result: WorkflowRunResult | null, cause: unknown) {
    super(cause instanceof Error ? cause.message : `Workflow ${phase} failed`, { cause });
  }
}

export async function runWorkflow(options: WorkflowOptions): Promise<WorkflowRunResult> {
  const registry = await openPluginRegistry(options.patchPath);
  let result: WorkflowRunResult | null = null, failure: unknown, failed = false;
  let phase: "config" | "execute" = "config";
  try {
    const file = resolve(options.configPath);
    const { plan, deployment, outputDirectory, origins } = await readWorkflowConfiguration(file, registry, options.env, options.networkConfigPath, options.parameterOverrides, options);
    phase = "execute";
    if (deployment) {
      const { kind: _kind, ...config } = deployment;
      result = await runWorkflowJobs({ ...config, transport: "jobs" }, plan,
        workflowPlanCredentialNames(plan, registry.ctx.evaluator.workflows), {
          configDirectory: dirname(file), outputDirectory, env: options.env ?? process.env,
          prepareDirectory: directory => saveWorkflowReporting(plan, registry, directory, dirname(file)),
          signal: options.signal ?? new AbortController().signal,
          ...(options.resume === undefined ? {} : { resume: options.resume }),
          ...(options.onEvent ? { onEvent: options.onEvent } : {}),
        });
      await saveWorkflowReporting(plan, registry, result.directory, dirname(file));
    } else result = await executeWorkflowPlan(plan, registry, { ...options, origins: { ...origins, ...(options.patchPath ? { patchFile: resolve(options.patchPath) } : {}) } });
  } catch (error) { failed = true; failure = error; if (error instanceof WorkflowCompletionError) result = error.result; }
  try { await registry.dispose(); }
  catch (error) { throw new WorkflowRunError("dispose", result, failed ? new AggregateError([failure, error], "Workflow and cleanup failed") : error); }
  if (failed) throw new WorkflowRunError(phase, result, failure);
  if (!result) throw new Error("Workflow returned no result");
  return result;
}
