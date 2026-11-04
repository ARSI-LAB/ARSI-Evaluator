"""Deterministic rule engine producing OptFeedback signals without any LLM call."""
from __future__ import annotations

ERR_STATUS = {"error", "failed", "failure", "timeout"}
SEV_ORDER = {"high": 0, "medium": 1, "low": 2}

SUCCESS_RATE_MIN = 0.8
P95_LATENCY_MS_MAX = 5000.0
COST_PER_TASK_MAX = 0.10
STEPS_MEAN_MAX = 30
SPAN_SHARE_MAX = 0.5
ERROR_RATIO_MIN = 0.05
CACHE_HIT_MIN = 0.5
NPU_UTIL_MIN = 30.0
TTFT_P95_MAX = 150.0
STEP_SHARE_MAX = 0.3


def _is_llm(fn):
    return (fn or "").lower().startswith("llm")


def _sig(severity, target, category, title, direction, evidence=None, detail=None):
    return {"id": "%s.%s" % (category, target), "severity": severity, "target": target,
            "category": category, "title": title, "evidence": evidence or {},
            "detail": detail, "suggestion": {"direction": direction}}


def _step_span(step):
    inv = ((step.get("extra") or {}).get("invocation") or {})
    s, e = inv.get("start_timestamp"), inv.get("end_timestamp")
    if isinstance(s, (int, float)) and isinstance(e, (int, float)) and e >= s:
        return float(s), float(e)
    return None, None


def _step_fn(step):
    anc = ((step.get("extra") or {}).get("ancestry") or {})
    return anc.get("function_name") or step.get("source") or "step"


def _outcome_signals(population, outcomes, out):
    sr = population.get("success_rate")
    if outcomes and sr is not None and sr < SUCCESS_RATE_MIN:
        failed = [o.get("task_id") for o in outcomes if not o.get("success")]
        out.append(_sig(
            "high", "agent", "quality",
            "成功率 %.1f%%" % (sr * 100,),
            "抽查失败任务的轨迹，优先修工具调用与重试策略",
            {"tasks": population.get("tasks"), "success_rate": sr,
             "metric": "success_rate", "failed_tasks": failed[:10]},
            "%d 个任务中 %d 个失败" % (population.get("tasks") or 0, len(failed))))

    p95 = population.get("p95_latency_ms")
    if p95 is not None and p95 >= P95_LATENCY_MS_MAX:
        out.append(_sig(
            "medium", "infra", "latency",
            "P95 时延 %.0f ms" % (p95,),
            "检查排队与 prefill 并发，必要时扩容或调低 batch 上限",
            {"p50_latency_ms": population.get("p50_latency_ms"), "p95_latency_ms": p95,
             "metric": "p95_latency_ms"},
            "P50 %.0f ms / P95 %.0f ms" % (population.get("p50_latency_ms") or 0, p95)))

    tasks = population.get("tasks") or 0
    cost = population.get("cost_usd")
    if tasks and cost is not None and cost / tasks > COST_PER_TASK_MAX:
        out.append(_sig(
            "medium", "infra", "cost",
            "单任务成本 $%.3f" % (cost / tasks,),
            "评估缓存复用与模型档位，优先压降重复 prefill",
            {"cost_usd": cost, "tasks": tasks, "cost_per_task": round(cost / tasks, 4),
             "metric": "cost_per_task"}))

    steps_mean = population.get("steps_mean")
    if steps_mean is not None and steps_mean > STEPS_MEAN_MAX:
        out.append(_sig(
            "medium", "harness", "efficiency",
            "平均 %.1f 步/轨迹" % (steps_mean,),
            "收敛提示词与工具集，减少无效探索步",
            {"steps_mean": steps_mean, "metric": "steps_mean"}))


def _step_signals(traces, out):
    errors, spans = [], {}
    total_steps = 0
    total_dur = 0.0
    for t in traces:
        if t.get("kind") != "trajectory":
            continue
        payload = t.get("payload") or {}
        for st in payload.get("steps") or []:
            if not isinstance(st, dict):
                continue
            total_steps += 1
            inv = ((st.get("extra") or {}).get("invocation") or {})
            status = str(inv.get("status") or st.get("status") or "").lower()
            if status in ERR_STATUS:
                errors.append({"session": t.get("session"), "step_id": st.get("step_id"),
                               "function": _step_fn(st), "status": status,
                               "error": inv.get("error")})
            a, b = _step_span(st)
            if a is not None:
                fn = _step_fn(st)
                if not _is_llm(fn):
                    # [accumulated duration, source session, slowest step_id, slowest step duration]
                    acc = spans.setdefault(fn, [0.0, None, None, 0.0])
                    acc[0] += b - a
                    if b - a > acc[3]:
                        acc[1], acc[2], acc[3] = t.get("session"), st.get("step_id"), b - a
                total_dur += b - a

    if errors:
        ratio = len(errors) / total_steps if total_steps else 0.0
        if ratio >= 0.1 or len(errors) >= 3:
            sev = "high"
        else:
            sev = "medium"
        out.append(_sig(
            sev, "harness", "error",
            "%d 个 step 执行失败（占 %.1f%%）" % (len(errors), ratio * 100),
            "按 function 聚合失败原因，补重试/降级和前置校验",
            {"total_steps": total_steps, "error_steps": len(errors),
             # first failing step anchors the root cause; the UI can jump straight to its waterfall row
             "session": errors[0]["session"], "step_id": errors[0]["step_id"],
             "samples": errors[:5]},
            "首个失败：%s / %s" % (errors[0]["function"], errors[0]["status"])))

    if total_dur > 0 and total_steps > 1 and spans:
        fn, acc = max(spans.items(), key=lambda kv: kv[1][0])
        dur = acc[0]
        share = dur / total_dur
        if share >= SPAN_SHARE_MAX:
            out.append(_sig(
                "medium", "harness", "bottleneck",
                "%s 占全程 %.0f%%" % (fn, share * 100),
                "拆分或并行化该步骤，减少串行等待",
                {"function": fn, "share_pct": round(share * 100, 2),
                 "duration_ms": round(dur * 1000, 2),
                 # jump to the slowest step inside this function: the most representative sample
                 "session": acc[1], "step_id": acc[2]},
                "该函数累计 %.2f s / 全程 %.2f s" % (dur, total_dur)))


def _summary_signals(traces, out):
    latest = {}
    for t in traces:
        if t.get("kind") == "summary":
            latest[t.get("session")] = t.get("payload") or {}
    for session, md in latest.items():
        profiling = md.get("profiling") or md.get("profiling_metrics") or {}
        ttft = profiling.get("ttft") or {}
        if ttft.get("p95") is not None and ttft["p95"] > TTFT_P95_MAX:
            out.append(_sig(
                "medium", "infra", "ttft",
                "TTFT p95 %.0f" % (ttft["p95"],),
                "检查 prefill 并发与 KV cache 冷启动，考虑 chunked prefill",
                {"session": session, "ttft": ttft, "metric": "ttft.p95"}))

        for src in ((md.get("telemetry") or {}).get("sources") or []):
            series = {s.get("metric"): s for s in src.get("series") or []
                      if isinstance(s, dict)}
            if src.get("kind") == "vllm":
                q = (series.get("vllm:prefix_cache_queries") or {}).get("total")
                h = (series.get("vllm:prefix_cache_hits") or {}).get("total")
                if isinstance(q, (int, float)) and q > 0 and isinstance(h, (int, float)):
                    hit = h / q
                    if hit < CACHE_HIT_MIN:
                        out.append(_sig(
                            "medium", "infra", "cache",
                            "prefix cache 命中率 %.0f%%" % (hit * 100),
                            "统一 system prompt 前缀，提高缓存复用",
                            {"session": session, "queries": q, "hits": h,
                             "hit_rate": round(hit, 4),
                             "metric": "vllm:prefix_cache_hits"}))
            if src.get("kind") == "ascend":
                util = series.get("ascend_npu_utilization_percent") or {}
                mean = util.get("mean")
                if isinstance(mean, (int, float)) and mean < NPU_UTIL_MIN:
                    out.append(_sig(
                        "medium", "infra", "utilization",
                        "NPU 平均利用率 %.0f%%" % (mean,),
                        "提高并发 batch，让算力打满",
                        {"session": session, "mean": mean, "max": util.get("max"),
                         "metric": "ascend_npu_utilization_percent"}))


def build_signals(traces, outcomes, population):
    out = []
    _outcome_signals(population or {}, outcomes or [], out)
    _step_signals(traces or [], out)
    _summary_signals(traces or [], out)
    out.sort(key=lambda s: SEV_ORDER.get(s["severity"], 9))
    return out


def analyze_digest(digest):
    """Run rule analysis over a digest submitted by the frontend; returns {summary, scores, findings}."""
    d = digest or {}
    steps = d.get("steps") or []
    total = sum(s.get("dur") or 0 for s in steps) or 1.0
    findings = []
    seen_fn = {}

    for s in steps:
        if s.get("error"):
            findings.append({
                "severity": "high", "category": "error",
                "title": "%s 执行失败" % (s.get("fn") or "step"),
                "detail": str(s.get("error")),
                "recommendation": "检查工具依赖与重试策略",
                "evidence": {"step_id": s.get("step_id")}})
        elif len(steps) > 1 and not _is_llm(s.get("fn")) and (s.get("dur") or 0) / total >= STEP_SHARE_MAX:
            findings.append({
                "severity": "high", "category": "bottleneck",
                "title": "%s 占全程 %.0f%%" % (s.get("fn") or "step",
                                               (s.get("dur") or 0) / total * 100),
                "detail": "该步 %.2f s / 总 %.2f s" % (s.get("dur") or 0, total),
                "recommendation": "考虑拆分或并行化该步骤",
                "evidence": {"step_id": s.get("step_id")}})
        fn = s.get("fn")
        if fn:
            seen_fn[fn] = seen_fn.get(fn, 0) + 1

    cache = d.get("cache") or {}
    q = (cache.get("vllm:prefix_cache_queries") or {}).get("total")
    h = (cache.get("vllm:prefix_cache_hits") or {}).get("total")
    if isinstance(q, (int, float)) and q > 0 and isinstance(h, (int, float)):
        if h / q < CACHE_HIT_MIN:
            findings.append({
                "severity": "medium", "category": "cache",
                "title": "prefix cache 命中率仅 %.0f%%" % (h / q * 100),
                "detail": "%s/%s tokens" % (int(h), int(q)),
                "recommendation": "统一 system prompt 前缀以提高复用",
                "evidence": {"metric": "vllm:prefix_cache_hits"}})

    hw = d.get("hardware") or {}
    nu = hw.get("ascend_npu_utilization_percent") or {}
    if isinstance(nu.get("mean"), (int, float)) and nu["mean"] < NPU_UTIL_MIN:
        findings.append({
            "severity": "medium", "category": "utilization",
            "title": "NPU 利用率偏低 (mean %.0f%%)" % nu["mean"],
            "detail": "max %s%%" % nu.get("max"),
            "recommendation": "提高并发 batch 以打满算力",
            "evidence": {"metric": "ascend_npu_utilization_percent"}})

    ttft = ((d.get("inference") or {}).get("ttft") or {})
    if isinstance(ttft.get("p95"), (int, float)) and ttft["p95"] > TTFT_P95_MAX:
        findings.append({
            "severity": "medium", "category": "latency",
            "title": "TTFT p95 偏高 (%s)" % ttft["p95"],
            "detail": "prefill 阶段可能排队",
            "recommendation": "检查 prefill 并发 / chunked prefill / KV cache 冷启动",
            "evidence": {"metric": "ttft.p95"}})

    if len(steps) > STEPS_MEAN_MAX:
        findings.append({
            "severity": "low", "category": "efficiency",
            "title": "单条轨迹 %d 步，偏长" % len(steps),
            "detail": "检查是否存在重复探索",
            "recommendation": "收敛提示词与工具集",
            "evidence": {"steps": len(steps)}})

    if not findings:
        findings.append({
            "severity": "low", "category": "summary",
            "title": "未发现明显异常",
            "detail": "轨迹与指标未发现异常",
            "recommendation": "—"})
    return {"summary": "规则分析（未调用 LLM）", "scores": None, "findings": findings}


def signals_to_findings(signals):
    return [{"severity": s["severity"], "category": s["category"], "title": s["title"],
             "detail": s.get("detail"), "recommendation": (s.get("suggestion") or {}).get("direction"),
             "evidence": s.get("evidence") or {}} for s in signals]
