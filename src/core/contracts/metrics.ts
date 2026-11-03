import type { ResultSnapshot } from "./result.js";
import type { JsonValue } from "./task.js";

export interface Metrics {
  name: string;
  compute(snapshot: ResultSnapshot): Promise<JsonValue>;
}

export type MetricResults = Record<string, JsonValue>;
