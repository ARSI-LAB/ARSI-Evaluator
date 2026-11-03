/**
 * NPU roofline 分析（msprof_pipe_utilization 版）—— kernel 原版
 * msprof_roofline.py 的 TS 逐语义移植。纯计算、零 NPU：输入是 profile 原子
 * 已解析的指标表 `{block_id: {指标: 值}}`，输出瓶颈分类与管道利用率。
 *
 * 移植要点（与 python 版逐条对齐）：
 * - 管道顺序 scalar→vec→mte2→mte3 固定，平局时取先者（max 语义一致）；
 * - underutilized 优先：最高利用率 < underutilizedThreshold 直接判 "no"；
 * - tiling 判据：最大块 aiv_vec_time > 1.3 × 最小块（负载不均衡）；
 * - at_roofline 恒为 false：管道利用率百分比与绝对 SOL 不可比，宁缺毋假
 *   （python 版同款告警语义）。
 */

export interface RooflineConfig {
  /** 判定为管道 bound 的利用率下限（0-1）。 */
  boundThresholdPct: number;
  /** 低于此最高利用率判 underutilized（优先于 bound 判定）。 */
  underutilizedThresholdPct: number;
  /** at_roofline 效率阈值（NPU 上暂不可判，保留字段）。 */
  thresholdPct: number;
}

export const DEFAULT_ROOFLINE_CONFIG: RooflineConfig = {
  boundThresholdPct: 0.4,
  underutilizedThresholdPct: 0.8,
  thresholdPct: 0.8,
};

/** msprof 指标键（须与 msprof-csv.ts 的 MSPROF_METRIC_COLUMNS 一致）。 */
const AIV_RATIO_KEYS: readonly (readonly [pipe: string, key: string])[] = [
  ['scalar', 'aiv_scalar_ratio'],
  ['vec', 'aiv_vec_ratio'],
  ['mte2', 'aiv_mte2_ratio'],
  ['mte3', 'aiv_mte3_ratio'],
];

export interface RooflineResult {
  scalar_rate: number;
  vec_rate: number;
  mte2_rate: number;
  mte3_rate: number;
  efficiency_rate: number;
  at_roofline: boolean;
  bottleneck: string;
  warnings: string[];
  msprof_metrics: Record<string, Record<string, unknown>>;
}

type MetricsTable = Record<string, Record<string, unknown>>;

const vecTimeOf = (row: Record<string, unknown>): number => {
  const value = row['aiv_vec_time'];
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const ratioOf = (row: Record<string, unknown>, key: string): number => {
  const value = row[key];
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

/** 管道利用率 → 瓶颈分类；平局取 scalar→vec→mte2→mte3 的先者。 */
function classifyBottleneck(ratios: Map<string, number>, config: RooflineConfig): string {
  let maxPipe = '';
  let maxValue = -Infinity;
  for (const [pipe, value] of ratios) {
    if (value > maxValue) {
      maxPipe = pipe;
      maxValue = value;
    }
  }
  if (maxValue < config.underutilizedThresholdPct) return 'no';
  return maxValue > config.boundThresholdPct ? maxPipe : 'no';
}

export function analyzeRoofline(
  metricsTable: MetricsTable,
  config: RooflineConfig = DEFAULT_ROOFLINE_CONFIG,
): RooflineResult {
  const warnings: string[] = [];
  const blocks = Object.entries(metricsTable).filter(([, row]) => row !== null && typeof row === 'object');
  if (blocks.length === 0) {
    warnings.push('Empty msprof_metrics');
    return {
      scalar_rate: 0, vec_rate: 0, mte2_rate: 0, mte3_rate: 0,
      efficiency_rate: 0, at_roofline: false, bottleneck: 'no',
      warnings, msprof_metrics: {},
    };
  }

  // 最大/最小 aiv_vec_time 块；最大块驱动全部下游指标提取。
  let maxBlock = blocks[0]!;
  let minBlock = blocks[0]!;
  for (const entry of blocks) {
    if (vecTimeOf(entry[1]) > vecTimeOf(maxBlock[1])) maxBlock = entry;
    if (vecTimeOf(entry[1]) < vecTimeOf(minBlock[1])) minBlock = entry;
  }
  const maxTime = vecTimeOf(maxBlock[1]);
  const minTime = vecTimeOf(minBlock[1]);
  const analysisRow = maxBlock[1];

  // tiling bound：最大块 vec_time 超 30% 于最小块（负载不均衡）。
  const isTilingBound = maxTime > minTime * 1.3;
  const selectedMetrics: Record<string, Record<string, unknown>> = { [maxBlock[0]]: maxBlock[1] };
  if (isTilingBound) {
    selectedMetrics[minBlock[0]] = minBlock[1];
    warnings.push(
      `tiling bound: max vec_time ${maxTime.toFixed(1)}us > 1.3 * min vec_time ${minTime.toFixed(1)}us`,
    );
  }

  // AIV 管道利用率（取最大 vec_time 行）；缺键记 0 并告警。
  const ratios = new Map<string, number>();
  const missing: string[] = [];
  for (const [pipe, key] of AIV_RATIO_KEYS) {
    const value = analysisRow[key];
    if (value === null || value === undefined) {
      missing.push(key);
      ratios.set(pipe, 0);
      continue;
    }
    const parsed = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(parsed)) {
      missing.push(key);
      ratios.set(pipe, 0);
      continue;
    }
    ratios.set(pipe, parsed);
  }
  if (missing.length > 0) warnings.push(`Missing AIV pipe metrics: ${missing.join(', ')}`);

  let efficiency = 0;
  for (const value of ratios.values()) efficiency = Math.max(efficiency, value);

  return {
    scalar_rate: ratios.get('scalar') ?? 0,
    vec_rate: ratios.get('vec') ?? 0,
    mte2_rate: ratios.get('mte2') ?? 0,
    mte3_rate: ratios.get('mte3') ?? 0,
    efficiency_rate: efficiency,
    // 管道利用率 % 与绝对 SOL 不可比：恒 false，不产伪判停依据。
    at_roofline: false,
    bottleneck: isTilingBound ? 'tiling' : classifyBottleneck(ratios, config),
    warnings,
    msprof_metrics: selectedMetrics,
  };
}
