import type { ResourceProvider, StepDefinition, WorkflowCatalog, WorkflowTemplate } from "../contracts/workflow.js";

/** No module loading or process state: the application owns registration lifetime. */
export class WorkflowDefinitions implements WorkflowCatalog {
  private readonly steps = new Map<string, StepDefinition>();
  private readonly providers = new Map<string, ResourceProvider>();
  private readonly templates = new Map<string, WorkflowTemplate>();

  private register<T extends { type: string; version: string; apiVersion: number }>(map: Map<string, T>, value: T): () => void {
    if (!/^[a-zA-Z][a-zA-Z0-9_.-]*$/.test(value.type) || !value.version.trim()) throw new TypeError("Invalid workflow plugin identity");
    if (value.apiVersion !== 1) throw new TypeError(`Unsupported API version ${value.apiVersion} for ${value.type}`);
    if (map.has(value.type)) throw new TypeError(`Duplicate workflow registration: ${value.type}`);
    map.set(value.type, value);
    return () => { if (map.get(value.type) === value) map.delete(value.type); };
  }

  registerStep(value: StepDefinition): () => void { return this.register(this.steps, value); }
  registerResource(value: ResourceProvider): () => void {
    for (const [name, operation] of Object.entries(value.maintenance ?? {})) {
      if (!/^[a-z][a-z0-9.-]*$/.test(name) || name === "warmup") throw new TypeError(`Invalid maintenance operation ${name}`);
      if (!Array.isArray(operation.resources) || operation.resources.some(port => !Object.hasOwn(value.resources, port)))
        throw new TypeError(`Maintenance ${name} references an undeclared resource port`);
    }
    return this.register(this.providers, value);
  }
  registerTemplate(value: WorkflowTemplate): () => void { return this.register(this.templates, value); }
  resourceTypes(): string[] { return [...this.providers.keys()]; }
  stepTypes(): string[] { return [...this.steps.keys()]; }
  templateTypes(): string[] { return [...this.templates.keys()]; }
  hasResource(type: string): boolean { return this.providers.has(type); }

  step(type: string): StepDefinition {
    const value = this.steps.get(type);
    if (!value) throw new TypeError(`Unknown workflow step ${type}`);
    return value;
  }
  resource(type: string): ResourceProvider {
    const value = this.providers.get(type);
    if (!value) throw new TypeError(`Unknown workflow resource ${type}`);
    return value;
  }
  template(type: string): WorkflowTemplate {
    const value = this.templates.get(type);
    if (!value) throw new TypeError(`Unknown workflow template ${type}`);
    return value;
  }
}
