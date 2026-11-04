import type { HardwareKind } from "../core/contracts/hardware.js";

/** Missing hardware in existing YAML and saved configurations means NPU. */
export function parseHardware(value: unknown): HardwareKind {
  if (value === undefined) return "npu";
  if (value !== "npu" && value !== "gpu") throw new TypeError("hardware must be npu or gpu");
  return value;
}
