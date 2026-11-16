import type { LoadedConfig } from "../config/loaded.js";
import { expectNonEmptyString, expectPositiveInteger, expectRecord, rejectUnknown } from "../core/validation/input.js";
import { fingerprintResumeConfig } from "../core/results/run-manifest.js";

export const SCHEDULING_OVERRIDES_API_VERSION = 1;
/** Operational limits, separate from the immutable benchmark/model configuration. */
export type SchedulingOptions = { concurrency: number; preparationConcurrency?: number; reason: string };
export type SchedulingReceipt = SchedulingOptions & { schemaVersion: "evaluator.scheduling/v1"; recordedAt: string; baseConfigFingerprint: string };

export function applyScheduling(config: LoadedConfig, input: SchedulingOptions): { config: LoadedConfig; receipt: SchedulingReceipt } {
  const options = expectRecord(input, "scheduling");
  rejectUnknown(options, ["concurrency", "preparationConcurrency", "reason"], "scheduling");
  const concurrency = expectPositiveInteger(options.concurrency, "scheduling.concurrency");
  const reason = expectNonEmptyString(options.reason, "scheduling.reason").trim();
  if (!reason) throw new TypeError("scheduling.reason must not be blank");
  const preparationConcurrency = options.preparationConcurrency === undefined ? undefined
    : expectPositiveInteger(options.preparationConcurrency, "scheduling.preparationConcurrency");
  if (config.deployment || config.experiment.scheduler.name !== "local")
    throw new TypeError("Scheduling overrides require the local scheduler without deployment");
  if (preparationConcurrency !== undefined && !config.experiment.run.preparation)
    throw new TypeError("Preparation concurrency override requires an explicit preparation policy");
  const experiment = structuredClone(config.experiment);
  experiment.scheduler.config.concurrency = concurrency;
  if (preparationConcurrency !== undefined) experiment.run.preparation!.concurrency = preparationConcurrency;
  return {
    config: { ...config, experiment },
    receipt: { schemaVersion: "evaluator.scheduling/v1", recordedAt: new Date().toISOString(),
      baseConfigFingerprint: fingerprintResumeConfig(config.persisted), concurrency,
      ...(preparationConcurrency === undefined ? {} : { preparationConcurrency }), reason },
  };
}
