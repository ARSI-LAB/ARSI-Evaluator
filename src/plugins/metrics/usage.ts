import type { Metrics } from "../../core/contracts/metrics.js";
import type { ResultSnapshot, Usage } from "../../core/contracts/result.js";
import { selectedRecords } from "./records.js";

export function computeUsage(snapshot: ResultSnapshot) {
  const records = selectedRecords(snapshot);
  const sum = (field: keyof Usage) => {
    const known = records
      .map(record => record.solve?.usage[field])
      .filter((value): value is number => value !== null && value !== undefined);
    const total = known.reduce((sum, value) => sum + value, 0);
    if (!Number.isSafeInteger(total) || total < 0) throw new Error(`Invalid ${field} sum`);
    return { total: known.length ? total : null, covered: known.length };
  };
  return {
    selected: snapshot.run.taskIds.length,
    recorded: records.length,
    inputTokens: sum("inputTokens"),
    outputTokens: sum("outputTokens"),
    totalTokens: sum("totalTokens"),
  };
}

export class UsageMetrics implements Metrics {
  readonly name = "usage";
  async compute(snapshot: ResultSnapshot) {
    return computeUsage(snapshot);
  }
}
