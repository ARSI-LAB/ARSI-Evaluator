import { workflowJobsProgress } from "../../infrastructure/ray/jobs-progress.js";
import { registerRunLocation } from "../../infrastructure/filesystem/run-index.js";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseJobsConfig, type JobsConfig } from "../../config/jobs.js";
import type { WorkflowExecutorOptions, WorkflowObject, WorkflowPlan } from "../../core/contracts/workflow.js";
import { expectNonEmptyString, expectRecord } from "../../core/validation/input.js";
import { workflowObject } from "../../core/workflow/values.js";
import { atomic } from "../../infrastructure/filesystem/atomic-json.js";
import { acquireRuntimeLock } from "../../infrastructure/runtime-installation/lock.js";
import { JobsClient } from "../../infrastructure/ray/jobs-client.js";
import { LocalWorkflowStore } from "../../plugins/stores/workflow-local.js";
import { ensureManagedLocalCluster } from "./managed-local.js";
import { downloadWorkflowResults } from "./workflow-jobs-results.js";
import { uploadJobsSeed } from "./jobs-seed-upload.js";
import { parseMaintenanceResults, type WorkflowMaintenanceResult } from "../../core/workflow/maintenance.js";
import type { WorkflowMaintenanceRequest } from "../../core/contracts/workflow.js";
import type { WorkflowRetryOptions } from "../workflow-retry.js";
import type { RetryRequest } from "../../core/contracts/retry-control.js";
import { redactDiagnostic } from "../../core/errors/diagnostics.js";
import { parseWorkflowRun, validateRecordConsistency } from "../../core/workflow/record.js";

type Receipt = { jobId: string; runId: string; fingerprint: string; endpoint: string;
  submission: WorkflowObject; credentialNames: string[]; collected: boolean };
export type WorkflowJobsOptions = {
  prepareDirectory?: (directory: string) => Promise<void>;
  configDirectory: string; outputDirectory: string; signal: AbortSignal; resume?: string | boolean;
  env: Record<string, string | undefined>; onEvent?: WorkflowExecutorOptions["onEvent"];
  retry?: { requestId: string; taskIds: string[]; reason: string };
};

function retryReceipt(value: unknown): RetryRequest {
  const item = expectRecord(value, "workflow retry receipt");
  if (!Array.isArray(item.taskIds) || !["pending", "accepted", "completed", "rejected"].includes(String(item.status))) throw new TypeError("Invalid retry receipt");
  return { requestId: expectNonEmptyString(item.requestId, "retry ID"),
    taskIds: item.taskIds.map(id => expectNonEmptyString(id, "retry task ID")), reason: expectNonEmptyString(item.reason, "retry reason"),
    status: item.status as RetryRequest["status"],
    bindings: Object.fromEntries(Object.entries(expectRecord(item.bindings, "retry bindings")).map(([key, value]) => [key, expectNonEmptyString(value, "retry attempt ID")])),
    ...(typeof item.message === "string" ? { message: item.message } : {}),
  };
}

export async function retryWorkflowJobs(directory: string, deployment: unknown, plan: WorkflowPlan,
  names: readonly string[], options: WorkflowRetryOptions) {
  const metadata = expectRecord(deployment, "workflow deployment"), config = parseJobsConfig(metadata.config);
  const configDirectory = expectNonEmptyString(metadata.configDirectory, "deployment config directory");
  const outputDirectory = expectNonEmptyString(metadata.outputDirectory, "deployment output directory");
  const runId = expectNonEmptyString(metadata.runId, "deployment run ID");
  if (!/^[0-9a-f-]{36}$/.test(runId) || resolve(directory) !== resolve(outputDirectory, runId))
    throw new TypeError("Saved deployment does not belong to this workflow run");
  const env = options.env ?? process.env, signal = options.signal ?? new AbortController().signal;
  const secrets = Object.entries(env).flatMap(([name, value]) => (names.includes(name) || /(?:KEY|TOKEN|PASSWORD|SECRET)$/i.test(name)) && value ? [value] : []);
  const retry = { requestId: options.requestId ?? randomUUID(), taskIds: [...new Set(options.taskIds ?? [])].sort(),
    reason: redactDiagnostic(options.reason ?? "manual workflow recovery", secrets) };
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(retry.requestId)) throw new TypeError("Invalid retry request ID");
  const path = join(outputDirectory, ".jobs", `${runId}.workflow.json`);
  let receipt = parseReceipt(JSON.parse(await readFile(path, "utf8")));
  if (receipt.runId !== runId || receipt.fingerprint !== plan.fingerprint || receipt.endpoint !== config.endpoint)
    throw new TypeError("Retry deployment differs from its submitted workflow");
  if (config.managedLocal) await ensureManagedLocalCluster(signal,
    message => options.onEvent?.({ path: "deployment", status: "running", message }), config.bundles);
  const evaluationCredentials = names.flatMap(name => {
    const value = env[name];
    return value ? [value] : [];
  });
  const client = await JobsClient.create(config, path => resolve(configDirectory, path), evaluationCredentials, env);
  try {
    const reply = expectRecord(await client.call(`/jobs/${receipt.jobId}/retry`, { kind: "workflow", runId,
      fingerprint: plan.fingerprint, ...retry }, signal), "workflow retry response");
    if (reply.active === true) {
      const record = parseWorkflowRun(reply.record); validateRecordConsistency(record);
      if (record.runId !== runId || record.fingerprint !== plan.fingerprint) throw new TypeError("Retry snapshot belongs to another workflow");
      return { record, directory, queued: true, request: retryReceipt(reply.request) };
    }
    if (reply.request) {
      const request = retryReceipt(reply.request);
      if (request.status === "completed" || request.status === "rejected") {
        const result = await downloadWorkflowResults(client, receipt.jobId, outputDirectory, plan.fingerprint, signal, () => {});
        return { ...result, queued: false, request };
      }
    }
  } catch (error) {
    if (!error || typeof error !== "object" || !("statusCode" in error) || error.statusCode !== 404)
      throw new Error(`Workflow retry acknowledgement unavailable. Resubmit the same request ID: ${retry.requestId}`, { cause: error });
    try {
      const status = expectRecord(await client.call(`/jobs/${receipt.jobId}`, undefined, signal), "Job status");
      if (status.status === "PENDING" || status.status === "RUNNING")
        throw new Error(`Workflow coordinator is starting; resubmit retry request ${retry.requestId} when it is ready`);
    } catch (statusError) {
      if (!statusError || typeof statusError !== "object" || !("statusCode" in statusError) || statusError.statusCode !== 404) throw statusError;
    }
  }
  const result = await runWorkflowJobs(config, plan, names, { configDirectory, outputDirectory, env, signal,
    resume: runId, retry, ...(options.onEvent ? { onEvent: options.onEvent } : {}),
  });
  receipt = parseReceipt(JSON.parse(await readFile(path, "utf8")));
  const request = retryReceipt(await client.call(`/jobs/${receipt.jobId}/retry?requestId=${encodeURIComponent(retry.requestId)}`, undefined, signal));
  return { ...result, queued: false, request };
}

export async function maintainWorkflowJobs(config: JobsConfig, plan: WorkflowPlan, names: readonly string[], request: WorkflowMaintenanceRequest,
  options: Omit<WorkflowJobsOptions, "outputDirectory" | "resume">): Promise<WorkflowMaintenanceResult[]> {
  const log = (message: string) => options.onEvent?.({ path: request.operation, status: "running", message });
  if (config.managedLocal) await ensureManagedLocalCluster(options.signal, log, config.bundles);
  const values = Object.fromEntries(names.flatMap(name => { const value = options.env[name]; return value ? [[name, value]] : []; }));
  const client = await JobsClient.create(config, path => resolve(options.configDirectory, path), Object.values(values), options.env);
  const observer = workflowJobsProgress(options.onEvent, Object.values(values));
  const jobId = randomUUID();
  await client.call(`/jobs/${jobId}/submit`, { kind: "workflow", operation: "maintenance", maintenance: request, plan, credentialValues: values }, options.signal);
  let code: number;
  try { code = await client.attach(jobId, observer.log, options.signal, observer.observe); }
  catch (error) { if (!options.signal.aborted) throw error; code = 130; }
  finally { observer.flush(); }
  if (options.signal.aborted) {
    const cleanup = AbortSignal.timeout(210_000);
    await client.call(`/jobs/${jobId}/cancel`, {}, cleanup);
    try { await client.attach(jobId, observer.log, cleanup, observer.observe); } finally { observer.flush(); }
    options.signal.throwIfAborted();
  }
  if (code !== 0) throw new Error(`Workflow maintenance Job ${jobId} failed; inspect its logs`);
  return parseMaintenanceResults(await client.call(`/jobs/${jobId}/maintenance`, undefined, options.signal));
}

function parseReceipt(value: unknown): Receipt {
  const item = expectRecord(value, "workflow job receipt");
  const jobId = expectNonEmptyString(item.jobId, "job ID"), runId = expectNonEmptyString(item.runId, "run ID");
  if (![jobId, runId].every(value => /^[0-9a-f-]{36}$/.test(value)) || !Array.isArray(item.credentialNames) || typeof item.collected !== "boolean")
    throw new TypeError("Invalid workflow job receipt");
  return { jobId, runId, fingerprint: expectNonEmptyString(item.fingerprint, "plan fingerprint"),
    endpoint: expectNonEmptyString(item.endpoint, "Jobs endpoint"), submission: workflowObject(item.submission),
    credentialNames: item.credentialNames.map(value => expectNonEmptyString(value, "credential name")), collected: item.collected };
}

/** Submission and recovery metadata contains configuration and credential names, never values. */
export async function runWorkflowJobs(config: JobsConfig, plan: WorkflowPlan, names: readonly string[], options: WorkflowJobsOptions) {
  const signal = options.signal;
  const log = (message: string) => options.onEvent?.({ path: "deployment", status: "running", message });
  if (config.managedLocal) await ensureManagedLocalCluster(signal, log, config.bundles);
  const supplied = Object.fromEntries(names.flatMap(name => { const value = options.env[name]; return value ? [[name, value]] : []; }));
  const client = await JobsClient.create(config, path => resolve(options.configDirectory, path), Object.values(supplied), options.env);
  const root = resolve(options.outputDirectory), receipts = join(root, ".jobs");
  await mkdir(receipts, { recursive: true });
  let runId = typeof options.resume === "string" ? options.resume : randomUUID();
  if (options.resume === true) {
    const candidates: Receipt[] = [];
    for (const file of await readdir(receipts)) if (file.endsWith(".workflow.json")) {
      const receipt = parseReceipt(JSON.parse(await readFile(join(receipts, file), "utf8")));
      if (receipt.fingerprint === plan.fingerprint && receipt.endpoint === config.endpoint) candidates.push(receipt);
    }
    if (candidates.length !== 1 || !candidates[0]) throw new TypeError("Specify a run ID when there is not exactly one matching workflow Job");
    runId = candidates[0].runId;
  }
  if (!/^[0-9a-f-]{36}$/.test(runId)) throw new TypeError("Invalid workflow Jobs run ID");
  const release = await acquireRuntimeLock(join(receipts, `.${runId}.workflow.lock`), signal, { wait: false });
  try {
    const receiptPath = join(receipts, `${runId}.workflow.json`);
    if (options.resume) await options.prepareDirectory?.(join(root, runId));
    const saveDeployment = (jobId: string) => atomic(join(root, runId, "workflow-deployment.json"), {
      schemaVersion: 2, jobId, runId, config, configDirectory: options.configDirectory, outputDirectory: root,
    });

    const follow = async (receipt: Receipt) => {
      const observer = workflowJobsProgress(options.onEvent, Object.values(supplied));
      try { await client.attach(receipt.jobId, observer.log, signal, observer.observe); }
      catch (error) { if (!signal.aborted) throw error; }
      finally { observer.flush(); }
      let collectionSignal = signal;
      if (signal.aborted) {
        collectionSignal = AbortSignal.timeout(210_000);
        await client.call(`/jobs/${receipt.jobId}/cancel`, {}, collectionSignal);
        try { await client.attach(receipt.jobId, observer.log, collectionSignal, observer.observe); } finally { observer.flush(); }
      }
      const result = await downloadWorkflowResults(client, receipt.jobId, root, plan.fingerprint, collectionSignal, log);
      if (result.record.runId !== runId) throw new TypeError("Gateway returned another workflow run");
      receipt.collected = true;
      await atomic(receiptPath, receipt);
      await saveDeployment(receipt.jobId);
      return result;
    };

    let previousDirectory: string | undefined;
    if (options.resume) {
      const receipt = parseReceipt(JSON.parse(await readFile(receiptPath, "utf8")));
      if (receipt.fingerprint !== plan.fingerprint || receipt.endpoint !== config.endpoint || receipt.runId !== runId)
        throw new TypeError("Cannot resume another workflow or Jobs endpoint");
      let status: string | undefined;
      try { status = String(expectRecord(await client.call(`/jobs/${receipt.jobId}`, undefined, signal), "Job status").status); }
      catch (error) {
        if (!error || typeof error !== "object" || !("statusCode" in error) || error.statusCode !== 404) throw error;
      }
      if (status === undefined && !receipt.collected || status === "PENDING" || status === "RUNNING") {
        if (receipt.credentialNames.every(name => supplied[name])) {
          const values = Object.fromEntries(receipt.credentialNames.map(name => [name, supplied[name]]));
          await client.call(`/jobs/${receipt.jobId}/submit`, { ...receipt.submission, credentialValues: values }, signal);
        } else if (status === undefined) throw new TypeError("Original Job credentials are required to recover an unacknowledged submission");
        return await follow(receipt);
      }
      if (status !== undefined) {
        try { previousDirectory = (await follow(receipt)).directory; }
        catch (error) {
          if (!receipt.collected || !error || typeof error !== "object" || !("statusCode" in error) || error.statusCode !== 404) throw error;
        }
      }
      if (previousDirectory === undefined) {
        previousDirectory = join(root, runId);
        const saved = await new LocalWorkflowStore(previousDirectory).read();
        if (saved.runId !== runId || saved.fingerprint !== plan.fingerprint) throw new TypeError("Local resume result differs from workflow");
      }
    }
    signal.throwIfAborted();
    const jobId = randomUUID();
    const seedDigest = previousDirectory ? await uploadJobsSeed(client, jobId, runId, previousDirectory, signal) : undefined;
    const submission = workflowObject({ kind: "workflow", plan, requestedRunId: runId,
      ...(options.retry ? { retry: options.retry } : {}),
      ...(seedDigest ? { resumeRunId: runId, seedDigest } : {}) });
    const receipt: Receipt = { jobId, runId, fingerprint: plan.fingerprint, endpoint: config.endpoint,
      submission, credentialNames: Object.keys(supplied).sort(), collected: false };
    if (!options.resume) {
      await mkdir(join(root, runId), { recursive: true });
      await writeFile(join(root, runId, "plan.json"), JSON.stringify(plan), { flag: "wx", mode: 0o600 });
    }
    await atomic(receiptPath, receipt);
    await saveDeployment(jobId);
    await options.prepareDirectory?.(join(root, runId));
    await registerRunLocation(runId, join(root, runId));
    log(`Submitting workflow run ${runId} as Job ${jobId}`);
    try { await client.call(`/jobs/${jobId}/submit`, { ...submission, credentialValues: supplied }, signal); }
    catch (cause) { throw new Error(`Workflow Job acknowledgement unavailable; resume run ${runId} to reconnect without duplicate submission`, { cause }); }
    return await follow(receipt);
  } finally { await release(); }
}
