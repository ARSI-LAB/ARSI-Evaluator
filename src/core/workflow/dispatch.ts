import type { WorkflowResourceRecord, WorkflowRunRecord, WorkflowStore, WorkflowUnitExecutor, WorkflowUnitRequest } from "../contracts/workflow.js";
import { parseWorkflowRun, validateRecordConsistency } from "./record.js";
import { resourceAllocationId } from "./resources.js";
import { workflowDigest, workflowObject } from "./values.js";
import type { WorkflowContext } from "../contracts/workflow.js";

/** Persist the dispatch receipt before a remote worker can allocate anything. */
export async function dispatchWorkflowUnit(request: WorkflowUnitRequest, executor: WorkflowUnitExecutor,
  provider: string, binding: string, host: { record: WorkflowRunRecord; store: WorkflowStore; signal: AbortSignal;
    save(): Promise<void>; log: WorkflowContext["log"] }): Promise<WorkflowRunRecord> {
  const lease: WorkflowResourceRecord = { key: `${request.path}:dispatch`, binding, provider, attemptId: request.unit.attemptId,
    dependencies: [], identity: workflowObject(executor.recoveryIdentity(request)), state: "creating" };
  const owner = resourceAllocationId(lease);
  host.record.resources.push(lease);
  await host.save();
  let accepting = true;
  const receive = async (input: WorkflowRunRecord, final = false) => {
    if (!accepting) throw new Error("Dispatch has closed its checkpoint writer");
    const snapshot = parseWorkflowRun(input);
    const unit = snapshot.units[0];
    if (snapshot.runId !== request.runId || snapshot.fingerprint !== request.plan.fingerprint ||
        workflowDigest(snapshot.implementations) !== workflowDigest(request.plan.implementations) ||
        snapshot.units.length !== 1 || !unit || unit.attemptId !== request.unit.attemptId || unit.key !== request.unit.key ||
        unit.caseId !== request.unit.caseId || unit.variantId !== request.unit.variantId || unit.repetition !== request.unit.repetition ||
        unit.inputFingerprint !== request.unit.inputFingerprint || unit.ordinal !== request.unit.ordinal)
      throw new TypeError("Worker checkpoint does not belong to the assigned unit");
    for (const step of snapshot.steps) {
      if (step.attemptId !== unit.attemptId || !step.path.startsWith(`${request.path}.`)) throw new TypeError("Worker step escaped its assigned unit");
      const index = host.record.steps.findIndex(value => value.path === step.path && value.attemptId === step.attemptId);
      if (index < 0) host.record.steps.push(step); else host.record.steps[index] = step;
    }
    for (const resource of snapshot.resources) {
      if (resource.owner !== undefined || !Object.hasOwn(request.plan.implementations, `resource:${resource.provider}`))
        throw new TypeError("Worker checkpoint contains an unowned or unknown resource");
      const index = host.record.resources.findIndex(value => resourceAllocationId(value) === resourceAllocationId(resource));
      if (index >= 0 && host.record.resources[index]?.owner !== owner) throw new TypeError("Worker resource collides with another allocation");
      const owned = { ...resource, owner };
      if (index < 0) host.record.resources.push(owned); else host.record.resources[index] = owned;
    }
    for (const artifact of snapshot.artifacts) {
      if (!artifact.producer.startsWith(`${unit.attemptId}/${request.path}.`)) throw new TypeError("Worker artifact escaped its assigned unit");
      const previous = host.record.artifacts.find(value => value.id === artifact.id);
      if (previous) {
        if (workflowDigest(previous) !== workflowDigest(artifact)) throw new TypeError("Worker changed committed artifact metadata");
      } else {
        await host.store.artifacts(artifact.producer).read(artifact);
        host.record.artifacts.push(artifact);
      }
    }
    if (final) {
      validateRecordConsistency(snapshot);
      if (snapshot.status === "running" || unit.status === "running" || snapshot.finishedAt === null)
        throw new TypeError("Worker returned before its attempt finished");
      lease.state = unit.cleanupStatus === "cleaned" && snapshot.resources.every(resource => resource.state === "released") ? "released" : "unconfirmed";
    }
    await host.save();
    return snapshot;
  };
  try {
    const result = await executor.execute(structuredClone(request), { signal: host.signal, log: host.log, store: {
      save: async snapshot => { await receive(snapshot); }, artifacts: producer => host.store.artifacts(producer),
    } });
    return await receive(result, true);
  } catch (error) {
    lease.state = "unconfirmed";
    await host.save();
    throw error;
  } finally { accepting = false; }
}
