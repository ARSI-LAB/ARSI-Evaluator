import { expectNonEmptyString, expectRecord, rejectUnknown } from "./validation.js";
import { parseWorkload, type AisbenchWorkload } from "./config.js";
import { isDeepStrictEqual } from "node:util";

export type AisbenchSummary = {
  schemaVersion: 1;
  kind: "aisbench";
  workload: AisbenchWorkload;
  bundleDigest: string;
  aisbenchVersion: string;
  rows: Record<string, string>[];
};

export function parseAisbenchSummary(value: unknown): AisbenchSummary {
  const v = expectRecord(value, "AISBench summary");
  rejectUnknown(v, ["schemaVersion", "kind", "workload", "bundleDigest", "aisbenchVersion", "rows"], "AISBench summary");
  if (v.schemaVersion !== 1 || v.kind !== "aisbench") throw new TypeError("Invalid AISBench summary schema");
  const bundleDigest = expectNonEmptyString(v.bundleDigest, "AISBench bundle digest");
  if (!/^[a-f0-9]{64}$/u.test(bundleDigest)) throw new TypeError("Invalid AISBench bundle digest");
  if (!Array.isArray(v.rows) || !v.rows.length) throw new TypeError("AISBench CSV rows must not be empty");
  const rows = v.rows.map(value => {
    const row = expectRecord(value, "AISBench CSV row");
    if (!Object.keys(row).length) throw new TypeError("AISBench CSV row must not be empty");
    const result: Record<string, string> = {};
    for (const [key, field] of Object.entries(row)) {
      if (!key.trim() || typeof field !== "string") throw new TypeError("AISBench CSV fields must be named strings");
      Object.defineProperty(result, key, { value: field, enumerable: true, configurable: true, writable: true });
    }
    return result;
  });
  const headers = JSON.stringify(Object.keys(rows[0] ?? {}).sort());
  if (rows.some(row => JSON.stringify(Object.keys(row).sort()) !== headers)) throw new TypeError("AISBench CSV rows have different columns");
  const workload = parseWorkload(v.workload);
  if (!isDeepStrictEqual(workload, v.workload)) throw new TypeError("AISBench saved workload must contain its complete measurement conditions");
  const last = rows.at(-1);
  if (!last?.total_req?.trim() || !last.qps?.trim() || Number(last.total_req) !== workload.dataCount ||
    !Number.isFinite(Number(last.qps)) || Number(last.qps) <= 0)
    throw new TypeError("AISBench final CSV row requires matching total_req and positive measured qps");
  if (workload.dataset === "synthetic") {
    if (!last ||
      !last.failed_req?.trim() || Number(last.failed_req) !== 0 || Number(last.total_input_tokens) !== workload.inputLength * workload.dataCount ||
      Number(last.total_output_tokens) !== workload.outputLength * workload.dataCount ||
      !Number.isFinite(Number(last.output_throughput)) || Number(last.output_throughput) <= 0)
      throw new TypeError("Synthetic AISBench requires complete request/token totals and positive throughput");
    for (const field of ["TTFT P90", "TPOT SLO_P90", "E2EL P90"])
      if (!last[field]?.trim() || !Number.isFinite(Number(last[field])) || Number(last[field]) < 0)
        throw new TypeError(`Missing synthetic latency metric ${field}`);
  }
  return { schemaVersion: 1, kind: "aisbench", workload, bundleDigest,
    aisbenchVersion: expectNonEmptyString(v.aisbenchVersion, "AISBench version"), rows };
}

/** Normalize the final measured row; evidence pointers are relative to the metric point. */
export function normalizedMetrics(summary: AisbenchSummary): Record<string, { value: number | null; unit: string; source: string }> {
  const fields = [
    ["requestThroughput", "qps", "requests/sec"],
    ["inputThroughput", "input_token_throughput", "tokens/sec"],
    ["outputThroughput", "output_throughput", "tokens/sec"],
    ["totalThroughput", "E2E_throughput", "tokens/sec"],
    ["ttftP90", "TTFT P90", "ms"],
    ["tpotP90", "TPOT SLO_P90", "ms"],
    ["requestLatencyP90", "E2EL P90", "ms"],
  ] as const;
  const index = summary.rows.length - 1;
  const row = summary.rows[index];
  return Object.fromEntries(fields.map(([id, column, unit]) => {
    const raw = row?.[column];
    const value = raw?.trim() ? Number(raw) : NaN;
    return [id, { value: Number.isFinite(value) && value >= 0 ? value : null, unit,
      source: `/measurement/rows/${index}/${column.replaceAll("~", "~0").replaceAll("/", "~1")}` }];
  }));
}
