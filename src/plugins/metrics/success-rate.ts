import type { Metrics } from "../../core/contracts/metrics.js";
import type { ResultSnapshot } from "../../core/contracts/result.js";
import { scoringRecords } from "./records.js";

export function computeSuccessRate(snapshot: ResultSnapshot) {
  const { records, selected, denominator: available, invalid } = scoringRecords(snapshot);
  if (snapshot.run.evaluationKind === "performance")
    return { applicable: false, selected, denominator: null, invalid: 0, passed: null,
      rate: null, verified: 0, pending: snapshot.pendingTaskIds.length };
  const unmeasured = records.filter(record => record.verdict?.passed === null).length;
  const denominator = available - unmeasured;
  if (unmeasured > 0 && denominator === 0)
    return { applicable: false, selected, denominator: null, invalid, passed: null, rate: null, verified: 0, pending: snapshot.pendingTaskIds.length };
  const passed = records.filter(record => record.verdict?.passed === true).length;
  return {
    selected,
    denominator,
    invalid,
    passed,
    rate: denominator ? passed / denominator : null,
    verified: records.filter(record => typeof record.verdict?.passed === "boolean").length,
    pending: snapshot.pendingTaskIds.length,
  };
}

export class SuccessRateMetrics implements Metrics {
  readonly name = "success-rate";
  async compute(snapshot: ResultSnapshot) {
    return computeSuccessRate(snapshot);
  }
}
