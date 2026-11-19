import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { WorkflowContext, WorkflowExecutorOptions } from "../../core/contracts/workflow.js";
import { compileWorkflow } from "../../core/workflow/compile.js";
import { workflowPlanCredentialNames, workflowMaintenanceCredentialNames } from "../../core/workflow/credentials.js";
import { parseCompiledWorkflowDocument } from "../../config/workflow-schema.js";
import { expectNonEmptyString, expectRecord } from "../../core/validation/input.js";
import { JobsSeedUploads } from "../../infrastructure/ray/jobs-seed.js";
import { acquireRuntimeLock } from "../../infrastructure/runtime-installation/lock.js";
import type { PluginRegistry } from "../plugins/open-registry.js";
import { executeWorkflowPlan } from "../workflow-execution.js";
import { LocalWorkflowStore } from "../../plugins/stores/workflow-local.js";
import { maintainWorkflowPlan } from "../workflow-maintenance.js";
import { parseMaintenanceRequest } from "../../core/workflow/maintenance.js";
import { executeWorkflowRetry } from "../workflow-retry.js";

async function submittedPlan(input: unknown, registry: PluginRegistry) {
  const request = expectRecord(input, "workflow job"), saved = expectRecord(request.plan, "workflow plan");
  await registry.loadRecordedPlugins(saved.sources);
  const sources = { ...registry.pluginVersions };
  for (const key of Object.keys(expectRecord(saved.sources, "workflow sources"))) if (key.startsWith("template:"))
    sources[key] = registry.ctx.evaluator.workflows.template(key.slice(9)).version;
  const document = parseCompiledWorkflowDocument(saved.document);
  if (document.pathBase !== "." || document.output.directory !== "results") throw new TypeError("Jobs plans must use portable root paths");
  const plan = compileWorkflow(document, registry.ctx.evaluator.workflows, sources);
  if (plan.fingerprint !== saved.fingerprint) throw new TypeError("Submitted workflow or installed plugins changed");
  return plan;
}

type JobRuntime = {
  root: string; configDirectory: string; signal: AbortSignal;
  credential: WorkflowContext["runtime"]["credential"];
  onEvent?: WorkflowExecutorOptions["onEvent"];
};

function credentials(plan: Awaited<ReturnType<typeof submittedPlan>>, registry: PluginRegistry, runtime: JobRuntime, names = workflowPlanCredentialNames(plan, registry.ctx.evaluator.workflows)) {
  const allowed = new Set(names);
  const cache = new Map<string, Promise<string | undefined>>();
  return (name: string) => {
    if (!allowed.has(name)) return Promise.reject(new TypeError("Credential was not declared by this workflow"));
    let value = cache.get(name);
    if (!value) { value = runtime.credential(name); cache.set(name, value); }
    return value;
  };
}

export async function executeWorkflowMaintenanceJob(input: unknown, registry: PluginRegistry, runtime: JobRuntime) {
  const plan = await submittedPlan(input, registry);
  const request = expectRecord(input, "maintenance job");
  if (request.requestedRunId !== undefined || request.resumeRunId !== undefined || request.seedDigest !== undefined || request.retry !== undefined)
    throw new TypeError("Maintenance cannot execute or resume an evaluation run");
  const maintenance = parseMaintenanceRequest(request.maintenance);
  return maintainWorkflowPlan(plan, registry, { request: maintenance, signal: runtime.signal,
    resolvePath: path => resolve(runtime.configDirectory, path), credential: credentials(plan, registry, runtime,
      workflowMaintenanceCredentialNames(plan, registry.ctx.evaluator.workflows, maintenance.operation)),
    ...(runtime.onEvent ? { onEvent: runtime.onEvent } : {}),
  });
}

/** Cluster entry owns host paths and authentication; neither comes from the submitted plan. */
export async function executeWorkflowJob(jobId: string, input: unknown, registry: PluginRegistry, runtime: JobRuntime) {
  const request = expectRecord(input, "workflow job");
  const runId = expectNonEmptyString(request.requestedRunId, "workflow job run ID");
  if (![jobId, runId].every(id => /^[0-9a-f-]{36}$/.test(id))) throw new TypeError("Invalid workflow job identity");
  if (request.resumeRunId !== undefined && request.resumeRunId !== runId) throw new TypeError("Resume identity differs from requested run");
  const plan = await submittedPlan(input, registry);
  const outputRoot = join(runtime.root, "workflow-runs"), directory = join(outputRoot, runId);
  const release = await acquireRuntimeLock(join(outputRoot, `.${runId}.job.lock`), runtime.signal, { wait: false });
  try {
    if (request.resumeRunId !== undefined) {
      const digest = expectNonEmptyString(request.seedDigest, "resume seed digest");
      const seeds = new JobsSeedUploads(join(runtime.root, ".seeds"));
      await seeds.ready(jobId, runId, digest);
      let exists = true;
      try { await access(join(directory, "run.json")); }
      catch (error) { if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") throw error; exists = false; }
      // Retained cluster state can be newer than the submitter's last download.
      if (!exists) {
        const source = await seeds.source(jobId, runId, digest);
        const previous = await new LocalWorkflowStore(source).read();
        const previousPlan = expectRecord(JSON.parse(await readFile(join(source, "plan.json"), "utf8")), "seed plan");
        if (previous.runId !== runId || previous.fingerprint !== plan.fingerprint || previousPlan.fingerprint !== plan.fingerprint)
          throw new TypeError("Seed belongs to a different workflow");
        await seeds.materialize(jobId, runId, digest, directory);
      }
    }
    const jobDirectory = join(runtime.root, jobId);
    await mkdir(jobDirectory, { recursive: true });
    await writeFile(join(jobDirectory, "workflow-run.json"), JSON.stringify({ runId }), { mode: 0o600 });
    if (request.retry !== undefined) {
      if (request.resumeRunId === undefined) throw new TypeError("Workflow retry requires a saved run");
      const retry = expectRecord(request.retry, "workflow retry");
      if (!Array.isArray(retry.taskIds) || retry.taskIds.some(id => typeof id !== "string")) throw new TypeError("Invalid retry task IDs");
      return await executeWorkflowRetry(plan, registry, directory, {
        configDirectory: runtime.configDirectory,
        taskIds: retry.taskIds.map(id => expectNonEmptyString(id, "retry task ID")),
        requestId: expectNonEmptyString(retry.requestId, "retry request ID"), reason: expectNonEmptyString(retry.reason, "retry reason"),
        signal: runtime.signal, resolvePath: path => resolve(runtime.configDirectory, path), credential: credentials(plan, registry, runtime),
        ...(runtime.onEvent ? { onEvent: runtime.onEvent } : {}),
      });
    }
    return await executeWorkflowPlan(plan, registry, { runId, outputDirectory: outputRoot, signal: runtime.signal,
      registerLocation: false,
      configDirectory: runtime.configDirectory,
      ...(request.resumeRunId === undefined ? {} : { resume: runId }),
      resolvePath: path => resolve(runtime.configDirectory, path),
      credential: credentials(plan, registry, runtime), ...(runtime.onEvent ? { onEvent: runtime.onEvent } : {}) });
  } finally { await release(); }
}
