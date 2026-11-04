from __future__ import annotations
import math
import statistics
from datetime import datetime

from schema import make_feedback
from signals import build_signals
from delta import compute_delta, find_parent

def _pct(values, p):
    if not values:
        return None
    v = sorted(values)
    k = (len(v) - 1) * p / 100.0
    lo, hi = int(math.floor(k)), int(math.ceil(k))
    if lo == hi:
        return round(float(v[lo]), 3)
    return round(float(v[lo] + (v[hi] - v[lo]) * (k - lo)), 3)

def _span(step):
    inv = ((step.get("extra") or {}).get("invocation") or {})
    s, e = inv.get("start_timestamp"), inv.get("end_timestamp")
    if isinstance(s, (int, float)) and isinstance(e, (int, float)) and e >= s:
        return float(s), float(e)
    ts = step.get("timestamp")
    if isinstance(ts, str):
        try:
            t = datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp()
            return t, t
        except Exception:
            return None, None
    return None, None

def _task_latency(traces):
    """Fall back to the trajectory's first-to-last span (ms) when the outcome carries no latency_ms."""
    out = {}
    for t in traces:
        if t.get("kind") != "trajectory":
            continue
        starts, ends = [], []
        for st in (t.get("payload") or {}).get("steps") or []:
            a, b = _span(st)
            if a is not None and b >= a:
                starts.append(a)
                ends.append(b)
        if starts and max(ends) > min(starts):
            v = (max(ends) - min(starts)) * 1000.0
            body = t.get("payload") or {}
            # Legacy outcomes may lack attempt_id, so fall back to the trajectory's task_id for pairing
            for k in ("attempt_id", "session_id", "task_id"):
                if body.get(k):
                    out[str(body[k])] = v
            out.setdefault(str(t.get("session") or ""), v)
    return out


def population(traces, outcomes):
    tlat = _task_latency(traces) if traces else {}
    lat = []
    for o in outcomes:
        v = o.get("latency_ms", o.get("latencyMs"))
        if v is None:
            v = tlat.get(str(o.get("attempt_id") or "")) or tlat.get(str(o.get("session") or ""))
            if v is None:
                v = tlat.get(str(o.get("task_id") or ""))
        if v is not None:
            lat.append(v)
    rewards = [o["reward"] for o in outcomes if o.get("reward") is not None]
    succ = [1 if o.get("success") else 0 for o in outcomes]
    costs = [o["cost_usd"] for o in outcomes if o.get("cost_usd") is not None]
    steps = []
    spans = {}
    for t in traces:
        if t.get("kind") != "trajectory":
            continue
        body = (t.get("payload") or {}).get("steps") or []
        steps.append(len(body))
        for st in body:
            anc = ((st.get("extra") or {}).get("ancestry") or {})
            fn = anc.get("function_name") or st.get("source") or "step"
            a, b = _span(st)
            if a is None or b <= a:
                # Instant steps (user input, events with only a timestamp and no interval) always take 0ms;
                # listing them under Top Spans would just add a 0% row with no diagnostic value.
                continue
            acc = spans.setdefault(fn, [0.0, 0])
            acc[0] += b - a
            acc[1] += 1
    total = sum(v[0] for v in spans.values()) or 1.0
    top = [{"function": k, "mean_ms": round(v[0] / v[1] * 1000, 2),
            "share_pct": round(v[0] / total * 100, 2)}
           for k, v in sorted(spans.items(), key=lambda kv: -kv[1][0])[:20]]
    return {
        "tasks": len(outcomes),
        "success_rate": round(statistics.mean(succ), 4) if succ else None,
        "reward_mean": round(statistics.mean(rewards), 4) if rewards else None,
        "p50_latency_ms": _pct(lat, 50),
        "p95_latency_ms": _pct(lat, 95),
        "cost_usd": round(sum(costs), 6) if costs else None,
        "steps_mean": round(statistics.mean(steps), 2) if steps else None,
        "trajectories": sum(1 for t in traces if t.get("kind") == "trajectory"),
        "top_spans": top,
    }

def token_totals(outcomes):
    """Aggregate token usage. Without a price table cost is always 0, so tokens are the meaningful scale."""
    total = {"input": 0, "output": 0, "total": 0}
    for o in outcomes or []:
        usage = o.get("tokens")
        if not isinstance(usage, dict):
            continue
        total["input"] += int(usage.get("inputTokens") or 0)
        total["output"] += int(usage.get("outputTokens") or 0)
    if not (total["input"] or total["output"]):
        return None
    total["total"] = total["input"] + total["output"]
    return total


def is_profiling_run(traces):
    """agentx profiling has only lifecycle events and no agent steps.

    For such runs tasks / success rate / latency / steps are all empty metrics and must not
    be shown as real execution results; confirm via summary workload.kind and trajectory steps.
    """
    trajs = [t for t in traces or [] if t.get("kind") == "trajectory"]
    if not trajs:
        return False
    if any(((t.get("payload") or {}).get("steps") or []) for t in trajs):
        return False
    summaries = [t for t in traces or [] if t.get("kind") == "summary"]
    kinds = {((t.get("payload") or {}).get("workload") or {}).get("kind")
             for t in summaries}
    return bool(summaries) and kinds == {"agentx"}


PERF_TTFT_P95_MS = 1000.0
PERF_CACHE_HIT_MIN = 0.5
PERF_NPU_UTIL_MIN = 30.0
PERF_AICORE_UTIL_MIN = 30.0
# vLLM reserves memory up front via gpu-memory-utilization, so HBM usage sits near 90% most of the time;
# only near the ceiling is it worth flagging, otherwise every profiling run raises a false alarm.
PERF_HBM_USAGE_MAX = 95.0
PERF_TEMP_C_MAX = 80.0
PERF_SCALE_EFF_MIN = 0.6
PERF_GROW_MAX = 1.5
PERF_ITL_GROW_MAX = 2.0


def _perf_stat(prof, key, field="mean"):
    v = ((prof or {}).get(key) or {}).get(field)
    return float(v) if isinstance(v, (int, float)) else None


def _tier_label(conc):
    return "c%d" % conc if isinstance(conc, int) else "单档"


def _fmt_ms(v):
    return ("%.2fs" % (v / 1000)) if v >= 1000 else ("%.0fms" % v)


def _perf_advice(tiers):
    """Translate profiling metrics into deterministic optimization advice the RSI flow can consume directly."""
    out = []

    def add(severity, metric, value, action, reason=None):
        out.append({"severity": severity, "target": "infra", "metric": metric,
                    "value": value, "action": action, "reason": reason})

    hot = [r for r in tiers if r.get("ttft_p95") is not None and r["ttft_p95"] > PERF_TTFT_P95_MS]
    if hot:
        r = max(hot, key=lambda x: x["ttft_p95"])
        add("high", "TTFT p95", "%s（%s）" % (_fmt_ms(r["ttft_p95"]), _tier_label(r["concurrency"])),
            "检查 prefill 并发与 KV cache 冷启动，考虑 chunked prefill 或限制单批序列长度",
            "首 token 等待偏高，长 prompt 会放大排队")

    low_cache = [r for r in tiers if r.get("cache_hit") is not None and r["cache_hit"] < PERF_CACHE_HIT_MIN]
    if low_cache:
        r = min(low_cache, key=lambda x: x["cache_hit"])
        add("medium", "prefix cache 命中率", "%.0f%%（%s）" % (r["cache_hit"] * 100, _tier_label(r["concurrency"])),
            "统一 system prompt / 工具描述前缀，提高缓存复用",
            "重复 prefill 会增加 TTFT 与算力消耗")

    low_util = [r for r in tiers if r.get("npu_util") is not None and r["npu_util"] < PERF_NPU_UTIL_MIN]
    if low_util:
        r = min(low_util, key=lambda x: x["npu_util"])
        add("medium", "NPU 利用率", "%.0f%%（%s）" % (r["npu_util"], _tier_label(r["concurrency"])),
            "提高并发 batch 或请求数，让算力打满",
            "NPU 长时间空闲，吞吐受调度而非算力限制")

    low_core = [r for r in tiers if r.get("aicore_util") is not None and r["aicore_util"] < PERF_AICORE_UTIL_MIN]
    if low_core:
        r = min(low_core, key=lambda x: x["aicore_util"])
        add("medium", "AI Core 利用率", "%.0f%%（%s）" % (r["aicore_util"], _tier_label(r["concurrency"])),
            "检查算子下发与调度，确认 batch / 序列长度匹配负载特征",
            "AI Core 未跑满，可能存在算子或调度空转")

    high_hbm = [r for r in tiers if r.get("hbm_usage") is not None and r["hbm_usage"] > PERF_HBM_USAGE_MAX]
    if high_hbm:
        r = max(high_hbm, key=lambda x: x["hbm_usage"])
        add("high", "HBM 占用", "%.0f%%（%s）" % (r["hbm_usage"], _tier_label(r["concurrency"])),
            "下调 max-model-len / batch 或检查显存泄漏，避免频繁换入换出",
            "显存接近上限会拖慢 decode 并增加 OOM 风险")

    hot_temp = [r for r in tiers if r.get("temperature") is not None and r["temperature"] > PERF_TEMP_C_MAX]
    if hot_temp:
        r = max(hot_temp, key=lambda x: x["temperature"])
        add("medium", "NPU 温度", "%.0f°C（%s）" % (r["temperature"], _tier_label(r["concurrency"])),
            "检查散热与功耗墙，确认没有因降频导致吞吐波动",
            "高温会触发降频，指标可能随运行时长漂移")

    pts = [r for r in tiers if r.get("throughput") and r.get("concurrency")]
    if len(pts) >= 2:
        a, b = pts[0], pts[-1]
        ca, cb = a["concurrency"], b["concurrency"]
        if cb > ca and a["throughput"] > 0:
            ratio = b["throughput"] / a["throughput"]
            eff = ratio / (float(cb) / ca)
            if eff < PERF_SCALE_EFF_MIN:
                add("medium", "并发扩展效率",
                    "%.0f%%（c%d→c%d 吞吐 %.2fx）" % (eff * 100, ca, cb, ratio),
                    "检查调度与 batch 策略，排查 prefill / decode 争抢与队列等待",
                    "并发提升但吞吐未同比提升，算力没有有效利用")
        if a.get("ttft_p95") and b.get("ttft_p95") and b["ttft_p95"] / a["ttft_p95"] >= PERF_GROW_MAX:
            add("medium", "TTFT p95 随并发增长",
                "%s → %s（c%d→c%d）" % (_fmt_ms(a["ttft_p95"]), _fmt_ms(b["ttft_p95"]), ca, cb),
                "限制并发或拆分 prefill 批次，降低首 token 排队",
                "并发升高后首 token 明显变慢")
        if a.get("itl_mean") and b.get("itl_mean") and b["itl_mean"] / a["itl_mean"] >= PERF_ITL_GROW_MAX:
            add("medium", "ITL 随并发变慢",
                "%s → %s（c%d→c%d）" % (_fmt_ms(a["itl_mean"]), _fmt_ms(b["itl_mean"]), ca, cb),
                "检查 KV cache 带宽与 batch 上限，降低 decode 阶段排队",
                "并发升高后逐 token 延迟明显上升")

    order = {"high": 0, "medium": 1, "low": 2}
    out.sort(key=lambda x: order.get(x["severity"], 9))
    return out


PERF_DELTA_KEYS = ("ttft_p50", "ttft_p95", "itl_mean", "throughput",
                   "interactivity", "cache_hit", "npu_util", "aicore_util",
                   "hbm_usage", "temperature")


def _num_delta(cur, prev):
    if not isinstance(cur, (int, float)) or not isinstance(prev, (int, float)):
        return None
    return {"abs": round(float(cur) - float(prev), 4),
            "pct": round((float(cur) - float(prev)) / float(prev) * 100, 1) if prev else None}


def perf_delta(cur_tiers, parent_tiers):
    """Parent comparison for profiling: align by concurrency tier and compute diff and percentage per metric."""
    by_conc = {r.get("concurrency"): r for r in parent_tiers or []}
    rows = []
    for cur in cur_tiers or []:
        prev = by_conc.get(cur.get("concurrency")) or {}
        rows.append({
            "concurrency": cur.get("concurrency"),
            "current": {k: cur.get(k) for k in PERF_DELTA_KEYS},
            "parent": {k: prev.get(k) for k in PERF_DELTA_KEYS},
            "delta": {k: _num_delta(cur.get(k), prev.get(k)) for k in PERF_DELTA_KEYS},
        })
    return rows


def profiling_perf(traces):
    """Aggregate profiling metrics by concurrency tier and generate optimization advice.

    Profiling runs are also RSI optimization targets, so the feedback page must not merely
    point users at the metrics view; metrics and deterministic advice ship together so the
    page can show actionable items directly.
    """
    tiers = []
    for t in traces or []:
        if t.get("kind") != "summary":
            continue
        s = t.get("payload") or {}
        w = s.get("workload") or {}
        prof = s.get("profiling") or s.get("profiling_metrics") or {}
        conc = w.get("concurrency")
        row = {
            "concurrency": conc if isinstance(conc, int) else None,
            # One concurrency tier may have several summaries (multiple attempts / reruns);
            # carrying the source session lets load fields map back to their exact row.
            "session": t.get("session"),
            "ttft_p50": _perf_stat(prof, "ttft", "p50"),
            "ttft_p95": _perf_stat(prof, "ttft", "p95"),
            "itl_mean": _perf_stat(prof, "itl", "mean"),
            "latency_p95": _perf_stat(prof, "requestLatency", "p95"),
            "throughput": _perf_stat(prof, "totalThroughput", "mean"),
            "interactivity": _perf_stat(prof, "interactivity", "mean"),
            "cache_hit": None, "npu_util": None, "aicore_util": None,
            "hbm_usage": None, "temperature": None,
        }
        for src in (s.get("telemetry") or {}).get("sources") or []:
            series = {x.get("metric"): x for x in src.get("series") or [] if isinstance(x, dict)}
            if src.get("kind") == "vllm":
                q = (series.get("vllm:prefix_cache_queries") or {}).get("total")
                h = (series.get("vllm:prefix_cache_hits") or {}).get("total")
                if isinstance(q, (int, float)) and q > 0 and isinstance(h, (int, float)):
                    row["cache_hit"] = h / q
            elif src.get("kind") == "ascend":
                def mean(k):
                    return (series.get(k) or {}).get("mean")
                row["npu_util"] = mean("ascend_npu_utilization_percent")
                row["aicore_util"] = mean("ascend_npu_aicore_utilization_percent")
                row["hbm_usage"] = mean("ascend_npu_hbm_usage_percent")
                row["temperature"] = mean("ascend_npu_temperature_celsius")
        tiers.append(row)
    tiers.sort(key=lambda r: (r["concurrency"] is None, r["concurrency"] or 0))
    return {"tiers": tiers, "advice": _perf_advice(tiers)}


def profiling_concurrency(traces):
    """Concurrency tiers of a profiling run, rendered directly by the feedback page.

    The frontend derives tiers from the local summary replayed over SSE, which is not ready
    right after an epoch switch and would show only one tier; serving it from the server
    avoids that mismatch.
    """
    concs = set()
    for t in traces or []:
        if t.get("kind") != "summary":
            continue
        c = ((t.get("payload") or {}).get("workload") or {}).get("concurrency")
        if isinstance(c, (int, float)):
            concs.add(int(c))
    return sorted(concs)


def attach_parent_perf(perf, epoch, run, store):
    """Parent comparison for profiling: align metrics per concurrency tier; None means no comparable parent.

    A normal run's delta_vs_parent compares task success rate / latency, but agentx has no task
    results, so only inference and hardware metrics can be compared; downstream uses this to tell
    whether the tuning actually helped.
    """
    if store is None or not run or not run.get("parent_id"):
        return None
    parent_epoch, _parent_run = find_parent(store, epoch, run)
    if not parent_epoch:
        return None
    parent_traces = store.list_traces(parent_epoch)
    parent_perf = profiling_perf(parent_traces)
    out = {"epoch": parent_epoch, "profiling": is_profiling_run(parent_traces),
           "tiers": perf_delta(perf["tiers"], parent_perf["tiers"])}
    if not out["profiling"]:
        out["note"] = "父轮次不是 profiling run，没有推理/硬件指标可对比"
    return out


def build_feedback(epoch, run, traces, outcomes, store=None):
    pop = population(traces, outcomes)
    signals = build_signals(traces, outcomes, pop)
    delta = explain = None
    parent_epoch = parent_run = None
    if store is not None and run and run.get("parent_id"):
        parent_epoch, parent_run = find_parent(store, epoch, run)
        if parent_epoch:
            parent_pop = population(store.list_traces(parent_epoch),
                                    store.list_outcomes(parent_epoch))
            delta, explain = compute_delta(run, pop, parent_run, parent_pop, parent_epoch)
        else:
            explain = "未找到候选 %s 对应的父轮次，无法做版本对比。" % run.get("parent_id")
    fb = make_feedback(epoch, run, pop, signals, delta, explain)
    # Lets the frontend distinguish profiling runs so tasks=0 / steps=0 are not read as real execution results
    fb["profiling"] = is_profiling_run(traces)
    if fb["profiling"]:
        fb["profiling_concurrency"] = profiling_concurrency(traces)
        # Inference performance is also an RSI optimization target: ship metrics and advice together to the feedback page
        perf = profiling_perf(traces)
        # Profiling runs compare against the parent too, but on per-tier performance metrics rather than success rate
        if parent_epoch:
            parent = attach_parent_perf(perf, epoch, run, store)
            if parent:
                perf["parent"] = parent
        fb["perf"] = perf
    # Only goes into the returned payload, never into population: otherwise the LLM facts digest changes and every old analysis is invalidated
    fb["tokens"] = token_totals(outcomes)
    return fb
