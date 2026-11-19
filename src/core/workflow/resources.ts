import type { JsonValue } from "../contracts/task.js";
import type {
  ResourceBinding, WorkflowCatalog, WorkflowContext, WorkflowFailure, WorkflowResource, WorkflowResourceRecord,
} from "../contracts/workflow.js";
import { resolveBinding, workflowDigest, workflowObject } from "./values.js";

export async function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  // Attach handlers even when already cancelled, so late failures remain observed.
  const cancellation = Promise.withResolvers<never>();
  const abort = () => cancellation.reject(signal.reason ?? new DOMException("Cancelled", "AbortError"));
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  try { return await Promise.race([work, cancellation.promise]); }
  finally { signal.removeEventListener("abort", abort); }
}

type ResourceEntry = { promise: Promise<WorkflowResource>; ready: Promise<WorkflowResource>; fingerprint: string; record: WorkflowResourceRecord; dispose?: Promise<void> };
export const resourceAllocationId = (record: Pick<WorkflowResourceRecord, "attemptId" | "key">): string => `${record.attemptId}:${record.key}`;
export type ResourceScopeOptions = {
  catalog: WorkflowCatalog;
  path: string;
  attemptId: string;
  signal: AbortSignal;
  cleanupTimeoutMs: number;
  definitions: Record<string, ResourceBinding>;
  record(value: WorkflowResourceRecord): Promise<void>;
  failure(path: string, error: unknown): WorkflowFailure;
  unit?: boolean;
  workerId?: string;
};

export class WorkflowResourceScope {
  private readonly entries = new Map<string, ResourceEntry>();
  private readonly acquired: ResourceEntry[] = [];
  private readonly errors: WorkflowFailure[] = [];
  private closed = false;

  constructor(readonly options: ResourceScopeOptions, readonly parent?: WorkflowResourceScope) {}

  private declaration(name: string): { owner: WorkflowResourceScope; definition: ResourceBinding } {
    const definition = this.options.definitions[name];
    if (definition) return { owner: this, definition };
    if (this.parent) return this.parent.declaration(name);
    throw new TypeError(`Unavailable resource ${name}`);
  }

  provider(name: string): string { return this.declaration(name).definition.use; }

  private lifetime(definition: ResourceBinding, declaration: WorkflowResourceScope): WorkflowResourceScope {
    if (definition.scope === "step") return this;
    if (definition.scope === "block") return declaration;
    let scope: WorkflowResourceScope = this;
    if (definition.scope === "worker") {
      while (!scope.options.workerId && scope.parent) scope = scope.parent;
      return scope;
    }
    if (definition.scope === "attempt") {
      while (!scope.options.unit && scope.parent) scope = scope.parent;
      return scope;
    }
    while (scope.parent) scope = scope.parent;
    return scope;
  }

  async acquire(name: string, values: ReadonlyMap<string, JsonValue>, context: WorkflowContext,
    chain: readonly string[] = []): Promise<unknown> {
    if (this.closed) throw new Error(`Resource scope ${this.options.path} is closed`);
    const { owner: declaration, definition } = this.declaration(name);
    const owner = this.lifetime(definition, declaration);
    if (owner.closed) throw new Error(`Resource owner ${owner.options.path} is closed`);
    const key = `${declaration.options.path}:${name}`;
    if (chain.includes(key)) throw new TypeError(`Resource dependency cycle: ${[...chain, key].join(" -> ")}`);
    const provider = this.options.catalog.resource(definition.use);
    const config = provider.validateConfig(Object.fromEntries(Object.entries(definition.config)
      .map(([field, binding]) => [field, resolveBinding(binding, values)])));
    const fingerprint = workflowDigest(config);
    const existing = owner.entries.get(key);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new TypeError(`Resource ${name} was already created with different configuration in this scope`);
      return (await abortable(existing.ready, context.signal)).value;
    }
    const record: WorkflowResourceRecord = {
      key: `${owner.options.path}:${key}`, binding: name, provider: provider.type, attemptId: owner.options.attemptId,
      dependencies: [], identity: {}, state: "pending",
    };
    const result = Promise.withResolvers<WorkflowResource>();
    const ready = Promise.withResolvers<WorkflowResource>();
    const entry: ResourceEntry = { promise: result.promise, ready: ready.promise, fingerprint, record };
    owner.entries.set(key, entry);
    // Observe a late creation rejection even after its caller has been cancelled.
    void result.promise.catch(() => {});
    void ready.promise.catch(() => {});
    const create = async () => {
      await owner.options.record(record);
      const dependencies = new Map<string, unknown>(Object.keys(provider.resources).map(name => [name, undefined]));
      for (const [port, binding] of Object.entries(definition.resources)) {
        dependencies.set(port, await this.acquire(binding, values, { ...context, signal: owner.options.signal }, [...chain, key]));
        const dependency = this.declaration(binding);
        const target = this.lifetime(dependency.definition, dependency.owner).entries.get(`${dependency.owner.options.path}:${binding}`);
        if (!target) throw new Error(`Dependency ${binding} has no allocation record`);
        record.dependencies.push(resourceAllocationId(target.record));
      }
      owner.options.signal.throwIfAborted();
      if (owner.closed) throw new Error(`Resource owner ${owner.options.path} closed before creation`);
      record.state = "creating";
      await owner.options.record(record);
      const resource = await provider.create(Object.freeze(structuredClone(config)), {
        binding: name,
        ...context, workerId: owner.options.workerId ?? context.workerId, signal: owner.options.signal, attemptId: owner.options.attemptId, path: record.key,
        unit: owner.options.attemptId === context.attemptId ? context.unit : null,
        async checkpoint(identity) {
          record.identity = workflowObject(identity, `resource ${name} checkpoint`);
          await owner.options.record(record);
        },
        resource(port) {
          if (!dependencies.has(port)) throw new TypeError(`Undeclared resource dependency ${port}`);
          return dependencies.get(port);
        },
      });
      // Ownership transfers immediately, including malformed metadata and cancellation.
      owner.acquired.push(entry);
      result.resolve(resource);
      try {
        record.identity = workflowObject(resource.identity, `resource ${name} identity`);
        record.state = "active";
        await owner.options.record(record);
      } catch (error) {
        owner.errors.push(owner.options.failure(key, error));
        await owner.dispose(entry);
        throw error;
      }
      if (owner.closed || owner.options.signal.aborted) await owner.dispose(entry);
      if (record.state !== "active") throw new Error(`Resource ${name} was released before becoming available`);
      ready.resolve(resource);
    };
    void create().catch(async error => {
      result.reject(error);
      ready.reject(error);
      if (record.state === "pending") {
        record.state = "released";
        try { await owner.options.record(record); } catch (recordError) { owner.errors.push(owner.options.failure(key, recordError)); }
      }
      if (record.state === "creating") {
        // Creation may have reached an external system before failing; do not invent a release receipt.
        record.state = "unconfirmed";
        owner.errors.push(owner.options.failure(key, error));
        try { await owner.options.record(record); } catch (recordError) { owner.errors.push(owner.options.failure(key, recordError)); }
      }
    });
    return (await abortable(entry.ready, context.signal)).value;
  }

  private async dispose(entry: ResourceEntry): Promise<void> {
    if (entry.dispose) return entry.dispose;
    entry.dispose = (async () => {
      try {
        const resource = await entry.promise;
        if (resource.dispose) {
          const signal = AbortSignal.timeout(this.options.cleanupTimeoutMs);
          await abortable(Promise.resolve().then(() => resource.dispose?.(signal)), signal);
        }
        entry.record.state = "released";
      } catch (error) {
        entry.record.state = "unconfirmed";
        this.errors.push(this.options.failure(entry.record.key, error));
      }
      try { await this.options.record(entry.record); }
      catch (error) { this.errors.push(this.options.failure(entry.record.key, error)); }
    })();
    return entry.dispose;
  }

  async close(): Promise<WorkflowFailure[]> {
    this.closed = true;
    // Dependencies are acquired first and released last.
    for (const entry of [...this.acquired].reverse()) await this.dispose(entry);
    for (const entry of this.entries.values()) if (entry.record.state === "creating" || entry.record.state === "pending") {
      if (entry.record.state === "pending") { entry.record.state = "released"; await this.options.record(entry.record); continue; }
      entry.record.state = "unconfirmed";
      this.errors.push({ path: entry.record.key, code: "RESOURCE_CREATION_PENDING", message: "Resource creation has not settled; late resources will be reclaimed" });
      await this.options.record(entry.record);
    }
    return [...this.errors];
  }
}
