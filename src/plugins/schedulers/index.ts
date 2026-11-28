import { nativeResourceTransport, registerNativeResource } from "../workflows/benchmark/component-resource.js";
import type { Context } from "@deepseek-ai/cordis";
import { LocalScheduler } from "./local/scheduler.js";
import { RayScheduler } from "./ray/scheduler.js";
import { parseRayConnectionConfig } from "../../config/ray.js";
import { resolveRayConnectionConfig } from "../../infrastructure/ray/connection.js";
import { DEFAULT_LOCAL_CONCURRENCY } from "../../config/defaults.js";
import { expectRecord, rejectUnknown, expectPositiveInteger } from "../../core/validation/input.js";

export function apply(ctx: Context): void {
  registerNativeResource(ctx,
    "scheduler",
    "ray",
    parseRayConnectionConfig,
    (config, runtime) => {
      const scheduler = new RayScheduler(resolveRayConnectionConfig(config), runtime, (role, name) => nativeResourceTransport(ctx.evaluator.workflows, role, name));
      return scheduler;
    },
  );
  registerNativeResource(ctx,
    "scheduler",
    "local",
    (value: unknown) => {
      const config = expectRecord(value, "local scheduler");
      rejectUnknown(config, ["concurrency"], "local scheduler");
      return { concurrency: expectPositiveInteger(config.concurrency ?? DEFAULT_LOCAL_CONCURRENCY, "concurrency") };
    },
    config => new LocalScheduler(config.concurrency),
  );
}
