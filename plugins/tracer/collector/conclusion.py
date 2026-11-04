"""Evaluation conclusion engine shared by the dashboard and the RSI optimizer."""
from __future__ import annotations

import json
import time

from aggregate import token_totals
from delta import MIN_TASKS, SUCCESS_EPS
from signals import ERR_STATUS

SCHEMA_VERSION = "EvalConclusion"
RULES_VERSION = 2
# Task-level comparison (pass -> fail) holds even on small samples, but confidence must be tiered by sample size
TASK_SAMPLE_MEDIUM = 5
# Below this many common tasks a task-level flip cannot veto a whole round: one task moving is not a regression
TASK_SAMPLE_MIN = 3
# success unchanged but reward clearly down: 20% relative plus 0.1 absolute, avoiding percentage noise on small baselines
REWARD_REL_DROP = 0.2
REWARD_ABS_DROP = 0.1
MAX_ACTIONS = 5
MAX_CHALLENGES = 4
MAX_EVIDENCE_TASKS = 10
MAX_STEP_IDS = 500

DECISION_LABEL = {"accept": "通过", "reject": "拒绝", "inconclusive": "待定"}
CONFIDENCE_LABEL = {"high": "高", "medium": "中", "low": "低"}


def _verdict(decision, confidence, code, text, evidence=None):
    return {"decision": decision, "confidence": confidence,
            "reasons": [{"code": code, "text": text, "evidence": evidence or {}}]}


def _confidence(n_tasks):
    if n_tasks >= MIN_TASKS:
        return "high"
    if n_tasks >= TASK_SAMPLE_MEDIUM:
        return "medium"
    return "low"


def _task_map(outcomes):
    return {str(o.get("task_id")): o for o in outcomes or [] if o.get("task_id")}


def _task_diff(current, parent):
    """Compare per task: a pass/fail flip is a hard regression, a clear reward drop is a soft one (an early quality signal)."""
    regressed, improved, drops = [], [], []
    for task_id, cur in current.items():
        prev = parent.get(task_id)
        if prev is None:
            continue
        cur_ok, prev_ok = bool(cur.get("success")), bool(prev.get("success"))
        if prev_ok and not cur_ok:
            regressed.append(task_id)
            continue
        if cur_ok and not prev_ok:
            improved.append(task_id)
            continue
        # When pass/fail is unchanged, a continuous reward decline is invisible to the success boolean
        before, after = prev.get("reward"), cur.get("reward")
        if not isinstance(before, (int, float)) or not isinstance(after, (int, float)):
            continue
        drop = float(before) - float(after)
        if float(before) > 0 and drop >= REWARD_ABS_DROP \
                and drop / abs(float(before)) >= REWARD_REL_DROP:
            drops.append({"task_id": task_id, "before": round(float(before), 4),
                          "after": round(float(after), 4), "delta": round(-drop, 4)})
    drops.sort(key=lambda d: d["delta"])
    return sorted(regressed), sorted(improved), drops


def _metric_changes(delta):
    """Split delta into worse / better buckets; only judge when the overall delta is significant."""
    if not delta or not delta.get("significant"):
        return [], []
    values = delta.get("values") or {}
    cur, prev = values.get("current") or {}, values.get("parent") or {}
    worse, better = [], []

    def add(bucket, metric, before, after, diff):
        bucket.append({"metric": metric, "before": before, "after": after,
                       "delta": diff})

    sr = delta.get("success_rate")
    if isinstance(sr, (int, float)) and abs(sr) >= SUCCESS_EPS:
        add(worse if sr < 0 else better, "success_rate",
            prev.get("success_rate"), cur.get("success_rate"), sr)
    p95 = delta.get("p95_latency_ms")
    before = prev.get("p95_latency_ms")
    if isinstance(p95, (int, float)) and isinstance(before, (int, float)) and before > 0:
        if abs(p95) / abs(before) >= 0.1:
            add(worse if p95 > 0 else better, "p95_latency_ms",
                before, cur.get("p95_latency_ms"), p95)
    cost = delta.get("cost_per_task")
    before = prev.get("cost_per_task")
    if isinstance(cost, (int, float)) and isinstance(before, (int, float)) and before > 0:
        if abs(cost) / abs(before) >= 0.1:
            # Higher cost is worse
            add(worse if cost > 0 else better, "cost_per_task", before,
                cur.get("cost_per_task"), cost)
    return worse, better


def _decide(run, metrics, signals, delta, regressed, improved, reward_drops,
            n_common, attribution):
    status = (run or {}).get("status")
    if status != "finished":
        return _verdict("inconclusive", "low", "run_incomplete",
                        "该轮次尚未收尾，结论不完整", {"status": status})
    if not metrics.get("tasks"):
        return _verdict("inconclusive", "low", "no_outcomes",
                        "本轮没有任何任务结果，无法下结论", {})
    if attribution.get("changed") == "benchmark" or "benchmark" in (attribution.get("keys") or []):
        return _verdict("inconclusive", "low", "benchmark_changed",
                        "本轮评测集/范围发生变更，前后指标不可直接比较",
                        {"keys": attribution.get("keys")})
    if delta is None:
        if (run or {}).get("parent_id"):
            return _verdict("inconclusive", "low", "parent_not_found",
                            "找不到父轮次记录，无法计算 delta",
                            {"parent_id": run.get("parent_id")})
        return _verdict("inconclusive", "low", "baseline_only",
                        "无父轮次可对比，本轮仅作为基线记录", {})

    conf = _confidence(n_common)
    # Verdict strength must match sample size: with only 1~2 common tasks, a single flip cannot veto a whole round
    if (regressed or improved or reward_drops) and n_common < TASK_SAMPLE_MIN:
        return _verdict("inconclusive", "low", "task_sample_too_small",
                        "共同任务仅 %d 个，任务级差异不足以判定" % n_common,
                        {"common_tasks": n_common, "min_tasks": TASK_SAMPLE_MIN,
                         "regressed": regressed[:MAX_EVIDENCE_TASKS],
                         "improved": improved[:MAX_EVIDENCE_TASKS],
                         "reward_drops": reward_drops[:MAX_EVIDENCE_TASKS]})
    if regressed and not improved:
        return _verdict("reject", conf, "task_regression",
                        "%d 个任务从通过变为失败" % len(regressed),
                        {"tasks": regressed[:MAX_EVIDENCE_TASKS],
                         "parent_epoch": delta.get("parent_epoch")})
    if improved and not regressed:
        if not reward_drops:
            return _verdict("accept", conf, "task_improvement",
                            "%d 个任务从失败变为通过" % len(improved),
                            {"tasks": improved[:MAX_EVIDENCE_TASKS],
                             "parent_epoch": delta.get("parent_epoch")})
        # Tasks improved, but some still passing tasks dropped clearly in reward
        return _verdict("inconclusive", conf, "mixed_quality",
                        "%d 个任务改进，但同时有 %d 个任务 reward 明显下滑" % (
                            len(improved), len(reward_drops)),
                        {"improved": improved[:MAX_EVIDENCE_TASKS],
                         "reward_drops": reward_drops[:MAX_EVIDENCE_TASKS]})
    if regressed and improved:
        return _verdict("inconclusive", "low", "mixed_changes",
                        "既有 %d 个任务回退，也有 %d 个任务改进，需人工判断" % (
                            len(regressed), len(improved)),
                        {"regressed": regressed[:MAX_EVIDENCE_TASKS],
                         "improved": improved[:MAX_EVIDENCE_TASKS]})
    if reward_drops:
        return _verdict("inconclusive", conf, "reward_regression",
                        "%d 个任务通过状态未变，但 reward 明显下滑" % len(reward_drops),
                        {"tasks": reward_drops[:MAX_EVIDENCE_TASKS],
                         "parent_epoch": delta.get("parent_epoch")})

    worse, better = _metric_changes(delta)
    if worse and not better:
        return _verdict("reject", "high", "metric_regression",
                        "显著指标回归：%s" % "、".join(w["metric"] for w in worse),
                        {"changes": worse})
    if better and not worse:
        return _verdict("accept", "high", "metric_improvement",
                        "显著指标改进：%s" % "、".join(b["metric"] for b in better),
                        {"changes": better})
    if worse and better:
        return _verdict("inconclusive", "low", "mixed_metrics",
                        "指标互有升降，无法给出单一结论",
                        {"regressions": worse, "improvements": better})
    if conf == "low":
        return _verdict("inconclusive", "low", "insufficient_samples",
                        "样本量不足以判断回归（%d 个可比任务）" % n_common,
                        {"common_tasks": n_common, "min_tasks": MIN_TASKS})
    return _verdict("accept", conf, "no_regression",
                    "未发现回归，可以进入下一轮", {"common_tasks": n_common})


def _task_summary(outcomes):
    outcomes = outcomes or []
    failed = [o for o in outcomes if not o.get("success")]
    errored = [o for o in failed
               if str(o.get("status") or "").lower() in ERR_STATUS]
    attempts = {}
    for o in outcomes:
        task_id = str(o.get("task_id"))
        attempts.setdefault(task_id, set()).add(str(o.get("attempt_id") or task_id))
    max_attempts = max([len(v) for v in attempts.values()] or [0])
    return {
        "passed": len(outcomes) - len(failed),
        "failed": len(failed),
        "errored": len(errored),
        "failures": [{"task_id": o.get("task_id"), "status": o.get("status"),
                      "reward": o.get("reward")}
                     for o in failed[:MAX_EVIDENCE_TASKS]],
        "attempts_per_task": max_attempts,
    }


def _next_actions(signals):
    """Keep only the most severe signal per category so one root cause does not flood the list."""
    seen, actions = set(), []
    for sig in signals or []:
        category = sig.get("category")
        if category in seen:
            continue
        seen.add(category)
        actions.append({
            "priority": sig.get("severity"),
            "target": sig.get("target"),
            "action": (sig.get("suggestion") or {}).get("direction") or sig.get("title"),
            "reason": sig.get("title"),
            "evidence": sig.get("evidence") or {},
        })
        if len(actions) >= MAX_ACTIONS:
            break
    return actions


def _evidence_index(traces):
    step_ids, sessions = [], set()
    for trace in traces or []:
        if trace.get("kind") != "trajectory":
            continue
        payload = trace.get("payload") or {}
        session = str(trace.get("session") or payload.get("session_id") or "")
        if session:
            sessions.add(session)
        for step in payload.get("steps") or []:
            if isinstance(step, dict) and step.get("step_id") is not None:
                step_ids.append(str(step["step_id"]))
    return {"step_ids": step_ids[:MAX_STEP_IDS], "sessions": sorted(sessions)}


def _metrics(pop, tokens):
    pop = pop or {}
    tasks = pop.get("tasks") or 0
    cost = pop.get("cost_usd")
    return {
        "tasks": pop.get("tasks"),
        "success_rate": pop.get("success_rate"),
        "reward_mean": pop.get("reward_mean"),
        "p50_latency_ms": pop.get("p50_latency_ms"),
        "p95_latency_ms": pop.get("p95_latency_ms"),
        "cost_usd": cost,
        "cost_per_task": round(cost / tasks, 6)
        if isinstance(cost, (int, float)) and tasks else None,
        "tokens": tokens,
        "steps_mean": pop.get("steps_mean"),
        "trajectories": pop.get("trajectories"),
    }


def _challenges(verdict, analysis, signals, n_common):
    """Challenge the verdict: only contrast existing LLM findings / deterministic signals against it, never alter it.

    No extra LLM call on purpose: this runs on the main finish path and another round trip would slow
    it down; the findings are already evidence-checked, so colliding them with the verdict still surfaces disagreement.
    """
    decision = verdict.get("decision")
    code = ((verdict.get("reasons") or [{}])[0] or {}).get("code")
    analysis = analysis or {}
    findings = analysis.get("findings") or []
    llm_ready = analysis.get("source") == "llm"
    high_findings = [f for f in findings if f.get("severity") == "high"]
    high_signals = [s for s in signals or [] if s.get("severity") == "high"]
    out = []

    def add(text, basis, severity="medium", ref=None):
        if len(out) < MAX_CHALLENGES:
            out.append({"text": text, "basis": basis, "severity": severity,
                        "ref": ref or {}})

    if decision == "accept":
        for finding in high_findings[:2]:
            add("规则判通过，但 LLM 归因指出 high 级问题：%s" % finding.get("title"),
                "analysis", "high", finding.get("evidence"))
        for sig in high_signals[:1]:
            add("规则判通过，但确定性信号中存在 high 级问题：%s" % sig.get("title"),
                "signal", "high", {"signal": sig.get("id")})
        if not llm_ready:
            add("规则判通过，但本轮没有 LLM 归因可交叉验证", "no_analysis", "low")
    elif decision == "reject":
        if llm_ready and not high_findings \
                and not [f for f in findings if f.get("severity") == "medium"]:
            add("规则判拒绝，但 LLM 未发现中高等级质量问题，可能是统计波动或环境抖动",
                "analysis", "medium")
        if code == "task_regression" and verdict.get("confidence") == "low":
            add("仅基于 %d 个共同任务判拒绝，样本不足以排除单任务波动" % n_common,
                "sample", "medium", {"common_tasks": n_common})
    elif decision == "inconclusive":
        # "Inconclusive" may stem from small samples, a benchmark change, or a missing baseline;
        # if high-severity signals exist in absolute terms, the verdict understates severity, so only flag this mismatch.
        if high_signals:
            add("判决为待定，但本轮有 %d 个 high 级信号，绝对水平已不合格：%s"
                % (len(high_signals), high_signals[0].get("title")),
                "signal", "high", {"signals": [s.get("id") for s in high_signals[:5]]})
    return out


def build_conclusion(epoch, run, population, signals, outcomes, traces=None,
                     delta=None, explain=None, parent=None, analysis=None):
    """Build the conclusion object for one run; parent only needs {"epoch", "outcomes"}."""
    run = run or {}
    metrics = _metrics(population, token_totals(outcomes))
    task_summary = _task_summary(outcomes)
    parent = parent or {}
    regressed, improved, reward_drops, n_common = [], [], [], 0
    if parent.get("outcomes") is not None:
        cur_map, prev_map = _task_map(outcomes), _task_map(parent.get("outcomes"))
        n_common = len(set(cur_map) & set(prev_map))
        regressed, improved, reward_drops = _task_diff(cur_map, prev_map)
    attribution = (delta or {}).get("attribution") or {
        "changed": "unknown", "keys": [], "unchanged": [],
        "note": "无父轮次可对比，无法归因"}
    verdict = _decide(run, metrics, signals, delta, regressed, improved,
                      reward_drops, n_common, attribution)
    # Verdicts come only from rules; challenges merely flag that someone disagrees and never take part in the decision
    verdict["decided_by"] = "rules"
    verdict["challenges"] = _challenges(verdict, analysis, signals, n_common)
    config = run.get("config")
    if isinstance(config, str):
        try:
            config = json.loads(config)
        except ValueError:
            config = None
    return {
        "schema_version": SCHEMA_VERSION,
        "engine": {"version": RULES_VERSION, "rules_version": RULES_VERSION,
                   "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())},
        "epoch": epoch,
        "run": {"status": run.get("status"),
                "candidate_id": run.get("candidate_id"),
                "parent_id": run.get("parent_id"),
                "config": config if isinstance(config, dict) else None},
        "verdict": verdict,
        "metrics": metrics,
        "task_summary": task_summary,
        "delta_vs_parent": delta,
        "attribution": attribution,
        "next_actions": _next_actions(signals),
        "signals": signals or [],
        "analysis": analysis,
        "evidence_index": _evidence_index(traces),
        "capabilities": {
            "pass_at_k": "unavailable" if (task_summary["attempts_per_task"] or 0) <= 1
            else "supported",
            "attempts_per_task": task_summary["attempts_per_task"],
            "note": "pass@k / flakiness 需要同一任务多次采样，当前每个任务只有 1 个 attempt",
        },
    }


def _num(value, digits=2, suffix=""):
    if value is None:
        return "—"
    if isinstance(value, (int, float)):
        return format(value, ".%df" % digits) + suffix
    return str(value)


def conclusion_markdown(c):
    """Human-readable version: verdict first, then evidence, then next actions."""
    verdict = c.get("verdict") or {}
    metrics = c.get("metrics") or {}
    lines = ["# 评测结论 · epoch %s" % c.get("epoch"), "",
             "## %s（置信度 %s）" % (DECISION_LABEL.get(verdict.get("decision"),
                                                     verdict.get("decision")),
                                CONFIDENCE_LABEL.get(verdict.get("confidence"),
                                                     verdict.get("confidence"))), ""]
    for reason in verdict.get("reasons") or []:
        lines.append("- %s（`%s`）" % (reason.get("text"), reason.get("code")))
    lines.append("")

    challenges = verdict.get("challenges") or []
    if challenges:
        lines += ["### 对判决的质疑（不改变判决）", ""]
        for challenge in challenges:
            lines.append("- [%s] %s" % (challenge.get("severity"), challenge.get("text")))
        lines.append("")

    lines += ["## 指标", "", "| 指标 | 值 |", "| --- | --- |"]
    tokens = metrics.get("tokens") or {}
    rows = [("tasks", metrics.get("tasks")),
            ("success_rate", _num(metrics.get("success_rate"), 4)),
            ("reward_mean", _num(metrics.get("reward_mean"), 4)),
            ("p50_latency_ms", _num(metrics.get("p50_latency_ms"), 0)),
            ("p95_latency_ms", _num(metrics.get("p95_latency_ms"), 0)),
            ("cost_per_task", _num(metrics.get("cost_per_task"), 4)),
            ("tokens", "%s in / %s out" % (tokens.get("input", "—"), tokens.get("output", "—"))),
            ("steps_mean", _num(metrics.get("steps_mean")))]
    for key, value in rows:
        lines.append("| %s | %s |" % (key, "—" if value is None else value))
    lines.append("")

    summary = c.get("task_summary") or {}
    lines += ["## 任务", "",
              "- 通过 %s / 失败 %s / 报错 %s" % (summary.get("passed"), summary.get("failed"),
                                              summary.get("errored"))]
    for failure in summary.get("failures") or []:
        lines.append("- 失败 %s · status=%s · reward=%s" % (
            failure.get("task_id"), failure.get("status") or "—",
            failure.get("reward")))
    lines.append("")

    delta = c.get("delta_vs_parent")
    if delta:
        changes = []
        for key, unit, digits in (("success_rate", "pp", 1), ("p50_latency_ms", " ms", 0),
                                  ("p95_latency_ms", " ms", 0), ("cost_per_task", "", 4),
                                  ("steps_mean", "", 2)):
            value = delta.get(key)
            if value is None:
                continue
            if key == "success_rate":
                value = value * 100
            changes.append("%s %+.*f%s" % (key, digits, value, unit))
        lines += ["## 对比父轮次 %s" % delta.get("parent_epoch"), "",
                  "- " + ("，".join(changes) if changes else "核心指标无变化"),
                  "- 显著性：%s" % ("显著" if delta.get("significant") else "不显著")]
        diff_ci = (delta.get("success_rate_ci") or {}).get("diff")
        if diff_ci:
            lines.append("- 成功率变化 95%% 区间 [%+.1fpp, %+.1fpp]%s" % (
                diff_ci[0] * 100, diff_ci[1] * 100,
                "，跨 0 视为噪声" if diff_ci[0] <= 0 <= diff_ci[1] else ""))
        attribution = c.get("attribution") or {}
        lines.append("- 归因：%s %s" % (attribution.get("changed") or "未知",
                                      attribution.get("note") or ""))
        lines.append("")
    elif c.get("attribution"):
        lines += ["## 归因", "", "- %s" % (c["attribution"].get("note") or "无父轮次可对比"), ""]

    actions = c.get("next_actions") or []
    lines += ["## 下一步动作", ""]
    if not actions:
        lines.append("- 无需处理")
    for action in actions:
        lines.append("- [%s] %s：%s" % (action.get("priority"), action.get("target"),
                                       action.get("action")))
    lines.append("")

    signals = c.get("signals") or []
    lines += ["## 确定性信号（%d 条）" % len(signals), ""]
    for sig in signals:
        lines.append("- [%s] %s / %s · %s" % (sig.get("severity"), sig.get("target"),
                                             sig.get("category"), sig.get("title")))
    if signals:
        lines.append("")

    analysis = c.get("analysis") or {}
    if analysis.get("source") == "llm":
        lines += ["## LLM 归因（%s）" % analysis.get("model"), "",
                  analysis.get("summary") or ""]
        for finding in analysis.get("findings") or []:
            lines.append("- [%s] %s：%s" % (finding.get("severity"),
                                           finding.get("title"),
                                           finding.get("recommendation") or ""))
    else:
        lines += ["## LLM 归因", "",
                  "- 未启用（%s）" % ("规则回退" if analysis.get("source") == "rules"
                                    else "未配置 provider")]
    lines.append("")
    return "\n".join(lines)
