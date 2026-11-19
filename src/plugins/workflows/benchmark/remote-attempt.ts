import type { Context } from "@deepseek-ai/cordis";
import { readFile, access } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { EffectiveConfig } from "../../../core/contracts/config.js";
import type { RunComponents } from "../../../core/contracts/components.js";
import type { TaskRef } from "../../../core/contracts/task.js";
import type { WorkflowContext, WorkflowObject } from "../../../core/contracts/workflow.js";
import type { Failure } from "../../../core/contracts/result.js";
import { validFailureMetadata } from "../../../core/errors/validation.js";
import type { TaskPreparation } from "../../../core/preparation/task-preparation.js";
import { readPreparedTask } from "../../../infrastructure/ray/preparation-receipt.js";
import { assertSourceLock } from "../../../core/results/source-lock.js";
import { assertSolverProvenance, resolveSolverProvenance, validateSolverProvenance } from "../../../core/results/solver-provenance.js";
import { fingerprintConfig } from "../../../core/results/run-manifest.js";
import { expectNonEmptyString, rejectUnknown } from "../../../core/validation/input.js";
import { artifactReference } from "../../../core/workflow/record.js";
import { workflowObject, workflowValue, jsonPort } from "../../../core/workflow/values.js";
import { parseNodeConfig } from "../../../infrastructure/ray/node-config.js";
import { loadPackageDigest } from "../../../infrastructure/provenance/package.js";
import { requireNetwork, withRecoveryNetwork } from "../../resources/network-runtime.js";
import { noConfig } from "../../steps/workflow-builtins.js";
import { createBenchmarkAttempt } from "./attempt.js";
import { benchmarkAttemptResource } from "./evidence.js";

export type BenchmarkAssembly = { owned: RunComponents; experiment: EffectiveConfig; secrets: string[]; dispose(): Promise<void> };
type Assemble = (config: Readonly<WorkflowObject>, context: WorkflowContext) => Promise<BenchmarkAssembly>;

export async function benchmarkNodeConfig() {
  const file = process.env.EVALUATOR_NODE_CONFIG;
  if (!file) throw new TypeError("Remote Benchmark execution requires EVALUATOR_NODE_CONFIG");
  return parseNodeConfig(JSON.parse(await readFile(file, "utf8")), dirname(file));
}

export function registerRemoteBenchmarkAttempt(ctx: Context, assemble: Assemble) {
  ctx.evaluator.registerResource({ type: "benchmark.remote-attempt", apiVersion: 1, version: "1",
    capabilities: ["benchmark.attempt/v1", "benchmark.start/v1"], resources: { network: { capability: "network.access/v1" } },
    validateConfig(value) {
      const config = workflowObject(value);
      rejectUnknown(config, ["credentialNames"], "benchmark.remote-attempt");
      if (!Array.isArray(config.credentialNames) || config.credentialNames.some(name => typeof name !== "string" || !name))
        throw new TypeError("Benchmark remote attempt requires credentialNames");
      return config;
    },
    credentials: config => (config.credentialNames as string[]),
    async create(_config, owner) {
      let components: BenchmarkAssembly | undefined;
      let attempt: ReturnType<typeof benchmarkAttemptResource> | undefined;
      let started = false;
      const active = () => { if (!attempt) throw new TypeError("Start the remote Benchmark attempt before running its operations"); return attempt.value; };
      return { identity: {}, value: {
        get driver() { return active().driver; }, get actions() { return active().actions; }, evidence: () => active().evidence(),
        async start(value: unknown, context: WorkflowContext) {
          if (started) throw new TypeError("A Benchmark attempt can be started only once");
          started = true;
          const artifact = artifactReference(value);
          if (artifact.protocol !== "arsi.benchmark-selection/v1" || artifact.visibility !== "private") throw new TypeError("Expected private Benchmark selection");
          const selection = workflowObject(JSON.parse(new TextDecoder().decode(await context.artifacts.read(artifact))));
          if (!Array.isArray(selection.groups) || !context.unit) throw new TypeError("Missing Benchmark execution group");
          const groups = selection.groups.map(value => workflowObject(value));
          const unit = context.unit;
          const group = groups.find(group => group.variantId === unit.variantId && group.repetition === unit.repetition);
          if (!group || !Array.isArray(group.tasks)) throw new TypeError("Benchmark group differs from dispatch");
          const task = group.tasks.map(value => workflowObject(value)).find(task => workflowObject(task.ref).id === context.unit?.caseId);
          if (!task) throw new TypeError("Benchmark case was not selected");
          const source = group.source; assertSourceLock(source);
          const row = workflowObject(task.ref);
          const ref: TaskRef = { id: expectNonEmptyString(row.id, "task ID"), recordKey: workflowValue(row.recordKey) };
          const runId = expectNonEmptyString(group.runId, "native run ID");
          if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runId) || runId.endsWith(".")) throw new TypeError("Unsafe native run ID");
          const fingerprint = expectNonEmptyString(group.fingerprint, "native configuration fingerprint");
          const config = workflowObject(group.config);
          const key = { runId, taskId: ref.id, attemptId: context.attemptId };
          await owner.checkpoint({ config, key, network: requireNetwork(owner.resource("network")).document.template });
          components = await assemble(config, { ...context, resource: owner.resource });
          const { owned, experiment, secrets } = components;
          const expected = group.provenance === null ? undefined : validateSolverProvenance(group.provenance);
          const provenance = await resolveSolverProvenance(owned.solver, context.signal, secrets, expected);
          assertSolverProvenance(expected, provenance);
          const actualSource = await owned.benchmark.resolveSource(source, context.signal);
          if (fingerprintConfig(actualSource) !== fingerprintConfig(source)) throw new TypeError("Benchmark source differs on the execution node");
          let matches = 0;
          for await (const candidate of owned.benchmark.enumerate(actualSource, context.signal)) if (candidate.id === ref.id) {
            if (fingerprintConfig(candidate) !== fingerprintConfig(ref)) throw new TypeError("Benchmark task differs on the execution node");
            matches++;
          }
          if (matches !== 1) throw new TypeError("Benchmark task is not unique on the execution node");
          let preparation: TaskPreparation = { state: "on-demand" };
          if (task.failure !== null) {
            const failure = workflowObject(task.failure);
            if (failure.phase !== "prepare" || !validFailureMetadata(failure)) throw new TypeError("Invalid Benchmark preparation failure");
            preparation = { state: "failed", failure: failure as unknown as Failure };
          } else if (task.preparation !== null) {
            const ready = workflowObject(task.preparation);
            const node = await benchmarkNodeConfig();
            preparation = { state: "ready", task: await readPreparedTask(node.outputRoot, key,
              { roundId: expectNonEmptyString(ready.roundId, "preparation round"), digest: expectNonEmptyString(ready.digest, "preparation digest") },
              { packageDigest: await loadPackageDigest(), configFingerprint: fingerprint, source }) };
          }
          const root = join(context.runtime.directory, "benchmark-evidence");
          let retained = false;
          try { await access(join(root, runId, "manifest.json")); retained = true; }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
          if (retained) throw new TypeError("Remote attempt already has native evidence; recover it before retrying");
          await owned.store.create(root, { schemaVersion: 1, runId, source, taskIds: [ref.id], configFingerprint: fingerprint,
            evaluationKind: owned.benchmark.evaluationKind ?? "quality", pluginVersions: owned.pluginVersions,
            ...(provenance ? { solverProvenance: provenance } : {}), startedAt: new Date().toISOString(), finishedAt: null, durationMs: null, status: "running" }, config);
          const driver = await createBenchmarkAttempt({ job: { ...key, ref, configFingerprint: fingerprint }, preparation }, owned, source, context.signal,
            { timeoutSeconds: experiment.run.timeoutSeconds, includeTaskAnswer: experiment.run.includeTaskAnswer === true, sensitiveValues: secrets, onProgress: event => context.log(event.message, event),
              ...(experiment.run.scoreAfterSolveTimeout === undefined ? {} : { scoreAfterSolveTimeout: experiment.run.scoreAfterSolveTimeout }),
              ...(experiment.run.solveTimeoutSeconds === undefined ? {} : { solveTimeoutSeconds: experiment.run.solveTimeoutSeconds }),
              ...(experiment.run.verifyTimeoutSeconds === undefined ? {} : { verifyTimeoutSeconds: experiment.run.verifyTimeoutSeconds }),
              ...(experiment.run.preparation?.environmentTimeoutSeconds === undefined ? {} : { environmentTimeoutSeconds: experiment.run.preparation.environmentTimeoutSeconds }) });
          attempt = benchmarkAttemptResource(driver, owner);
        },
      }, async dispose() { try { await attempt?.dispose(); } finally { await components?.dispose(); } } };
    },
    async recover(identity, context) {
      if (Object.keys(identity).length === 0) return;
      const key = workflowObject(identity.key);
      if (key.attemptId !== context.attemptId) throw new TypeError("Remote Benchmark recovery ownership differs");
      await withRecoveryNetwork(workflowValue(identity.network), context, async active => {
        const components = await assemble(workflowObject(identity.config), active);
        const nativeKey = { runId: expectNonEmptyString(key.runId, "native run ID"), taskId: expectNonEmptyString(key.taskId, "task ID"), attemptId: context.attemptId };
        try {
          if (!components.owned.environment.recoverAttempts) throw new TypeError("Remote environment cannot recover interrupted attempts");
          await components.owned.environment.recoverAttempts([nativeKey], context.signal);
          const verification = components.owned.benchmark.verificationRuntime;
          if (verification) {
            if (!verification.recoverAttempts) throw new TypeError("Remote verifier cannot recover interrupted attempts");
            await verification.recoverAttempts([nativeKey], context.signal);
          }
        } finally { await components.dispose(); }
      });
    },
  });
  ctx.evaluator.registerStep({ type: "benchmark.start", apiVersion: 1, version: "1", effects: "isolated-write",
    inputs: { selection: { ...jsonPort("arsi.benchmark-selection/v1"), visibility: "private" } }, outputs: {},
    resources: { attempt: { capability: "benchmark.start/v1" } }, validateConfig: noConfig,
    async execute(inputs, _config, context) {
      const resource = context.resource("attempt");
      if (!resource || typeof resource !== "object" || !("start" in resource) || typeof resource.start !== "function") throw new TypeError("Missing remote Benchmark attempt");
      await resource.start(inputs.selection, context);
      return {};
    },
  });
}
