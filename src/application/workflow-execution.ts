import { randomUUID } from "node:crypto";
import { mkdir, lstat, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { WorkflowContext, WorkflowExecutorOptions, WorkflowPlan, WorkflowRunRecord } from "../core/contracts/workflow.js";
import { executeWorkflow } from "../core/workflow/execute.js";
import { workflowObject } from "../core/workflow/values.js";
import { redactDiagnostic } from "../core/errors/diagnostics.js";
import { LocalWorkflowStore } from "../plugins/stores/workflow-local.js";
import { acquireRuntimeLock } from "../infrastructure/runtime-installation/lock.js";
import { RetryControl, controlTransaction } from "./retry-control/mailbox.js";
import type { PluginRegistry } from "./plugins/open-registry.js";
import { saveWorkflowReporting } from "./workflow-report-plugins.js";
import { finalizeWorkflowReport } from "./workflow-report.js";
import { registerRunLocation } from "../infrastructure/filesystem/run-index.js";

export type WorkflowPlanOptions = {
  registerLocation?: boolean;
  configDirectory?: string;
  origins?: WorkflowContext["runtime"]["origins"];
  signal?: AbortSignal; resume?: string | boolean; runId?: string; outputDirectory?: string;
  env?: Record<string, string | undefined>;
  resolvePath?: WorkflowContext["runtime"]["resolvePath"];
  credential?: WorkflowContext["runtime"]["credential"];
  onEvent?: WorkflowExecutorOptions["onEvent"];
};

export class WorkflowCompletionError extends Error {
  constructor(readonly result: { record: WorkflowRunRecord; directory: string }, cause: unknown) {
    super("Workflow completed but report publication failed", { cause });
  }
}

export async function executeControlled(plan: WorkflowPlan, registry: PluginRegistry, directory: string,
  options: WorkflowExecutorOptions, request?: { id: string; bindings: Record<string, string> }) {
  const warn = (error: unknown) => options.onEvent?.({ path: "retry", status: "failed",
    message: redactDiagnostic(error instanceof Error ? error.message : String(error), options.secrets) });
  let controller: RetryControl | undefined;
  try { controller = await RetryControl.start(directory, warn); }
  catch (error) {
    if (request) throw error;
    warn(error);
  }
  try {
    if (request) await controlTransaction(directory, async state => {
      const entry = state.requests.find(item => item.requestId === request.id);
      if (!entry || entry.status !== "pending" && entry.status !== "accepted") throw new Error("Retry request was already handled");
      entry.status = "accepted"; entry.bindings = request.bindings;
    });
    return await executeWorkflow(plan, registry.ctx.evaluator.workflows, { ...options, ...(controller ? { retryController: controller } : {}) });
  } finally { await controller?.close(); }
}

export async function executeWorkflowPlan(plan: WorkflowPlan, registry: PluginRegistry,
  options: WorkflowPlanOptions): Promise<{ record: WorkflowRunRecord; directory: string }> {
  const env = options.env ?? process.env, outputRoot = options.outputDirectory ?? plan.document.output.directory;
  let release: (() => Promise<void>) | undefined;
  try {
    let runId = typeof options.resume === "string" ? options.resume : options.runId ?? randomUUID();
    if (options.resume === true) {
      const existing = await readdir(outputRoot, { withFileTypes: true });
      const candidates: string[] = [];
      for (const entry of existing) if (entry.isDirectory()) {
        try { await readFile(join(outputRoot, entry.name, "run.json")); candidates.push(entry.name); }
        catch (error) { if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") throw error; }
      }
      if (candidates.length !== 1 || candidates[0] === undefined) throw new TypeError("Specify a run ID when there is not exactly one workflow run");
      runId = candidates[0];
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(runId)) throw new TypeError("Invalid run ID");
    const directory = join(outputRoot, runId);
    await mkdir(directory, { recursive: true });
    if ((await lstat(directory)).isSymbolicLink()) throw new TypeError("Workflow run directory cannot be a symlink");
    const lockPath = join(directory, ".workflow.lock");
    release = await acquireRuntimeLock(lockPath, options.signal ?? new AbortController().signal, { wait: false });
    const store = new LocalWorkflowStore(directory);
    const previous = options.resume ? await store.read() : undefined;
    if (previous) {
      if (previous.runId !== runId || previous.fingerprint !== plan.fingerprint) throw new TypeError("Cannot resume a different workflow, input, or plugin implementation");
      const saved = workflowObject(JSON.parse(await readFile(join(directory, "plan.json"), "utf8")));
      if (saved.fingerprint !== plan.fingerprint) throw new TypeError("Saved workflow plan differs from its run record");
    } else await writeFile(join(directory, "plan.json"), JSON.stringify(plan, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    await saveWorkflowReporting(plan, registry, directory, options.configDirectory);
    if (options.registerLocation !== false) await registerRunLocation(runId, directory);
    const secrets = Object.entries(env).flatMap(([name, value]) => /(?:KEY|TOKEN|PASSWORD|SECRET)$/i.test(name) && value ? [value] : []);
    const record = await executeControlled(plan, registry, directory, {
      store, runId, signal: options.signal ?? new AbortController().signal, secrets,
      runtime: { directory, ...(options.origins ? { origins: options.origins } : {}), resolvePath: options.resolvePath ?? (path => resolve(plan.document.pathBase ?? ".", path)), credential: options.credential ?? (async name => env[name]) },
      ...(previous ? { previous } : {}), ...(options.onEvent ? { onEvent: options.onEvent } : {}),
    });
    try {
      await finalizeWorkflowReport(directory, { registry, automatic: true, mode: options.resume ? "resume" : "update", secrets,
        ...(options.onEvent ? { onEvent: options.onEvent } : {}) });
    } catch (error) { throw new WorkflowCompletionError({ record, directory }, error); }
    return { record, directory };
  } finally { await release?.(); }
}
