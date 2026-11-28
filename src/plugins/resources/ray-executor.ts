import { EvaluatorError } from "../../core/errors/evaluator-error.js";
import { classifyError } from "../../core/errors/classify.js";
import { workflowCredentialNames } from "../../core/workflow/credentials.js";
import type { Context } from "@deepseek-ai/cordis";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { hostname } from "node:os";
import { parseRayConfig, parseRayConnectionConfig, type RaySchedulerConfig } from "../../config/ray.js";
import type { WorkflowUnitExecutor, WorkflowUnitRequest } from "../../core/contracts/workflow.js";
import { abortable } from "../../core/workflow/resources.js";
import { workflowDigest, workflowObject } from "../../core/workflow/values.js";
import { RayClient } from "../../infrastructure/ray/client.js";
import { parseWorkflowRemoteJob, type WorkflowRemoteJob } from "../../infrastructure/ray/workflow-protocol.js";
import { WorkflowTransferSession, readWorkflowCredential } from "../../infrastructure/ray/workflow-transfer.js";
import { loadPackageDigest } from "../../infrastructure/provenance/package.js";
import { RayConnection, openRayConnection, resolveRayConnectionConfig } from "../../infrastructure/ray/connection.js";
import { noConfig } from "../steps/workflow-builtins.js";
import { expectRecord } from "../../core/validation/input.js";

async function localPlacement(config: RaySchedulerConfig) {
  if (config.endpoint !== "local") return {};
  const file = process.env.EVALUATOR_NODE_CONFIG;
  if (!file) throw new TypeError("Local Ray requires EVALUATOR_NODE_CONFIG");
  return { hostname: hostname(), nodeConfigDigest: createHash("sha256").update(await readFile(file)).digest("hex") };
}


async function runJob(client: RayClient, job: WorkflowRemoteJob, signal: AbortSignal, cancelGraceMs: number) {
  signal.throwIfAborted();
  const result = client.submitWorkflow(job);
  const stopped = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancel = () => {
    try { client.cancel(job.job.attemptId); } catch { /* The disconnected driver's result rejects below. */ }
    timer = setTimeout(() => {
      try { client.cancel(job.job.attemptId, true); } catch { /* A lost driver still leaves cleanup unconfirmed. */ }
      stopped.abort(new Error("Ray workflow cancellation was not confirmed"));
    }, cancelGraceMs);
    timer.unref();
  };
  signal.addEventListener("abort", cancel, { once: true });
  if (signal.aborted) cancel();
  try {
    const response = await abortable(result, stopped.signal);
    if (response.type === "failed") throw new EvaluatorError(response.code, `Ray workflow worker failed (${response.code})`,
      { ...(response.network ?? {}), ...(response.originalName ? { originalName: response.originalName } : {}) });
    if (!response.result.completed || response.result.nodeId !== job.nodeId) throw new Error("Ray workflow acknowledgement mismatch");
  } finally { signal.removeEventListener("abort", cancel); if (timer) clearTimeout(timer); }
}

export function registerRayExecutor(ctx: Context): void {
  ctx.evaluator.registerResource({ type: "ray.connection", apiVersion: 1, version: "1", capabilities: ["ray.connection/v1"],
    availableDuringMaintenance: true, resources: {}, validateConfig: value => workflowObject(parseRayConnectionConfig(value)),
    credentials: config => { const parsed = parseRayConnectionConfig(config); return ["deployment" in parsed ? "EVALUATOR_TRANSFER_TOKEN" : parsed.collector.tokenEnv]; },
    async create(config, context) {
      const value = await openRayConnection(resolveRayConnectionConfig(parseRayConnectionConfig(config)), context);
      return { value, identity: { kind: "coordinator" }, dispose: () => value.close() };
    }, async recover() {},
  });
  ctx.evaluator.registerResource({ type: "executor.ray", apiVersion: 1, version: "1", capabilities: ["workflow.executor/v1", "ray.executor/v1"],
    resources: { connection: { capability: "ray.connection/v1" } }, validateConfig: noConfig,
    async create(_value, context) {
      const connection = context.resource("connection");
      if (!(connection instanceof RayConnection)) throw new TypeError("Ray executor requires its declared connection resource");
      const config = connection.config;
      await context.checkpoint({ kind: "coordinator" });
      const packageDigest = await loadPackageDigest();
      const local = await localPlacement(config);
      const placements = new Map<string, string>();
      const running = new Set<Promise<void>>();
      let index = 0;
      const executor: WorkflowUnitExecutor = {
        recoveryIdentity(request) {
          const nodeId = request.nodeId ?? connection.client.nodes[index++ % connection.client.nodes.length];
          if (nodeId && !connection.client.nodes.includes(nodeId)) throw new Error("Prepared Ray node is no longer available");
          if (!nodeId) throw new Error("Ray has no execution node");
          placements.set(request.unit.attemptId, nodeId);
          return { kind: "dispatch", config: workflowObject(config), nodeId, local,
            credentialNames: workflowCredentialNames(request, ctx.evaluator.workflows),
            job: { runId: request.runId, taskId: request.unit.caseId, attemptId: request.unit.attemptId } };
        },
        async execute(request: WorkflowUnitRequest, host) {
          while (running.size >= Math.min(config.concurrency ?? connection.client.slots, connection.client.slots))
            await abortable(Promise.race([...running].map(work => work.catch(() => {}))), host.signal);
          const nodeId = placements.get(request.unit.attemptId);
          if (!nodeId) throw new Error("Workflow dispatch receipt is missing");
          const controller = new AbortController();
          const signal = AbortSignal.any([host.signal, controller.signal]);
          const session = new WorkflowTransferSession({ ...request, nodeId }, nodeId, packageDigest, host.store, signal,
            { names: workflowCredentialNames(request, ctx.evaluator.workflows), resolve: context.runtime.credential },
            event => host.log(event.message, event));
          const unbind = connection.subscribe("attempt", request.unit.attemptId, (_route, input) => session.handle(input));
          const heartbeat = setInterval(() => {
            if (Date.now() - session.lastHeartbeat > config.heartbeatTimeoutMs) controller.abort(new Error("Ray workflow worker heartbeat lost"));
          }, 1000);
          heartbeat.unref();
          const operation = runJob(connection.client, { schemaVersion: 3, kind: "workflow", action: "execute", nodeId,
            job: { runId: request.runId, taskId: request.unit.caseId, attemptId: request.unit.attemptId },
            uploadEndpoint: connection.endpoint, safeConfig: { timeoutSeconds: request.plan.document.run.timeoutSeconds } }, signal, config.cancelGraceMs);
          running.add(operation);
          try {
            await operation;
            if (!session.lastSnapshot || session.lastSnapshot.finishedAt === null) throw new Error("Ray worker returned without a committed workflow snapshot");
            return session.lastSnapshot;
          } catch (error) {
            const failure = classifyError(error, { phase: "environment", component: "scheduler" });
            host.log(failure.message, { phase: "environment", message: failure.message, error: true, failure,
              taskId: request.unit.caseId, attemptId: request.unit.attemptId });
            throw error;
          } finally {
            clearInterval(heartbeat); running.delete(operation);
            unbind();
            placements.delete(request.unit.attemptId);
          }
        },
      };
      return { value: executor, identity: { kind: "coordinator" } };
    },
    async recover(identity, context) {
      if (identity.kind === "coordinator") return; // Process-owned sockets/drivers end with their coordinator; dispatches have separate receipts.
      if (identity.kind !== "dispatch") throw new TypeError("Invalid Ray workflow recovery identity");
      const config = parseRayConfig(identity.config);
      const local = await localPlacement(config);
      if (workflowDigest(local) !== workflowDigest(identity.local)) throw new TypeError("Local Ray execution host or node configuration changed");
      if (!Array.isArray(identity.credentialNames) || identity.credentialNames.some(name => typeof name !== "string"))
        throw new TypeError("Missing workflow credential declaration in recovery receipt");
      const credentialNames = identity.credentialNames.filter((name): name is string => typeof name === "string");
      let recoveryNodeId = identity.nodeId;
      const connection = await openRayConnection(config, context);
      const unbind = connection.subscribe("attempt", String(workflowObject(identity.job).attemptId), async (_route, body) => {
        const input = expectRecord(body, "workflow recovery heartbeat");
        if (input.nodeId !== recoveryNodeId || input.attemptId !== workflowObject(identity.job).attemptId)
          throw new TypeError("Unexpected workflow recovery placement");
        if (input.op === "credential") return readWorkflowCredential(input, credentialNames, context.runtime.credential);
        if (input.op !== "heartbeat") throw new TypeError("Unexpected workflow recovery message");
        return { cancelled: context.signal.aborted };
      });
      try {
        if (config.endpoint === "local") {
          if (connection.client.nodes.length !== 1) throw new TypeError("Local Ray recovery requires exactly one local execution node");
          recoveryNodeId = connection.client.nodes[0] ?? null;
        }
        await runJob(connection.client, parseWorkflowRemoteJob({ schemaVersion: 3, kind: "workflow", action: "recover", nodeId: recoveryNodeId,
          job: identity.job, uploadEndpoint: connection.endpoint, safeConfig: { timeoutSeconds: config.cancelGraceMs / 1000 } }), context.signal, config.cancelGraceMs);
      } finally { unbind(); await connection.close(); }
    },
  });
}
