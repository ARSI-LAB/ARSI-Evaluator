import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * msprof OPPROF_* 产物解析（kernel 原版 msprof_op_profiler.parse_msprof_dir /
 * metrics_to_prompt 的 TS 语义移植）。纯文本处理，零 NPU、零 pandas。
 */

/** 保留进指标表的算子级指标列（列名跟随 msprof op 输出）。分四组：
 * 管道忙不忙 / 谁在等谁 / 搬了多少·打满没有 / 算力用足没有。
 * 有意不加：Task Duration(us)（与权威耗时口径不同）；Block Dim（不指导改什么）；
 * MemoryUB.csv 的 UB 带宽（与 ub_ratio 重复）。 */
export const MSPROF_METRIC_COLUMNS: readonly string[] = [
  "block_id",
  // PipeUtilization.csv —— 四根管道的利用率（忙不忙）
  "aic_time(us)", "aic_cube_ratio", "aic_scalar_ratio", "aic_mte1_ratio", "aic_mte2_ratio", "aic_mte3_ratio",
  "aiv_time(us)", "aiv_vec_ratio", "aiv_scalar_ratio", "aiv_mte2_ratio", "aiv_mte3_ratio",
  "aic_read_hit_rate(%)", "aic_write_hit_rate(%)", "aiv_read_hit_rate(%)", "aiv_write_hit_rate(%)",
  "core_utilization",
  // ResourceConflictRatio.csv —— 访存冲突 + 管道等待（谁在等谁：等待高 = 该管道是瓶颈源头）
  "aiv_vec_stu_cflt_ratio", "aiv_vec_ldu_cflt_ratio", "aiv_vec_sfu_cflt_ratio",
  "aiv_vec_wait_ratio", "aiv_mte2_wait_ratio", "aiv_mte3_wait_ratio",
  // Memory.csv —— 实际带宽与数据量（搬了多少、有没有把带宽打满）
  "aiv_gm_to_ub_bw(GB/s)", "aiv_main_mem_read_bw(GB/s)",
  // 写侧带宽不加：写流量是输出、优化不掉，且能由 write_main_memory_datas / kernel 耗时推出
  "GM_to_UB_bw_usage_rate(%)", "read_main_memory_datas(KB)", "write_main_memory_datas(KB)",
  "aiv_mte2_instructions",
  // ArithmeticUtilization.csv —— 向量/特殊函数单元利用率（算力用足没有）
  "aiv_vec_vf_ratio", "aiv_vec_sfu_ratio",
];

/** 行 = block_id 到指标值的映射（空单元格 → null，数值 → number，其余 → string）。 */
export type MetricRow = { block_id: string } & Record<string, unknown>;

/** 极简 CSV 解析（msprof 产物无引号内逗号；容忍 \r\n 与尾空行）。 */
export function parseCsv(text: string): { header: string[]; rows: string[][] } {
  const lines = text.replace(/\r\n?/g, "\n").split("\n").filter((line) => line.trim() !== "");
  if (lines.length === 0) return { header: [], rows: [] };
  const split = (line: string) => line.split(",");
  return { header: split(lines[0]!), rows: lines.slice(1).map(split) };
}

/** 读取一张 msprof CSV 为记录数组；文件不存在返回 null（调用方区分必须/可选表）。 */
async function readTable(profDir: string, name: string): Promise<Record<string, unknown>[] | null> {
  let text: string;
  try {
    text = await readFile(join(profDir, name), "utf8");
  } catch {
    return null;
  }
  const { header, rows } = parseCsv(text);
  return rows.map(cells => Object.fromEntries(header.map((key, i) => [key, cells[i] ?? ""])));
}

/** 单元格定型：空 → null；可解析数值 → number；其余 → string。 */
function coerce(raw: unknown): unknown {
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed === "") return null;
    if (Number.isFinite(Number(trimmed)) && trimmed !== "") return Number(trimmed);
    return raw;
  }
  return raw;
}

/** 同名伴生列以 pipe 侧为准；sub_block_id 是权威行标识，永不被伴生表覆盖。 */
function mergeInto(base: Record<string, unknown>, extra: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(extra)) {
    if (key === "block_id" || key === "sub_block_id") continue;
    if (base[key] === undefined) base[key] = value;
  }
}

/**
 * 解析 OPPROF_* 目录为指标行（parse_msprof_dir 语义）：
 * PipeUtilization/L2Cache/ResourceConflictRatio 三表必须存在（缺失即采集不完整，
 * 与原版同样抛错）；Memory/ArithmeticUtilization 可选（cube-only 算子缺 aiv 数据正常）。
 * 多行时按 LAST 策略只留最后一行（与原版 _apply_selection_policy 一致）。
 */
export async function parseMsprofMetricsTable(profDir: string): Promise<MetricRow[]> {
  const pipe = await readTable(profDir, "PipeUtilization.csv");
  if (pipe === null) throw new Error(`No PipeUtilization.csv found under ${profDir}`);
  const l2 = await readTable(profDir, "L2Cache.csv");
  if (l2 === null) throw new Error(`No L2Cache.csv found under ${profDir}`);
  const conflict = await readTable(profDir, "ResourceConflictRatio.csv");
  if (conflict === null) throw new Error(`No ResourceConflictRatio.csv found under ${profDir}`);

  // outer merge on block_id：pipe 行为基，伴生表按 block_id 补列（含 pipe 没有的行）。
  const byBlock = new Map<string, Record<string, unknown>>();
  for (const row of pipe) {
    const key = String(row["block_id"]);
    const record: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(row)) record[k] = coerce(v);
    byBlock.set(key, record);
  }
  for (const extra of [l2, conflict, ...(await Promise.all(
    [readTable(profDir, "Memory.csv"), readTable(profDir, "ArithmeticUtilization.csv")]))]) {
    for (const row of extra ?? []) {
      const key = row["block_id"];
      if (key === undefined) continue;
      const existing = byBlock.get(String(key));
      if (existing === undefined) {
        const record: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(row)) record[k] = coerce(v);
        byBlock.set(String(key), record);
      } else {
        mergeInto(existing, Object.fromEntries(Object.entries(row).map(([k, v]) => [k, coerce(v)])));
      }
    }
  }

  let rows = [...byBlock.values()] as MetricRow[];
  // 只留白名单列；整列全空说明该表对这类算子不适用（例如 vector 算子无 cube 数据），丢弃。
  const kept = MSPROF_METRIC_COLUMNS.filter(name => name === "block_id" ||
    rows.some(row => row[name] !== undefined && row[name] !== null));
  rows = rows.map(row => Object.fromEntries(kept.map(name => [name, row[name] ?? null]))) as MetricRow[];
  // LAST 策略：多行留最后一行。
  return rows.length <= 1 ? rows : [rows[rows.length - 1]!];
}

/** 指标行 → block_id 键控表（metrics_to_prompt 语义：key 列 pop 出去不进值对象；
 * 数值保留 3 位小数，行内个别 null 保留——那是「这个 block 没有这项」）。 */
export function rowsToMetrics(rows: MetricRow[]): Record<string, Record<string, unknown>> {
  const data: Record<string, Record<string, unknown>> = {};
  for (const row of rows) {
    const values = Object.fromEntries(
      Object.entries(row).filter(([name, value]) => name !== "block_id" && value !== null)
        .map(([name, value]) => [name, typeof value === "number" ? Math.round(value * 1000) / 1000 : value]));
    data[String(row["block_id"])] = values;
  }
  return data;
}

/** 指标表回写 CSV（原版 metrics_df.to_csv 的等价产物，供归档对账）。 */
export function metricsToCsv(rows: MetricRow[]): string {
  const header = rows.length === 0 ? [] : Object.keys(rows[0]!);
  const escape = (value: unknown): string => {
    if (value === null || value === undefined) return "";
    return String(value);
  };
  return [header.join(","), ...rows.map(row => header.map(name => escape(row[name])).join(","))].join("\n") + "\n";
}
