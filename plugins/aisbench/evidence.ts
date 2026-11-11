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
    if (!last || !/^[a-f0-9]{64}$/u.test(last.dataset_implementation ?? "") ||
      !last.failed_req?.trim() || Number(last.failed_req) !== 0 || Number(last.total_input_tokens) !== workload.inputLength * workload.dataCount ||
      Number(last.total_output_tokens) !== workload.outputLength * workload.dataCount ||
      !Number.isFinite(Number(last.output_throughput)) || Number(last.output_throughput) <= 0)
      throw new TypeError("Synthetic AISBench requires complete request/token totals and dataset identity");
    for (const field of ["TTFT P90", "TPOT SLO_P90", "E2EL P90"])
      if (!last[field]?.trim() || !Number.isFinite(Number(last[field])) || Number(last[field]) < 0)
        throw new TypeError(`Missing synthetic latency metric ${field}`);
  }
  return { schemaVersion: 1, kind: "aisbench", workload, bundleDigest,
    aisbenchVersion: expectNonEmptyString(v.aisbenchVersion, "AISBench version"), rows };
}
