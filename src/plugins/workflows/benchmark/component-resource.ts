import type { Context } from "@deepseek-ai/cordis";
import type { PluginConfigTransport } from "../../../core/contracts/config-transport.js";
import type { Selection } from "../../../core/contracts/config.js";
import type { PluginRole, PluginConfigValidator, PluginFactory, FactoryContext, PreparedPlugin, RoleImplementations } from "../../../core/contracts/plugin.js";
import type { WorkflowDefinitions } from "../../../core/workflow/catalog.js";
import type { WorkflowContext } from "../../../core/contracts/workflow.js";
import { workflowObject } from "../../../core/workflow/values.js";
import { credentialReference, configurationCredentials, resolveConfigurationCredentials } from "../../../core/validation/credential.js";

const roles: readonly PluginRole[] = ["benchmark", "environment", "solver", "verifier", "metrics", "reporter", "store", "scheduler"];
const typeName = (role: string, name: string) => `native.${role}.${name}`;

/** Native Benchmark implementations are ordinary resources with a declared factory-context dependency. */
export function registerNativeResource<R extends PluginRole, T>(ctx: Context, role: R, name: string,
  validate: PluginConfigValidator<T>, factory: PluginFactory<R, T>, transport?: PluginConfigTransport): () => Promise<void> {
  const type = typeName(role, name);
  if (ctx.evaluator.workflows.hasResource(type)) throw new TypeError(`duplicate ${role} plugin registration: ${name}`);
  return ctx.evaluator.registerResource({ type, apiVersion: 1, version: "1", capabilities: [`native.${role}/v1`],
    resources: { runtime: { capability: "native.factory-context/v1" }, ...(role === "benchmark" ? { verifier: { capability: "native.verifier/v1", optional: true } } : {}) },
    ...(transport ? { configTransport: transport } : {}),
    credentials: config => configurationCredentials(config, transport?.secretFields),
    validateConfig(value) {
      try {
        const config = workflowObject(value), check = { ...config };
        for (const field of transport?.secretFields ?? []) if (credentialReference(config[field])) check[field] = "credential-reference";
        validate(check); return config;
      }
      catch (error) { throw new TypeError(`invalid ${role} plugin config for ${name}: ${error instanceof Error ? error.message : String(error)}`, { cause: error }); }
    },
    async create(config, context) {
      const runtime = context.resource("runtime");
      if (!runtime || typeof runtime !== "object" || !("resolvePath" in runtime) || typeof runtime.resolvePath !== "function" ||
          !("configDirectory" in runtime) || typeof runtime.configDirectory !== "string") throw new TypeError("Native resource requires a factory context");
      if (role !== "metrics" && role !== "reporter" && (!("services" in runtime) || !("solverService" in runtime)))
        throw new TypeError("Native execution resource requires model service bindings");
      const verifier = role === "benchmark" ? context.resource("verifier") : undefined;
      const bound = verifier === undefined ? runtime : { ...runtime, verifier };
      const resolved = await resolveConfigurationCredentials(config, transport?.secretFields ?? [], context.runtime.credential);
      const value = await factory(validate(resolved), bound as FactoryContext<R>);
      let closing: Promise<void> | undefined;
      return { value, identity: {}, dispose() {
        return closing ??= (async () => {
          if ("dispose" in value && typeof value.dispose === "function") await value.dispose();
          else if ("close" in value && typeof value.close === "function") await value.close();
        })();
      } };
    },
  });
}

export function nativeResourceEntries(catalog: WorkflowDefinitions): { role: PluginRole; name: string }[] {
  return catalog.resourceTypes().flatMap(type => {
    const role = roles.find(role => type.startsWith(`native.${role}.`));
    return role ? [{ role, name: type.slice(`native.${role}.`.length) }] : [];
  });
}
export function hasNativeResource(catalog: WorkflowDefinitions, role: string, name: string): boolean { return catalog.hasResource(typeName(role, name)); }
export function nativeResourceTransport(catalog: WorkflowDefinitions, role: string, name: string): PluginConfigTransport | undefined {
  return hasNativeResource(catalog, role, name) ? catalog.resource(typeName(role, name)).configTransport : undefined;
}

/** Application-owned native services use the same resource contract as workflow-owned services. */
export function prepareNativeResource<R extends PluginRole>(ctx: Context, role: R, selection: Selection): PreparedPlugin<R> {
  if (!hasNativeResource(ctx.evaluator.workflows, role, selection.name)) throw new TypeError(`unknown ${role} plugin: ${selection.name}`);
  const provider = ctx.evaluator.workflows.resource(typeName(role, selection.name));
  const config = provider.validateConfig(selection.config);
  return async runtime => {
    const resource = await openNativeResource(ctx, role, { ...selection, config }, runtime);
    ctx.effect(() => resource.dispose, `${provider.type} lifecycle`);
    return resource.value;
  };
}

/** The caller owns this instance and closes it before its dependencies. */
export async function openNativeResource<R extends PluginRole>(ctx: Context, role: R, selection: Selection,
  runtime: FactoryContext<R>, credential: WorkflowContext["runtime"]["credential"] = async name => process.env[name]): Promise<{ value: RoleImplementations[R]; dispose(): Promise<void> }> {
  const provider = ctx.evaluator.workflows.resource(typeName(role, selection.name));
  const config = provider.validateConfig(selection.config);
  const context: WorkflowContext & { checkpoint(): Promise<void> } = {
    workerId: "component-factory", plan: null, runId: "native-service", attemptId: "native-service", path: provider.type, signal: new AbortController().signal, unit: null,
    runtime: { directory: runtime.configDirectory, resolvePath: runtime.resolvePath, credential },
    artifacts: { async read() { throw new Error("Native service factory cannot read evaluation artifacts"); }, async write() { throw new Error("Native service factory cannot write evaluation artifacts"); } },
    resource(name) {
      if (name === "verifier" && role === "benchmark") return "verifier" in runtime ? runtime.verifier : undefined;
      if (name !== "runtime") throw new Error(`Undeclared native dependency ${name}`);
      return runtime;
    },
    async checkpoint() { throw new Error("Native service factories cannot allocate attempt resources"); }, log() {},
  };
  const resource = await provider.create(config, context);
  return { value: resource.value as RoleImplementations[R], async dispose() { await resource.dispose?.(AbortSignal.timeout(60_000)); } };
}

export async function createNativeResource<R extends PluginRole>(ctx: Context, role: R, selection: Selection,
  runtime: FactoryContext<R>): Promise<RoleImplementations[R]> {
  return await prepareNativeResource(ctx, role, selection)(runtime);
}
