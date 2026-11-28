import { registerNativeResource } from "../workflows/benchmark/component-resource.js";
import type { Context } from "@deepseek-ai/cordis";
import { expectRecord, rejectUnknown } from "../../core/validation/input.js";
import { SuccessRateMetrics } from "./success-rate.js";
import { DurationMetrics } from "./duration.js";
import { UsageMetrics } from "./usage.js";
import { HarborScoreMetrics, parseHarborScoreConfig } from "./harbor-score.js";
import { AgentXPerformanceMetrics } from "./agentx-performance.js";
import { QualityScoreMetrics } from "./quality-score.js";
import { KernelMetrics } from "./kernel.js";

export const inject = ["evaluator"];
export function apply(ctx: Context): void {
  registerNativeResource(ctx, "metrics", "harbor-score", parseHarborScoreConfig, config => new HarborScoreMetrics(config));
  const empty = (value: unknown) => {
    const config = expectRecord(value, "plugin config");
    rejectUnknown(config, [], "plugin config");
    return {};
  };
  registerNativeResource(ctx, "metrics", "success-rate", empty, () => new SuccessRateMetrics());
  registerNativeResource(ctx, "metrics", "duration", empty, () => new DurationMetrics());
  registerNativeResource(ctx, "metrics", "usage", empty, () => new UsageMetrics());
  registerNativeResource(ctx, "metrics", "agentx-performance", empty, () => new AgentXPerformanceMetrics());
  registerNativeResource(ctx, "metrics", "quality-score", empty, () => new QualityScoreMetrics());
  registerNativeResource(ctx, "metrics", "kernel", empty, () => new KernelMetrics());
}
