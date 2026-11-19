import type { RetryAdmission, RetryRequest } from "../contracts/retry-control.js";
import { WorkflowUnitQueue } from "./unit-queue.js";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { JsonValue } from "../contracts/task.js";
import type {
  ExecutionUnitIdentity, StepRunRecord, WorkflowBlock, WorkflowCatalog, WorkflowContext, WorkflowExecutorOptions,
  WorkflowAdmission, WorkflowRetryPolicy, WorkflowFailure, WorkflowForEach, WorkflowNode, WorkflowObject, WorkflowPlan, WorkflowRunRecord, WorkflowUnitRecord,
} from "../contracts/workflow.js";
import { credentialSecrets, redactDiagnostic } from "../errors/diagnostics.js";
import { safeProgress } from "../progress/live-progress.js";
import { abortable, WorkflowResourceScope, resourceAllocationId } from "./resources.js";
import { MissingWorkflowInput, resolveBinding, workflowDigest, workflowObject, workflowValue } from "./values.js";
import { readWorkflowCollection } from "./collections.js";
import { resolveUnitRequest, workflowDispatchFingerprint } from "./unit-request.js";
import { dispatchWorkflowUnit } from "./dispatch.js";
import type { WorkflowUnitExecutor, WorkflowUnitRequest } from "../contracts/workflow.js";
import { expectNonEmptyString, rejectUnknown } from "../validation/input.js";

type Frame = {
  values: Map<string, JsonValue>; scope: WorkflowResourceScope; path: string;
  workerId: string; attemptId: string; unit: ExecutionUnitIdentity | null; signal: AbortSignal;
};
type BlockResult = { outputs: WorkflowObject; complete: boolean; stop: boolean };

/** Execute only a compiled plan. Plugins never receive the mutable run record. */
export async function executeWorkflow(plan: WorkflowPlan, catalog: WorkflowCatalog, options: WorkflowExecutorOptions): Promise<WorkflowRunRecord> {
  return execute(plan, catalog, options);
}

/** A worker executes the assigned body with the same step runner as local execution. */
export async function executeWorkflowUnit(request: WorkflowUnitRequest, catalog: WorkflowCatalog,
  options: Omit<WorkflowExecutorOptions, "previous" | "retryUnitKeys" | "retryController" | "runId"> & { workerId: string }): Promise<WorkflowRunRecord> {
  const assignment = resolveUnitRequest(request, catalog);
  return execute(request.plan, catalog, { ...options, runId: request.runId }, { request, ...assignment, workerId: options.workerId });
}

export async function recoverWorkflowUnit(request: WorkflowUnitRequest, previous: WorkflowRunRecord, catalog: WorkflowCatalog,
  options: Omit<WorkflowExecutorOptions, "previous" | "retryUnitKeys" | "retryController" | "runId"> & { workerId: string }): Promise<WorkflowRunRecord> {
  if (previous.runId !== request.runId || previous.units.length !== 1 || previous.units[0]?.attemptId !== request.unit.attemptId)
    throw new TypeError("Recovery record does not belong to the assigned unit");
  return execute(request.plan, catalog, { ...options, previous, runId: request.runId },
    { request, ...resolveUnitRequest(request, catalog), workerId: options.workerId, recoverOnly: true });
}

async function execute(plan: WorkflowPlan, catalog: WorkflowCatalog, options: WorkflowExecutorOptions,
  placement?: ReturnType<typeof resolveUnitRequest> & { request: WorkflowUnitRequest; workerId: string; recoverOnly?: boolean }): Promise<WorkflowRunRecord> {
  if (plan.fingerprint !== workflowDigest({ document: plan.document, implementations: plan.implementations, sources: plan.sources, outputs: plan.outputs }))
    throw new TypeError("Workflow plan changed after compilation");
  for (const [key, version] of Object.entries(plan.implementations)) {
    const split = key.indexOf(":");
    const kind = key.slice(0, split), type = key.slice(split + 1);
    const actual = kind === "step" ? catalog.step(type).version : catalog.resource(type).version;
    if (actual !== version) throw new TypeError(`Workflow implementation changed: ${key}`);
  }
  if (options.previous && (options.previous.schemaVersion !== 2 || options.previous.fingerprint !== plan.fingerprint))
    throw new TypeError("Cannot resume a different workflow, input, or plugin implementation");
  const cleanupTimeoutMs = plan.document.run.cleanupTimeoutSeconds * 1000;
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(new DOMException("Run deadline exceeded", "TimeoutError")), plan.document.run.timeoutSeconds * 1000);
  timer.unref();
  const signal = AbortSignal.any([options.signal, deadline.signal]);
  const record: WorkflowRunRecord = options.previous ? structuredClone(options.previous) : {
    schemaVersion: 2, runId: options.runId ?? randomUUID(), fingerprint: plan.fingerprint, implementations: plan.implementations,
    startedAt: new Date().toISOString(), finishedAt: null, status: "running", businessComplete: false, outputs: {}, units: [], steps: [], resources: [], artifacts: [], errors: [],
  };
  let writes = Promise.resolve();
  let persistenceError: unknown;
  let acceptingRecords = true;
  const secrets = (options.secrets ?? []).flatMap(credentialSecrets);
  const runtime = options.runtime ?? { directory: resolve(plan.document.output.directory, record.runId),
    resolvePath: (path: string) => resolve(plan.document.pathBase ?? ".", path), credential: async () => undefined };
  const protectedRuntime: WorkflowContext["runtime"] = { ...runtime, async credential(name) {
    const value = await runtime.credential(name);
    if (value && !secrets.includes(value)) secrets.push(...credentialSecrets(value));
    return value;
  } };
  const assertRecording = () => { if (!acceptingRecords) throw new Error("Workflow run has closed its writer"); };
  const save = (final = false) => {
    if (!final) assertRecording();
    const snapshot = structuredClone(record);
    writes = writes.then(() => options.store.save(snapshot));
    void writes.catch(error => { persistenceError = error; deadline.abort(error); });
    return writes;
  };
  const failure = (path: string, error: unknown): WorkflowFailure => ({ path,
    code: error instanceof MissingWorkflowInput ? error.code : error instanceof Error && error.name === "TimeoutError" ? "WORKFLOW_TIMEOUT" : "WORKFLOW_FAILED",
    message: redactDiagnostic(error instanceof Error ? error.message : String(error), secrets),
  });
  const identity = Object.freeze({ fingerprint: plan.fingerprint, sources: Object.freeze({ ...plan.sources }),
    implementations: Object.freeze({ ...plan.implementations }) });
  const context = (frame: Frame, resources = new Map<string, unknown>()): WorkflowContext => ({
    plan: identity, workerId: frame.workerId, runId: record.runId, attemptId: frame.attemptId, path: frame.path, unit: frame.unit, signal: frame.signal,
    runtime: protectedRuntime,
    resource(name) {
      if (!resources.has(name)) throw new TypeError(`Step ${frame.path} requested undeclared resource ${name}`);
      return resources.get(name);
    },
    artifacts: {
      async write(name, content, metadata) {
        assertRecording();
        // Cancellation stops evaluation, but cleanup must still persist its evidence.
        // The writer closes only after resource cleanup finishes or reaches its deadline.
        const artifact = await options.store.artifacts(`${frame.attemptId}/${frame.path}`).write(name, content, metadata);
        assertRecording();
        record.artifacts.push(artifact);
        await save();
        return artifact;
      },
      read: artifact => options.store.artifacts(frame.path).read(artifact),
    },
    log(message, progress) { options.onEvent?.({ path: frame.path, status: "running", message: redactDiagnostic(message, secrets),
      ...(progress ? { progress: safeProgress(progress, secrets) } : {}) }); },
  });
  const scope = (path: string, attemptId: string, currentSignal: AbortSignal, body: WorkflowBlock, parent?: WorkflowResourceScope, unit = false, workerId?: string) =>
    new WorkflowResourceScope({ catalog, path, attemptId, signal: currentSignal, cleanupTimeoutMs, definitions: body.resources, unit, ...(workerId ? { workerId } : {}),
      failure, async record(resource) {
        assertRecording();
        const key = resourceAllocationId(resource);
        const index = record.resources.findIndex(item => resourceAllocationId(item) === key);
        // Resource cleanup can finish after the run returns. It must not mutate a
        // committed snapshot or write through a lock now owned by a resumed run.
        const snapshot = structuredClone(resource);
        if (index < 0) record.resources.push(snapshot);
        else record.resources[index] = snapshot;
        await save();
      } }, parent);
  const empty: WorkflowBlock = { resources: {}, steps: [], outputs: {}, required: [] };
  const rootAttempt = randomUUID();
  const rootScope = scope(placement ? `worker:${placement.workerId}` : "workflow", rootAttempt, signal,
    placement ? { ...empty, resources: placement.resources } : plan.document.workflow, undefined, false, placement?.workerId ?? "coordinator");
  const root: Frame = { workerId: placement?.workerId ?? "coordinator", path: "workflow", attemptId: rootAttempt, signal, scope: rootScope, unit: null,
    values: new Map(Object.entries(plan.document.inputs).map(([key, value]) => [`inputs.${key}`, value])) };

  const retryQueues = new Map<string, { reserve(key: string): RetryAdmission | undefined }>();
  async function admitRetries(requests: RetryRequest[]): Promise<RetryAdmission> {
    const reservations: RetryAdmission[] = [];
    const latest = new Map(record.units.map(unit => [unit.key, unit]));
    for (const request of requests) {
      for (const unit of latest.values()) {
        if (unit.status === "running" || unit.status === "completed" || unit.cleanupStatus !== "cleaned" ||
            request.taskIds.length && !request.taskIds.includes(unit.caseId)) continue;
        const reservation = retryQueues.get(unit.key)?.reserve(unit.key);
        if (!reservation) continue;
        reservations.push(reservation);
        request.bindings = { ...request.bindings, [unit.key]: unit.attemptId };
      }
      request.status = Object.keys(request.bindings).length ? "accepted" : "rejected";
      request.message = request.status === "accepted" ? "Queued fresh workflow attempts" : "No eligible idle failed units in an active workflow block";
    }
    return { commit() { for (const item of reservations) item.commit(); }, release() { for (const item of reservations) item.release(); } };
  }

  function assertReplay(attemptIds: Set<string>) {
    const external = record.steps.find(step => {
      if (!attemptIds.has(step.attemptId) || step.status === "skipped" || step.plugin === "sequence" || step.plugin === "forEach") return false;
      const definition = catalog.step(step.plugin);
      return definition.effects === "external-write" && definition.replay !== "safe";
    });
    if (external) throw new Error(`Cannot automatically repeat external write ${external.path}; the plugin must reconcile its external state or guarantee idempotent replay`);
  }

  async function runStep(node: WorkflowNode, parent: Frame): Promise<boolean> {
    const path = `${parent.path}.${node.id}`;
    const row: StepRunRecord = { path, attemptId: parent.attemptId,
      plugin: node.kind === "step" ? node.use : node.kind, status: "running",
      startedAt: new Date().toISOString(), finishedAt: null, outputs: {}, errors: [] };
    record.steps.push(row);
    await save();
    const stepDeadline = new AbortController();
    const stepTimer = node.timeoutSeconds === undefined ? undefined : setTimeout(() =>
      stepDeadline.abort(new DOMException(`Step ${path} exceeded its deadline`, "TimeoutError")), node.timeoutSeconds * 1000);
    stepTimer?.unref();
    const active = AbortSignal.any([parent.signal, stepDeadline.signal]);
    const stepScope = scope(path, parent.attemptId, active, empty, parent.scope);
    const frame: Frame = { ...parent, path, signal: active, scope: stepScope };
    let completed = false;
    try {
      active.throwIfAborted();
      options.onEvent?.({ path, status: "running", message: `Starting ${node.kind === "step" ? node.use : node.kind}` });
      if (node.when) {
        const allowed = resolveBinding(node.when, parent.values);
        if (typeof allowed !== "boolean") throw new TypeError(`${path}.when must resolve to a boolean`);
        if (!allowed) { row.status = "skipped"; return true; }
      }
      if (node.kind === "step") {
        const definition = catalog.step(node.use);
        const inputs: WorkflowObject = {};
        for (const [key, port] of Object.entries(definition.inputs)) {
          const binding = node.inputs[key];
          if (!binding) { if (port.optional) continue; throw new MissingWorkflowInput(`${path}.inputs.${key} is required`); }
          try { inputs[key] = workflowValue(port.validate(resolveBinding(binding, parent.values)), `${path}.inputs.${key}`); }
          catch (error) { if (port.optional && error instanceof MissingWorkflowInput) continue; throw error; }
        }
        const resources = new Map<string, unknown>(Object.keys(definition.resources).map(name => [name, undefined]));
        for (const [key, name] of Object.entries(node.resources)) resources.set(key, await stepScope.acquire(name, parent.values, context(frame)));
        const configuration = workflowObject(definition.validateConfig(node.config));
        const output = await abortable(Promise.resolve().then(() => definition.execute(Object.freeze(inputs), Object.freeze(configuration), context(frame, resources))), active);
        active.throwIfAborted();
        const data = workflowObject(output, `${path}.outputs`);
        for (const key of Object.keys(data)) if (!definition.outputs[key]) throw new TypeError(`${path}: undeclared output ${key}`);
        for (const [key, port] of Object.entries(definition.outputs)) {
          if (!Object.hasOwn(data, key)) { if (port.optional) continue; throw new TypeError(`${path}: missing output ${key}`); }
          row.outputs[key] = workflowValue(port.validate(data[key]), `${path}.outputs.${key}`);
        }
      } else if (node.kind === "sequence") {
        const childScope = scope(path, parent.attemptId, active, node.body, stepScope);
        try {
          const result = await runBlock(node.body, { ...frame, values: new Map(parent.values), scope: childScope });
          row.outputs = result.outputs;
          if (!result.complete) throw new Error(`${path}: required subflow results are missing`);
        } finally { row.errors.push(...await childScope.close()); }
      } else {
        const results = await runEach(node, frame);
        row.outputs.results = results;
        if (node.mode === "sequence" && results.some(value => {
          const result = workflowObject(value);
          return result.status === "failed" || result.status === "cancelled";
        })) throw new Error(`${path}: sequential execution did not complete`);
      }
      row.status = "completed";
      // Commit before exposing output to a consumer.
      await save();
      for (const [key, value] of Object.entries(row.outputs)) parent.values.set(`${node.id}.outputs.${key}`, value);
      completed = true;
    } catch (error) {
      row.status = error instanceof MissingWorkflowInput ? "blocked" : parent.signal.aborted ? "cancelled" : "failed";
      row.errors.push(failure(path, error));
    } finally {
      if (stepTimer !== undefined) clearTimeout(stepTimer);
      row.errors.push(...await stepScope.close());
      row.finishedAt = new Date().toISOString();
      options.onEvent?.({ path, status: row.status, message: row.errors[0]?.message ?? row.status });
      await save();
    }
    return completed || node.onError === "continue";
  }

  async function runBlock(body: WorkflowBlock, frame: Frame): Promise<BlockResult> {
    let stop = false;
    for (const node of body.steps) {
      if (frame.signal.aborted || stop) break;
      if (!await runStep(node, frame)) stop = true;
    }
    const outputs: WorkflowObject = {};
    for (const [key, binding] of Object.entries(body.outputs)) {
      try { outputs[key] = resolveBinding(binding, frame.values); }
      catch (error) { if (!(error instanceof MissingWorkflowInput)) throw error; }
    }
    const complete = body.required.length ? body.required.every(key => Object.hasOwn(outputs, key)) : !stop && !frame.signal.aborted;
    return { outputs, complete, stop };
  }

  async function runEach(node: WorkflowForEach, frame: Frame): Promise<JsonValue[]> {
    const items = await readWorkflowCollection(resolveBinding(node.items, frame.values), context(frame).artifacts);
    const cases = new Set<string>();
    const jobs: { item: JsonValue; variant: WorkflowObject; identity: ExecutionUnitIdentity; key: string }[] = [];
    for (const [index, item] of items.entries()) {
      const id = item !== null && !Array.isArray(item) && typeof item === "object" ? item.id : undefined;
      if (node.mode === "units" && (typeof id !== "string" || !id)) throw new TypeError(`${frame.path}: every independent sample requires a stable string id`);
      const caseId = typeof id === "string" ? id : String(index);
      if (cases.has(caseId)) throw new TypeError(`${frame.path}: duplicate sample id ${caseId}`);
      cases.add(caseId);
      for (const variant of node.matrix.variants) for (let repetition = 0; repetition < node.matrix.repetitions; repetition++) {
        const identity = { caseId, variantId: String(variant.id), repetition };
        jobs.push({ item, variant, identity, key: `${frame.path}:${workflowDigest(identity)}` });
      }
    }
    const results: JsonValue[] = new Array(jobs.length);
    const controller = new AbortController();
    let unitSignal = AbortSignal.any([frame.signal, controller.signal]);
    let admission: WorkflowAdmission | undefined;
    let executor: WorkflowUnitExecutor | undefined;
    let retryPolicy: WorkflowRetryPolicy | undefined;
    if (node.retry) {
      const value = await frame.scope.acquire(node.retry.policy, frame.values, context(frame));
      if (!value || typeof value !== "object" || !("shouldRetry" in value) || typeof value.shouldRetry !== "function")
        throw new TypeError(`${frame.path}: invalid retry policy resource`);
      retryPolicy = value as WorkflowRetryPolicy;
    }
    if (node.executor) {
      const value = await frame.scope.acquire(node.executor, frame.values, context(frame));
      if (!value || typeof value !== "object" || !("execute" in value) || typeof value.execute !== "function" ||
          !("recoveryIdentity" in value) || typeof value.recoveryIdentity !== "function") throw new TypeError(`${frame.path}: invalid unit executor`);
      executor = value as WorkflowUnitExecutor;
    }
    if (node.admission) {
      const value = await frame.scope.acquire(node.admission, frame.values, context(frame));
      if (!value || typeof value !== "object" || !("order" in value) || typeof value.order !== "function")
        throw new TypeError(`${frame.path}: invalid readiness admission resource`);
      admission = value as WorkflowAdmission;
      if (admission.failureSignal !== undefined) {
        if (!(admission.failureSignal instanceof AbortSignal)) throw new TypeError(`${frame.path}: invalid admission failure signal`);
        unitSignal = AbortSignal.any([unitSignal, admission.failureSignal]);
      }
    }
    async function* ready(source: WorkflowAdmission) {
      for await (const identity of source.order(jobs.map(job => job.identity), unitSignal))
        yield `${frame.path}:${workflowDigest(identity)}`;
    }
    const queue = new WorkflowUnitQueue(jobs.map((job, index) => ({ ...job, index })), admission ? ready(admission) : undefined);
    if (node.mode === "units") {
      for (const job of jobs) retryQueues.set(job.key, queue);
      await options.retryController?.setAdmission(admitRetries);
    }
    const executeJob = async (job: typeof jobs[number], index: number, admittedRetry: boolean, workerScope: WorkflowResourceScope, workerId: string) => {
        unitSignal.throwIfAborted();
        const history = node.mode === "units" ? record.units.filter(unit => unit.key === job.key) : [];
        const inputFingerprint = workflowDigest({ item: job.item, variant: job.variant, repetition: job.identity.repetition,
          ...(admission?.reuseInputs ? { business: await admission.reuseInputs(job.identity) } : { bindings: Object.fromEntries(frame.values) }) });
        const latest = history.at(-1);
        const completed = latest?.status === "completed" && latest.inputFingerprint === inputFingerprint ? latest : undefined;
        if (completed) {
          results[index] = workflowValue(completed);
          return;
        }
        if (latest && latest.cleanupStatus === "cleaned" && latest.inputFingerprint === inputFingerprint && admission?.reconcile) {
          const restored = await admission.reconcile(structuredClone(latest), structuredClone(node.body),
            context({ ...frame, path: `${frame.path}.reconcile-${latest.attemptId}`, attemptId: latest.attemptId, signal: unitSignal, unit: job.identity }));
          unitSignal.throwIfAborted();
          if (restored !== undefined) {
            const outputs = workflowObject(restored, "restored unit outputs");
            rejectUnknown(outputs, Object.keys(node.body.outputs), "restored unit outputs");
            for (const name of node.body.required) if (!Object.hasOwn(outputs, name))
              throw new TypeError(`Restored unit is missing required output ${name}`);
            const validate = (body: WorkflowBlock, binding: import("../contracts/workflow.js").ValueBinding, value: JsonValue): JsonValue => {
              if ("value" in binding) {
                if (workflowDigest(value) !== workflowDigest(binding.value)) throw new TypeError("Restored literal output changed");
                return value;
              }
              const [id, marker, name, ...tail] = binding.ref.split(".");
              const producer = body.steps.find(step => step.id === id);
              if (producer && marker === "outputs" && name && !tail.length) {
                if (producer.kind === "step") {
                  const port = catalog.step(producer.use).outputs[name];
                  if (port) return workflowValue(port.validate(value));
                } else if (producer.kind === "sequence" && producer.body.outputs[name])
                  return validate(producer.body, producer.body.outputs[name], value);
              }
              return value;
            };
            for (const [name, value] of Object.entries(outputs)) {
              const binding = node.body.outputs[name];
              if (binding) outputs[name] = validate(node.body, binding, value);
            }
            latest.outputs = outputs; latest.status = "completed";
            results[index] = workflowValue(latest);
            await save();
            return;
          }
        }
        if (node.mode === "units" && !admittedRetry && options.retryUnitKeys && !options.retryUnitKeys.includes(job.key) && latest?.status !== "completed") {
          results[index] = workflowValue(history.at(-1) ?? { ...job.identity, key: job.key, status: "skipped", outputs: {}, errors: [] });
          return;
        }
        assertReplay(new Set(history.map(unit => unit.attemptId)));
        const attemptId = node.mode === "units" ? randomUUID() : frame.attemptId;
        const path = `${frame.path}[${workflowDigest(job.identity).slice(0, 16)}]`;
        const unit: WorkflowUnitRecord = { ...job.identity, key: job.key, inputFingerprint, attemptId,
          ordinal: history.reduce((maximum, value) => Math.max(maximum, value.ordinal), 0) + 1,
          status: "running", cleanupStatus: "cleaned", outputs: {}, errors: [] };
        if (node.mode === "units") { record.units.push(unit); await save(); }
        const childScope = scope(path, attemptId, unitSignal, node.body, workerScope, node.mode === "units");
        const child: Frame = { ...frame, workerId, path, attemptId, scope: childScope, signal: unitSignal,
          unit: node.mode === "units" ? job.identity : frame.unit, values: new Map(frame.values) };
        child.values.set(node.as, job.item);
        if (node.mode === "units") {
          child.values.set("variant", job.variant);
          child.values.set("repetition", job.identity.repetition);
        }
        try {
          if (executor && node.executor) {
            const assigned = { bindings: Object.fromEntries(child.values), unit: structuredClone(unit) };
            let request: WorkflowUnitRequest = { dispatchFingerprint: workflowDispatchFingerprint(assigned), plan, runId: record.runId, blockPath: frame.path.replace(/\[[0-9a-f]{16}\]/g, ""),
              path, ...assigned };
            if (executor.prepare) {
              const prepared = await executor.prepare(structuredClone(request), context(child));
              unitSignal.throwIfAborted();
              if (prepared !== undefined) {
                const value = workflowObject(prepared, "prepared dispatch");
                rejectUnknown(value, ["bindings", "nodeId"], "prepared dispatch");
                request = { ...request, bindings: workflowObject(value.bindings),
                  ...(value.nodeId === undefined ? {} : { nodeId: expectNonEmptyString(value.nodeId, "execution node") }) };
                request.dispatchFingerprint = workflowDispatchFingerprint(request);
              }
            }
            resolveUnitRequest(request, catalog);
            unit.cleanupStatus = "unconfirmed";
            const remote = await dispatchWorkflowUnit(request, executor, frame.scope.provider(node.executor), node.executor,
              { record, store: options.store, signal: unitSignal, save, log: context(child).log });
            const result = remote.units[0];
            if (!result) throw new TypeError("Worker omitted its unit result");
            Object.assign(unit, result);
            unit.errors.push(...remote.errors);
          } else {
            const result = await runBlock(node.body, child);
            unit.outputs = result.outputs;
            unit.status = result.complete ? "completed" : unitSignal.aborted ? "cancelled" : "failed";
            if (node.stopWhen && result.complete) {
              const stop = resolveBinding(node.stopWhen, new Map(Object.entries(result.outputs)));
              if (typeof stop !== "boolean") throw new TypeError(`${path}: stopWhen must be boolean`);
              if (stop) queue.close();
            }
          }
        } catch (error) {
          unit.status = unitSignal.aborted ? "cancelled" : "failed";
          unit.errors.push(failure(path, error));
        } finally {
          const cleanup = await childScope.close();
          unit.errors.push(...cleanup);
          if (cleanup.length || record.resources.some(resource => resource.attemptId === attemptId && resource.state !== "released")) unit.cleanupStatus = "unconfirmed";
          results[index] = workflowValue(unit);
          await save();
        }
        return unit;
    };
    const worker = async (workerScope: WorkflowResourceScope, workerId: string) => {
      while (!unitSignal.aborted) {
        const item = await queue.take(unitSignal);
        if (!item) return;
        try {
          let unit = await executeJob(item.value, item.value.index, item.retry, workerScope, workerId);
          while (unit && retryPolicy && node.retry && unit.status === "failed" && unit.cleanupStatus === "cleaned" &&
              unit.ordinal < node.retry.maxAttempts && !unitSignal.aborted) {
            const activeAttemptId = unit.attemptId;
            const errors = [...unit.errors, ...record.steps.filter(step => step.attemptId === activeAttemptId).flatMap(step => step.errors)];
            const retry = await abortable(retryPolicy.shouldRetry(structuredClone({ ...item.value.identity,
              attemptId: unit.attemptId, ordinal: unit.ordinal, errors }), unitSignal), unitSignal);
            if (typeof retry !== "boolean") throw new TypeError("Retry policy must return a boolean");
            if (!retry) break;
            const message = `Retrying ${unit.caseId}: attempt ${unit.ordinal + 1}/${node.retry.maxAttempts}`;
            context(frame).log(message, { phase: "retry", taskId: unit.caseId, attemptId: unit.attemptId, message });
            unit = await executeJob(item.value, item.value.index, true, workerScope, workerId);
          }
          if (unit && unit.status !== "completed" && (node.onError ?? plan.document.run.onError) === "stop") {
            controller.abort(new Error(`Execution unit ${item.value.identity.caseId} failed`));
            queue.close();
          }
        }
        finally { queue.complete(item.value.key); }
        if (node.mode === "units") {
          const unit = record.units.findLast(unit => unit.key === item.value.key);
          if (unit) options.onEvent?.({ path: `${frame.path}[${workflowDigest(item.value.identity).slice(0, 16)}]`,
            status: unit.status, message: `Execution unit ${unit.caseId}: ${unit.status}` });
        }
      }
    };
    const workers = await Promise.allSettled(Array.from({ length: Math.min(node.concurrency, jobs.length) }, async (_value, index) => {
      const workerId = `${frame.path}:worker-${index}`;
      const workerScope = node.mode === "units" ? scope(workerId, randomUUID(), unitSignal, empty, frame.scope, false, workerId) : frame.scope;
      try { await worker(workerScope, node.mode === "units" ? workerId : frame.workerId); }
      catch (error) { controller.abort(error); throw error; }
      finally { if (workerScope !== frame.scope) record.errors.push(...await workerScope.close()); }
    }));
    controller.abort(new DOMException("Workflow block finished", "AbortError"));
    for (const job of jobs) retryQueues.delete(job.key);
    await abortable(queue.dispose(), AbortSignal.timeout(cleanupTimeoutMs));
    if (admission?.failureSignal?.aborted && !frame.signal.aborted)
      throw admission.failureSignal.reason ?? new Error("Background prerequisite failed");
    const failed = workers.find(result => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
    // Preserve unscheduled units instead of silently dropping the failure denominator.
    for (const [index, job] of jobs.entries()) if (results[index] === undefined) results[index] = {
      ...job.identity, key: job.key, status: "skipped", outputs: {}, errors: [],
    };
    return results;
  }

  async function recoverResources() {
    const allocations = new Map(record.resources.map(resource => [resourceAllocationId(resource), resource]));
    const visited = new Set<string>(), visiting = new Set<string>(), ordered: typeof record.resources = [];
    const visit = (key: string) => {
      if (visited.has(key)) return;
      if (visiting.has(key)) throw new TypeError("Stored resource dependency cycle");
      const resource = allocations.get(key);
      if (!resource) throw new TypeError(`Missing stored resource dependency ${key}`);
      visiting.add(key);
      if (resource.owner) visit(resource.owner);
      for (const dependency of resource.dependencies) visit(dependency);
      visiting.delete(key); visited.add(key); ordered.push(resource);
    };
    for (const key of allocations.keys()) visit(key);
    for (const resource of ordered.reverse().filter(value => !value.owner &&
      (value.state !== "released" || record.resources.some(child => child.owner === resourceAllocationId(value) && child.state !== "released")))) {
      if (resource.state === "pending") { resource.state = "released"; await save(); continue; }
      const provider = catalog.resource(resource.provider);
      if (!provider.recover) throw new Error(`Cannot confirm cleanup for ${resource.key}: provider ${provider.type} has no recovery operation`);
      const cleanupSignal = AbortSignal.timeout(cleanupTimeoutMs);
      await abortable(provider.recover(resource.identity, context({ ...root, signal: cleanupSignal, attemptId: resource.attemptId, path: resource.key })), cleanupSignal);
      resource.state = "released";
      for (const child of record.resources) if (child.owner === resourceAllocationId(resource)) child.state = "released";
      await save();
    }
    for (const unit of record.units) if (!record.resources.some(resource => resource.attemptId === unit.attemptId && resource.state !== "released")) unit.cleanupStatus = "cleaned";
  }

  try {
    if (placement?.recoverOnly) {
      await recoverResources();
      record.status = record.businessComplete ? "completed" : "failed";
      return record;
    }
    if (placement) {
      const { request, node } = placement;
      const unit = structuredClone(request.unit);
      record.units.push(unit);
      await save();
      const unitScope = scope(request.path, unit.attemptId, signal, node.body, rootScope, true);
      const frame: Frame = { ...root, path: request.path, attemptId: unit.attemptId, scope: unitScope,
        values: new Map(Object.entries(request.bindings)), unit: { caseId: unit.caseId, variantId: unit.variantId, repetition: unit.repetition } };
      try {
        const result = await runBlock(node.body, frame);
        unit.outputs = result.outputs;
        unit.status = result.complete ? "completed" : signal.aborted ? "cancelled" : "failed";
      } catch (error) {
        unit.status = signal.aborted ? "cancelled" : "failed";
        unit.errors.push(failure(request.path, error));
      } finally {
        unit.errors.push(...await unitScope.close());
      }
      record.outputs = unit.outputs;
      record.businessComplete = unit.status === "completed";
      record.status = unit.status;
      return record;
    }
    if (options.previous) {
      await recoverResources();
      const validatedResources = new Set<string>();
      for (const resource of record.resources) {
        const provider = catalog.resource(resource.provider);
        const key = workflowDigest({ provider: provider.type, identity: resource.identity });
        if (!provider.validateResume || validatedResources.has(key)) continue;
        await provider.validateResume(resource.identity, context({ ...root, attemptId: resource.attemptId, path: resource.key }));
        validatedResources.add(key);
      }
      const latest = new Map(record.steps.map(step => [step.path, step]));
      const configs = new Map<string, WorkflowObject>();
      const visit = (body: WorkflowBlock, prefix: string) => {
        for (const node of body.steps) {
          const path = `${prefix}.${node.id}`;
          if (node.kind === "step") configs.set(path, node.config);
          else visit(node.body, path);
        }
      };
      visit(plan.document.workflow, "workflow");
      for (const step of latest.values()) if (step.status === "completed" && step.plugin !== "sequence" && step.plugin !== "forEach") {
        const definition = catalog.step(step.plugin);
        const config = configs.get(step.path.replace(/\[[0-9a-f]{16}\]/g, ""));
        if (definition.validateResume && config) await definition.validateResume(step.outputs, config,
          { runId: record.runId, path: step.path, signal, runtime: context(root).runtime });
      }
    }
    if (record.businessComplete) { record.status = "completed"; return record; }
    const unitAttempts = new Set(record.units.map(unit => unit.attemptId));
    assertReplay(new Set(record.steps.filter(step => !unitAttempts.has(step.attemptId)).map(step => step.attemptId)));
    record.status = "running";
    record.finishedAt = null;
    record.errors = [];
    await save();
    const result = await runBlock(plan.document.workflow, root);
    record.outputs = result.outputs;
    const latest = new Map<string, WorkflowUnitRecord>();
    for (const unit of record.units) latest.set(unit.key, unit);
    record.businessComplete = result.complete && [...latest.values()].every(unit => unit.status === "completed");
    record.status = signal.aborted ? "cancelled" : record.businessComplete ? "completed" : "failed";
  } catch (error) {
    record.status = signal.aborted ? "cancelled" : "failed";
    record.errors.push(failure("workflow", error));
  } finally {
    clearTimeout(timer);
    try { await options.retryController?.stopAccepting(); }
    catch (error) { record.errors.push(failure("workflow.retry", error)); }
    const cleanup = await rootScope.close();
    record.errors.push(...cleanup);
    if (record.resources.some(resource => resource.state !== "released")) record.status = record.status === "cancelled" ? "cancelled" : "failed";
    if (placement) {
      const unit = record.units[0];
      if (unit) unit.cleanupStatus = record.resources.some(resource => resource.state !== "released") ? "unconfirmed" : "cleaned";
    }
    record.finishedAt = new Date().toISOString();
    acceptingRecords = false;
    await save(true);
    if (persistenceError !== undefined) throw persistenceError;
  }
  return record;
}
