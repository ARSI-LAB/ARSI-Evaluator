import { resolve, join } from "node:path";
import type { RetryRequest } from "../core/contracts/retry-control.js";
import type { WorkflowContext, WorkflowExecutorOptions, WorkflowPlan, WorkflowRunRecord } from "../core/contracts/workflow.js";
import { submitRetry, controlTransaction } from "./retry-control/mailbox.js";
import { redactDiagnostic } from "../core/errors/diagnostics.js";
import { LocalWorkflowStore } from "../plugins/stores/workflow-local.js";
import { acquireRuntimeLock } from "../infrastructure/runtime-installation/lock.js";
import { executeControlled } from "./workflow-execution.js";
import type { PluginRegistry } from "./plugins/open-registry.js";
import { finalizeWorkflowReport } from "./workflow-report.js";
import { saveWorkflowReporting, readWorkflowReporting } from "./workflow-report-plugins.js";

export type WorkflowRetryOptions = {
  configDirectory?: string;
  taskIds?: readonly string[]; requestId?: string; reason?: string;
  signal?: AbortSignal; env?: Record<string, string | undefined>;
  onEvent?: WorkflowExecutorOptions["onEvent"];
  resolvePath?: WorkflowContext["runtime"]["resolvePath"]; credential?: WorkflowContext["runtime"]["credential"];
};

export async function executeWorkflowRetry(plan: WorkflowPlan, registry: PluginRegistry, directory: string,
  options: WorkflowRetryOptions = {}): Promise<{ record: WorkflowRunRecord; directory: string; queued: boolean; request: RetryRequest }> {
  const root = resolve(directory), env = options.env ?? process.env, signal = options.signal ?? new AbortController().signal;
  let release: (() => Promise<void>) | undefined;
  try {
    const store = new LocalWorkflowStore(root);
    const secrets = Object.entries(env).flatMap(([name, value]) => /(?:KEY|TOKEN|PASSWORD|SECRET)$/i.test(name) && value ? [value] : []);
    const submitted = await submitRetry(root, { taskIds: [...(options.taskIds ?? [])],
      ...(options.requestId ? { requestId: options.requestId } : {}),
      ...(options.reason ? { reason: redactDiagnostic(options.reason, secrets) } : {}) }, { signal });
    const requestId = submitted.request.requestId;
    if (submitted.active || submitted.request.status === "completed" || submitted.request.status === "rejected")
      return { record: await store.read(), directory: root,
        queued: submitted.active && (submitted.request.status === "pending" || submitted.request.status === "accepted"), request: submitted.request };
    release = await acquireRuntimeLock(join(root, ".workflow.lock"), signal, { wait: false });
    const previous = await store.read();
    const reporting = await readWorkflowReporting(root);
    await saveWorkflowReporting(plan, registry, root, options.configDirectory ?? (typeof reporting?.configDirectory === "string" ? reporting.configDirectory : undefined));
    const latest = new Map(previous.units.map(unit => [unit.key, unit]));
    const failed = [...latest.values()].filter(unit => unit.status !== "completed");
    const requested = options.taskIds ?? [];
    if (requested.some(id => !failed.some(unit => unit.caseId === id))) {
      await controlTransaction(root, async state => {
        const request = state.requests.find(item => item.requestId === requestId);
        if (request) { request.status = "rejected"; request.message = "Selected IDs are not failed or interrupted samples"; }
      });
      throw new TypeError("Retry task IDs must select failed or interrupted workflow samples");
    }
    const selected = failed.filter(unit => !requested.length || requested.includes(unit.caseId));
    const record = await executeControlled(plan, registry, root, { store, previous, signal, secrets,
      runtime: { directory: root, resolvePath: options.resolvePath ?? (path => resolve(plan.document.pathBase ?? ".", path)), credential: options.credential ?? (async name => env[name]) },
      ...(requested.length ? { retryUnitKeys: selected.map(unit => unit.key) } : {}),
      ...(options.onEvent ? { onEvent: options.onEvent } : {}),
    }, { id: requestId, bindings: Object.fromEntries(selected.map(unit => [unit.key, unit.attemptId])) });
    await finalizeWorkflowReport(root, { registry, automatic: true, secrets, ...(options.onEvent ? { onEvent: options.onEvent } : {}) });
    const request = await controlTransaction(root, async state => {
      const entry = state.requests.find(item => item.requestId === requestId);
      if (!entry) throw new Error("Retry receipt disappeared after execution");
      return structuredClone(entry);
    });
    return { record, directory: root, queued: false, request };
  } finally { await release?.(); }
}
