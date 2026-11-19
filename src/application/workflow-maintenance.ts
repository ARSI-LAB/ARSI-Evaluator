import { dirname, resolve } from "node:path";
import type { JsonValue } from "../core/contracts/task.js";
import type { WorkflowBlock, WorkflowContext, WorkflowPlan, ResourceBinding, WorkflowResource, WorkflowMaintenanceRequest, WorkflowMaintenanceOutcome } from "../core/contracts/workflow.js";
import { credentialSecrets, redactDiagnostic, formatError, redactEvidence } from "../core/errors/diagnostics.js";
import { MissingWorkflowInput, resolveBinding, workflowDigest, workflowObject } from "../core/workflow/values.js";
import { parseMaintenanceRequest, parseMaintenanceOutcome, type WorkflowMaintenanceResult } from "../core/workflow/maintenance.js";
import { readWorkflowConfiguration, type WorkflowOptions } from "./workflow.js";
import { openPluginRegistry, type PluginRegistry } from "./plugins/open-registry.js";
import { workflowMaintenanceCredentialNames } from "../core/workflow/credentials.js";
import { maintainWorkflowJobs } from "./ray/workflow-jobs.js";
import { safeProgress } from "../core/progress/live-progress.js";

export async function maintainWorkflow(options: WorkflowOptions, request: WorkflowMaintenanceRequest): Promise<WorkflowMaintenanceResult[]> {
  request = parseMaintenanceRequest(request);
  const registry = await openPluginRegistry(options.patchPath);
  try {
    const env = options.env ?? process.env, file = resolve(options.configPath);
    const { plan, deployment, origins } = await readWorkflowConfiguration(file, registry, env, options.networkConfigPath, options.parameterOverrides, options);
    if (deployment) {
      const { kind: _kind, ...config } = deployment;
      return await maintainWorkflowJobs({ ...config, transport: "jobs" }, plan,
        workflowMaintenanceCredentialNames(plan, registry.ctx.evaluator.workflows, request.operation), request, {
          configDirectory: dirname(file), env, signal: options.signal ?? new AbortController().signal,
          ...(options.onEvent ? { onEvent: options.onEvent } : {}),
        });
    }
    return await maintainWorkflowPlan(plan, registry, { ...options, request,
      origins: { ...origins, ...(options.patchPath ? { patchFile: resolve(options.patchPath) } : {}) } });
  } finally { await registry.dispose(); }
}

export async function maintainWorkflowPlan(plan: WorkflowPlan, registry: PluginRegistry, options: Pick<WorkflowOptions, "env" | "signal" | "onEvent"> & {
  request: WorkflowMaintenanceRequest; origins?: WorkflowContext["runtime"]["origins"]; resolvePath?: WorkflowContext["runtime"]["resolvePath"]; credential?: WorkflowContext["runtime"]["credential"];
}): Promise<WorkflowMaintenanceResult[]> {
  const env = options.env ?? process.env, signal = options.signal ?? new AbortController().signal;
  const request = parseMaintenanceRequest(options.request);
  if (request.operation === "warmup" && Object.keys(request.options).length) throw new TypeError("Warmup accepts no maintenance options");
  const results: WorkflowMaintenanceResult[] = [], visited = new Map<string, WorkflowMaintenanceOutcome>();
  const secrets = Object.entries(env).filter(([name]) => /(?:KEY|TOKEN|PASSWORD|SECRET)$/iu.test(name))
    .flatMap(([, value]) => value ? credentialSecrets(value) : []);
  const credential = options.credential ?? (async (name: string) => env[name]);
  const context: WorkflowContext = { workerId: "maintenance", plan: { fingerprint: plan.fingerprint, sources: plan.sources, implementations: plan.implementations }, runId: "maintenance", attemptId: "maintenance", path: "maintenance", unit: null, signal,
    runtime: { directory: plan.document.output.directory, ...(options.origins ? { origins: options.origins } : {}), resolvePath: options.resolvePath ?? (path => resolve(plan.document.pathBase ?? ".", path)), async credential(name) {
      const value = await credential(name);
      if (value) secrets.push(...credentialSecrets(value));
      return value;
    } },
    resource() { throw new Error("Maintenance cannot create evaluation resources"); },
    artifacts: { async write() { throw new Error("Maintenance cannot write evaluation artifacts"); }, async read() { throw new Error("Maintenance cannot read evaluation artifacts"); } },
    log(message, progress) { options.onEvent?.({ path: "maintenance", status: "running", message: redactDiagnostic(message, secrets),
      ...(progress ? { progress: safeProgress(progress, secrets) } : {}) }); },
  };
  const opened = new Map<ResourceBinding, Map<string, WorkflowResource>>();
  const releases: WorkflowResource[] = [];
  const resolveConfig = (binding: ResourceBinding, values: Map<string, JsonValue>) =>
    registry.ctx.evaluator.workflows.resource(binding.use).validateConfig(Object.fromEntries(Object.entries(binding.config).map(([key, value]) => [key, resolveBinding(value, values)])));
  function dependencyIdentity(binding: ResourceBinding, values: Map<string, JsonValue>, definitions: Map<string, ResourceBinding>, ancestors: ResourceBinding[] = [], ports: readonly string[] = Object.keys(binding.resources)): JsonValue {
    if (ancestors.includes(binding)) throw new TypeError("Maintenance resource dependency cycle");
    return { type: binding.use, config: resolveConfig(binding, values), dependencies: Object.fromEntries(
      Object.entries(binding.resources).filter(([port]) => ports.includes(port)).map(([port, name]) => {
        const target = definitions.get(name);
        if (!target) throw new TypeError(`Missing maintenance dependency ${name}`);
        return [port, dependencyIdentity(target, values, definitions, [...ancestors, binding])];
      })) };
  }
  async function dependency(name: string, values: Map<string, JsonValue>, definitions: Map<string, ResourceBinding>): Promise<unknown> {
    const binding = definitions.get(name);
    if (!binding) throw new TypeError(`Missing maintenance dependency ${name}`);
    const provider = registry.ctx.evaluator.workflows.resource(binding.use);
    if (!provider.availableDuringMaintenance) throw new TypeError(`Resource ${name} cannot be created during maintenance`);
    const config = resolveConfig(binding, values), key = workflowDigest(dependencyIdentity(binding, values, definitions));
    let instances = opened.get(binding);
    if (!instances) { instances = new Map(); opened.set(binding, instances); }
    const existing = instances.get(key); if (existing) return existing.value;
    const resources = await dependencies(binding, values, definitions);
    const created = await provider.create(config, { ...context, binding: name, path: name, resource: port => resources.get(port),
      async checkpoint() { throw new TypeError("Maintenance dependencies cannot allocate recoverable evaluation state"); },
    });
    instances.set(key, created); releases.push(created);
    return created.value;
  }
  async function dependencies(binding: ResourceBinding, values: Map<string, JsonValue>, definitions: Map<string, ResourceBinding>, ports: readonly string[] = Object.keys(binding.resources)) {
    const resources = new Map<string, unknown>();
    for (const [port, name] of Object.entries(binding.resources)) {
      if (!ports.includes(port)) continue;
      const provider = registry.ctx.evaluator.workflows.resource(definitions.get(name)?.use ?? "");
      if (provider.availableDuringMaintenance) resources.set(port, await dependency(name, values, definitions));
    }
    return resources;
  }
  async function visit(block: WorkflowBlock, values: Map<string, JsonValue>, path: string, inherited = new Map<string, ResourceBinding>()) {
    const definitions = new Map([...inherited, ...Object.entries(block.resources)]);
    for (const [name, binding] of Object.entries(block.resources)) {
      signal.throwIfAborted();
      const provider = registry.ctx.evaluator.workflows.resource(binding.use), at = `${path}.resources.${name}`;
      const operation = request.operation === "warmup" ? undefined : provider.maintenance?.[request.operation];
      if (request.operation === "warmup" ? !provider.warmup : !operation) { results.push({ path: at, provider: provider.type, status: "not-required" }); continue; }
      try {
        const config = resolveConfig(binding, values);
        const identity = workflowDigest(dependencyIdentity(binding, values, definitions, [], operation?.resources));
        if (!visited.has(identity)) {
          const parameters = operation?.validateRequest(request.options);
          const resources = await dependencies(binding, values, definitions, operation?.resources);
          const active = { ...context, path: at, resource: (name: string) => resources.get(name) };
          let outcome: WorkflowMaintenanceOutcome;
          if (operation) outcome = parseMaintenanceOutcome(await operation.execute(config, parameters ?? {}, active));
          else outcome = parseMaintenanceOutcome(await provider.warmup?.(config, active) ?? { status: "passed", output: {} });
          visited.set(identity, parseMaintenanceOutcome(redactEvidence(outcome, secrets)));
        }
        const outcome = visited.get(identity);
        if (!outcome) throw new Error("Missing maintenance result");
        results.push({ path: at, provider: provider.type, ...outcome });
      } catch (error) {
        if (!(error instanceof MissingWorkflowInput)) throw error;
        results.push({ path: at, provider: provider.type, status: "deferred" });
      }
    }
    for (const node of block.steps) {
      if (node.kind === "step") continue;
      const at = `${path}.${node.id}`;
      if (node.kind === "sequence") { await visit(node.body, new Map(values), at, definitions); continue; }
      let items: JsonValue;
      try { items = resolveBinding(node.items, values); }
      catch (error) { if (!(error instanceof MissingWorkflowInput)) throw error; await visit(node.body, new Map(values), at, definitions); continue; }
      if (!Array.isArray(items)) throw new TypeError(`${at} requires an array`);
      for (const [index, item] of items.entries()) for (const variant of node.matrix.variants) for (let repetition = 0; repetition < node.matrix.repetitions; repetition++) {
        const child = new Map(values); child.set(node.as, item);
        if (node.mode === "units") { child.set("variant", variant); child.set("repetition", repetition); }
        await visit(node.body, child, `${at}[${index}/${variant.id}/${repetition}]`, definitions);
      }
    }
  }
  const errors: unknown[] = [];
  try { await visit(plan.document.workflow, new Map(Object.entries(plan.document.inputs).map(([name, value]) => [`inputs.${name}`, value])), "workflow"); }
  catch (error) { errors.push(error); }
  for (const resource of releases.reverse()) {
    try { await resource.dispose?.(AbortSignal.timeout(plan.document.run.cleanupTimeoutSeconds * 1000)); }
    catch (error) { errors.push(error); }
  }
  if (errors.length) throw new Error(formatError(errors.length === 1 ? errors[0] : new AggregateError(errors, "Workflow maintenance or dependency cleanup failed"), secrets));
  return results;
}
