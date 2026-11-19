import { registerNativeResource } from "../workflows/benchmark/component-resource.js";
import type { Context } from "@deepseek-ai/cordis";
import { LocalRunStore } from "./local.js";

export function apply(ctx: Context): void {
  registerNativeResource(ctx,
    "store",
    "local",
    (value: unknown) => {
      if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Invalid local store config");
      const config = value as Record<string, unknown>;
      if (Object.keys(config).length) throw new TypeError("local store has no configuration; use output.directory for the root");
      return {};
    },
    () => new LocalRunStore(),
  );
}
