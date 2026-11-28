import { join } from "node:path";
import type { EvaluationResult } from "../../../src/application/evaluator.js";
import { LocalRunStore } from "../../../src/plugins/stores/local.js";
import type { WorkflowPlan } from "../../../src/core/contracts/workflow.js";
import { parseEffectiveConfig } from "../../../src/config/effective.js";
import { workflowObject } from "../../../src/core/workflow/values.js";

/** Inspect Benchmark parameters only after the public workflow loader has validated the plan. */
export function benchmarkExperiment(plan: WorkflowPlan) {
  const binding = plan.document.workflow.resources.benchmark?.config.experiment;
  if (!binding || !("value" in binding)) throw new Error("Fixture requires a single Benchmark experiment");
  const experiment = parseEffectiveConfig(workflowObject(binding.value));
  experiment.output.directory = plan.document.output.directory;
  return experiment;
}

export async function readBenchmarkResult(result: EvaluationResult) {
  const directory = join(result.runDirectory, "benchmark-evidence", result.runId);
  const store = new LocalRunStore();
  try { await store.open(directory); return { ...result, runDirectory: directory, snapshot: await store.snapshot() }; }
  finally { await store.close(); }
}
