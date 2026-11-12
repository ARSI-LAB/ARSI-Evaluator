import type { JsonValue } from "../../core/contracts/task.js";
import { expectRecord } from "../../core/validation/input.js";

const escape = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
  .replace(/[\\`*_\[\]()|~]/gu, "\\$&").replace(/\r?\n/gu, " ");
const number = (value: unknown, digits = 6) => typeof value === "number" && Number.isFinite(value)
  ? value.toFixed(digits).replace(/\.?0+$/u, "") : "—";
const encodePath = (value: string) => value.split("/").map(part => encodeURIComponent(part)
  .replace(/[!'()*]/gu, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)).join("/");

function safePath(value: unknown): value is string {
  return typeof value === "string" && !value.includes("\\") && !/[\u0000-\u001f]/u.test(value) &&
    value.split("/").every(part => part !== "" && part !== "." && part !== "..");
}

function resultLink(row: Record<string, unknown>, root: string): string {
  return typeof row.evidencePath === "string" && safePath(row.evidencePath)
    ? `[result.json](${root}${encodePath(row.evidencePath)}/result.json)` : "—";
}

function range(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "—";
  const stat = expectRecord(value, "kernel metric range");
  const textValues = Array.isArray(stat.textValues) ? stat.textValues.filter((item): item is string => typeof item === "string") : [];
  if (typeof stat.minimum !== "number" || typeof stat.maximum !== "number" ||
    !Number.isFinite(stat.minimum) || !Number.isFinite(stat.maximum)) return textValues.map(escape).join("; ") || "—";
  const text = stat.minimum === stat.maximum ? String(stat.minimum) : `${String(stat.minimum)}–${String(stat.maximum)}`;
  const rendered = stat.available === stat.total ? text : `${text} (${stat.available}/${stat.total})`;
  return [rendered, ...textValues.map(escape)].join("; ");
}

/** 详细 block 数据留在机器结果中，报告给出范围和可追溯的原始证据。 */
export function renderKernelTables(value: JsonValue | undefined, evidenceRoot = ""): string[] {
  if (value === undefined) return [];
  const metric = expectRecord(value, "kernel metric");
  if (!Array.isArray(metric.rows)) throw new TypeError("Invalid kernel report rows");
  const rows = metric.rows.map(value => expectRecord(value, "kernel report row"));
  const timingOnly = rows.some(row => row.operation === "bench");
  const lines = timingOnly ? ["## Kernel timing", "",
    `Measured ${number(metric.measured)} / ${number(metric.selected)}. Correctness was not checked; no candidate score or speedup is reported.`, "",
    "| Task | Candidate (ms) | Timing scope | Evidence |", "| --- | --- | --- | --- |"] : ["## 算子正确性与性能", "",
    `正确 ${number(metric.passed)} / ${number(metric.selected)}；有效计时 ${number(metric.measured)}；加速 ${number(metric.faster)}；加速比几何均值 ${number(metric.geometricMeanSpeedup)}。`, "",
    "正确性通过不代表性能提升。加速比为参考耗时 / 候选耗时；耗时只含设备 kernel，详细 profiler 重放不参与该计时。", "",
    "| 任务 | 有效 / 正确 | 参考种类 | 参考 (ms) | 候选 (ms) | 加速比 | 证据 |",
    "| --- | --- | --- | --- | --- | --- | --- |"];
  for (const row of rows) lines.push(timingOnly
    ? `| ${escape(String(row.taskId))} | ${number(row.candidateMs)} | ${escape(String(row.timingScope ?? "—"))} | ${resultLink(row, evidenceRoot)} |`
    : `| ${escape(String(row.taskId))} | ${row.valid} / ${row.passed} | ${escape(String(row.referenceKind ?? "—"))} | ${number(row.referenceMs)} | ${number(row.candidateMs)} | ${number(row.speedup)} | ${resultLink(row, evidenceRoot)} |`,
  );
  if (!rows.some(row => row.profilingRequested === true || row.profiling != null)) {
    lines.push("", "详细 profiling 未启用。", "");
    return lines;
  }
  const kernelRows = rows.flatMap(row => {
    if (!row.profiling || typeof row.profiling !== "object" || Array.isArray(row.profiling)) return [];
    const profile = expectRecord(row.profiling, "kernel profiling summary");
    if (!Array.isArray(profile.kernels)) throw new TypeError("Invalid kernel profiling kernels");
    return profile.kernels.map(value => ({ row, kernel: expectRecord(value, "kernel profiling kernel") }));
  });
  lines.push("", "### 详细 profiling", "",
    `已请求 ${number(metric.profilingRequested)}；完成 ${number(metric.profiled)}；失败 ${number(metric.profilingErrors)}；未采集 ${number(metric.profilingUncollected)}。覆盖率以全部所选任务为分母：${number(metric.profiled)} / ${number(metric.selected)}。`, "",
    "采集状态独立记录。表格展示采集返回的 block 指标，管道比率沿用原始 CSV 单位，L2 命中率单位为 %。缺失值显示 —。", "",
    "| 任务 / kernel | block ID | Vector | MTE2 | MTE3 | L2 读 / 写 (%) | UB | 核覆盖率 |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const { row, kernel } of kernelRows) {
    const values = expectRecord(kernel.values, "kernel profiling values");
    lines.push(`| ${escape(String(row.taskId))} / ${escape(String(kernel.name))} | ${escape(String(kernel.selectedBlockId ?? "—"))} | ${range(values.aiv_vec_ratio)} | ${range(values.aiv_mte2_ratio)} | ${range(values.aiv_mte3_ratio)} | ${range(values["aiv_read_hit_rate(%)"])} / ${range(values["aiv_write_hit_rate(%)"])} | ${range(values.ub_ratio)} | ${range(values.core_utilization)} |`);
  }
  lines.push("", "### L2 缓存分析", "",
    "结论来自已保存的 L2 规则分析，表格最多列出三条依据。完整内容见 result.json。", "",
    "| 任务 / kernel | 结论 | 依据 |", "| --- | --- | --- |");
  for (const { row, kernel } of kernelRows) {
    const analysis = kernel.l2CacheAnalysis && typeof kernel.l2CacheAnalysis === "object" && !Array.isArray(kernel.l2CacheAnalysis)
      ? expectRecord(kernel.l2CacheAnalysis, "kernel L2 analysis") : null;
    const evidence = Array.isArray(analysis?.evidence) ? analysis.evidence : [];
    const excerpt = evidence.filter((entry): entry is string => typeof entry === "string").slice(0, 3).join("；");
    const remaining = typeof analysis?.evidenceCount === "number" && analysis.evidenceCount > 3
      ? `；另 ${analysis.evidenceCount - 3} 条见 result.json` : "";
    const conclusion = typeof analysis?.conclusion === "string" ? analysis.conclusion : "未记录";
    lines.push(`| ${escape(String(row.taskId))} / ${escape(String(kernel.name))} | ${escape(conclusion)} | ${escape(excerpt + remaining) || "—"} |`);
  }
  lines.push("", "| 任务 | 采集状态 | 错误 | 完整 block 数据 / 原始证据 |", "| --- | --- | --- | --- |");
  for (const row of rows) {
    const profile = row.profiling && typeof row.profiling === "object" && !Array.isArray(row.profiling)
      ? expectRecord(row.profiling, "kernel profiling summary") : null;
    const files = new Set<unknown>(Array.isArray(profile?.artifacts) ? profile.artifacts : []);
    if (Array.isArray(profile?.kernels)) for (const value of profile.kernels) {
      const kernel = expectRecord(value, "kernel profiling kernel");
      if (Array.isArray(kernel.artifacts)) for (const file of kernel.artifacts) files.add(file);
    }
    const links = [resultLink(row, evidenceRoot)];
    if (typeof row.evidencePath === "string" && safePath(row.evidencePath)) for (const file of files) {
      if (!safePath(file)) continue;
      // 二进制采集片段仍在完整证据清单中，正文只列便于复核的表、trace 和日志。
      if (!/(?:\.csv|\.log|\/(?:trace|result|original-result)\.json)$/iu.test(file)) continue;
      const target = encodePath(`${row.evidencePath}/verifier/${file}`);
      links.push(`[${escape(file)}](${evidenceRoot}${target})`);
    }
    lines.push(`| ${escape(String(row.taskId))} | ${escape(String(profile?.status ?? (row.profilingRequested ? "未采集" : "未启用")))} | ${escape(String(profile?.error || "—"))} | ${links.join(" · ")} |`);
  }
  lines.push("", "设备流水线、访存与算术指标见 result.json。profiling/original-result.json 保存本次采集的原始返回。", "");
  return lines;
}
