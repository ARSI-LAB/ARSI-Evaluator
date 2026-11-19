import { parseRayConnectionConfig } from "../../config/ray.js";
import { parseDeployment } from "../../config/deployment.js";
import { workflowObject } from "../../core/workflow/values.js";
import { rejectUnknown } from "../../core/validation/input.js";

export function workflowScheduling(value: unknown) {
  if (value === undefined) return { resources: {}, forEach: {}, deployment: {} };
  const scheduler = workflowObject(value, "scheduler");
  rejectUnknown(scheduler, ["name", "config"], "scheduler");
  if (scheduler.name !== "ray") throw new TypeError("Omit scheduler for local execution, or select name: ray");
  const input = workflowObject(scheduler.config ?? {});
  const jobs = input.endpoint === undefined;
  const config = workflowObject(parseRayConnectionConfig(jobs ? { ...input, deployment: "ray-jobs" } : input));
  return { resources: {
    ray: { use: "ray.connection", scope: "run", config },
    execution: { use: "executor.ray", scope: "run", resources: { connection: "ray" } },
  }, forEach: { executor: "execution" },
    deployment: jobs ? { deployment: workflowObject(parseDeployment({ kind: "ray-jobs", managedLocal: true })) } : {},
  };
}
