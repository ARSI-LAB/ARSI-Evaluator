import type { WorkflowContext, WorkflowPlan } from "../core/contracts/workflow.js";
import type { PluginRegistry } from "./plugins/open-registry.js";
import type { WorkflowOptions } from "./workflow.js";
import { maintainWorkflow, maintainWorkflowPlan } from "./workflow-maintenance.js";
import type { WorkflowMaintenanceResult } from "../core/workflow/maintenance.js";

export type WorkflowWarmupResult = WorkflowMaintenanceResult;

export async function warmupWorkflow(options: WorkflowOptions): Promise<WorkflowWarmupResult[]> {
  return maintainWorkflow(options, { operation: "warmup", options: {} });
}

export async function warmupWorkflowPlan(plan: WorkflowPlan, registry: PluginRegistry, options: Pick<WorkflowOptions, "env" | "signal" | "onEvent"> & {
  resolvePath?: WorkflowContext["runtime"]["resolvePath"]; credential?: WorkflowContext["runtime"]["credential"];
}): Promise<WorkflowWarmupResult[]> {
  return maintainWorkflowPlan(plan, registry, { ...options, request: { operation: "warmup", options: {} } });
}
