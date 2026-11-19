import { Service, type Context } from "@deepseek-ai/cordis";
import { WorkflowDefinitions } from "../../core/workflow/catalog.js";
import type { ResourceProvider, StepDefinition, WorkflowTemplate } from "../../core/contracts/workflow.js";
import { parseConfigProfile, type ConfigProfile } from "../../config/profile-schema.js";
import type { PluginConfigValidator, PluginFactoryContext } from "../../core/contracts/plugin.js";
import type { PluginActivation, StoreDecoratorFactory } from "../../core/contracts/plugin-extension.js";

declare module "@deepseek-ai/cordis" {
  interface Context {
    evaluator: EvaluatorRegistry;
  }
}

export class EvaluatorRegistry extends Service {
  private readonly storeDecorators = new Map<string, { validate: PluginConfigValidator<unknown>; factory: StoreDecoratorFactory<unknown> }>();
  readonly workflows = new WorkflowDefinitions();
  private readonly profileRegistrations = new Map<string, ConfigProfile>();

  constructor(ctx: Context) {
    super(ctx, "evaluator");
  }

  registerStoreDecorator<T>(name: string, validate: PluginConfigValidator<T>, factory: StoreDecoratorFactory<T>): () => Promise<void> {
    if (!name.trim()) throw new TypeError("Store decorator name must not be empty");
    return this.ctx.effect(() => {
      if (this.storeDecorators.has(name)) throw new TypeError(`Duplicate store decorator: ${name}`);
      const entry = { validate, factory: factory as StoreDecoratorFactory<unknown> };
      this.storeDecorators.set(name, entry);
      return () => { if (this.storeDecorators.get(name) === entry) this.storeDecorators.delete(name); };
    }, `evaluator.registerStoreDecorator(${JSON.stringify(name)})`);
  }

  private readonly pluginDecorators = new Map<string, string[]>();

  recordStoreDecorators(id: string, names: string[]): void { this.pluginDecorators.set(id, names); }

  prepareStoreDecorators(selections: readonly PluginActivation[]) {
    return selections.flatMap(selection => {
      const names = this.pluginDecorators.get(selection.id);
      if (!names) throw new TypeError(`Plugin ${selection.id} has not been loaded`);
      return names.map(name => this.prepareStoreDecorator(name, selection.config));
    });
  }

  storeDecoratorNames(): string[] { return [...this.storeDecorators.keys()]; }

  prepareStoreDecorator(name: string, config: unknown) {
    const entry = this.storeDecorators.get(name);
    if (!entry) throw new TypeError(`Unknown store decorator: ${name}`);
    const validated = entry.validate(config);
    return (runtime: PluginFactoryContext) => entry.factory(validated, runtime);
  }

  registerStep(definition: StepDefinition): () => Promise<void> {
    return this.ctx.effect(() => this.workflows.registerStep(definition), `workflow step ${definition.type}`);
  }

  registerResource(definition: ResourceProvider): () => Promise<void> {
    return this.ctx.effect(() => this.workflows.registerResource(definition), `workflow resource ${definition.type}`);
  }

  registerWorkflow(definition: WorkflowTemplate): () => Promise<void> {
    return this.ctx.effect(() => this.workflows.registerTemplate(definition), `workflow template ${definition.type}`);
  }

  registerProfile(value: ConfigProfile): () => Promise<void> {
    const profile = parseConfigProfile(value);
    const key = `${profile.role}:${profile.id}`;
    return this.ctx.effect(() => {
      if (this.profileRegistrations.has(key)) throw new TypeError(`duplicate profile registration: ${key}`);
      this.profileRegistrations.set(key, profile);
      return () => { if (this.profileRegistrations.get(key) === profile) this.profileRegistrations.delete(key); };
    }, `evaluator.registerProfile(${JSON.stringify(key)})`);
  }

  profiles(): ConfigProfile[] {
    return structuredClone([...this.profileRegistrations.values()]);
  }

}

export function apply(ctx: Context): void {
  new EvaluatorRegistry(ctx);
}
