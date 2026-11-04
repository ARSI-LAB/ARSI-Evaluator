"""Deterministic analysis, LLM analysis orchestration and on-disk export."""
from __future__ import annotations

import asyncio
import json
import sys
import time
from pathlib import Path

import llm_analysis as LLM
from aggregate import (attach_parent_perf, build_feedback, is_profiling_run,
                       population, profiling_perf)
from conclusion import build_conclusion, conclusion_markdown
from delta import compute_delta, find_parent
from discovery import find_dir_by_name
from runtime import RT
from signals import build_signals
from llm_analysis import analyze_epoch

# Epochs with an analysis in flight; keeps refreshes from stacking duplicate runs.
_ANALYZING = set()
# Epochs whose automatic analysis failed once; manual rerun is required.
_ANALYSIS_FAILED = set()


def analyzing(epoch):
    return epoch in _ANALYZING


def mark_analyzing(epoch):
    _ANALYZING.add(epoch)


def release(epoch):
    _ANALYZING.discard(epoch)


def failed(epoch):
    return epoch in _ANALYSIS_FAILED


def mark_failed(epoch):
    _ANALYSIS_FAILED.add(epoch)


def clear_failed(epoch):
    _ANALYSIS_FAILED.discard(epoch)


async def analyze_epoch_task(epoch):
    """Background analysis; failures must never affect the finish response."""
    try:
        result = await asyncio.to_thread(analyze_epoch, RT.store, epoch)
    except Exception as exc:
        RT.st.metrics["processing_errors"] += 1
        print("[tracer] llm analysis crashed for %s: %r" % (epoch, exc), file=sys.stderr, flush=True)
        return
    if result and result.get("error"):
        print("[tracer] llm analysis failed for %s: %s" % (epoch, result["error"]),
              file=sys.stderr, flush=True)
    elif result:
        # The plugin exports at finish time, before the LLM result exists.
        export_analysis(epoch)
    return result


async def reanalyze(epoch):
    try:
        result = await analyze_epoch_task(epoch)
        if result is None or result.get("error"):
            _ANALYSIS_FAILED.add(epoch)
    finally:
        _ANALYZING.discard(epoch)


def artifacts_of(run):
    """runs.artifacts holds JSON text; corrupted values must not break the API."""
    raw = (run or {}).get("artifacts")
    if not raw:
        return {}
    try:
        value = json.loads(raw) if isinstance(raw, str) else raw
    except Exception:
        return {}
    return value if isinstance(value, dict) else {}


def run_analysis_dir(epoch):
    """Resolve <run>/analysis: the recorded run_dir first, otherwise by directory name."""
    run_dir = artifacts_of(RT.store.get_run(epoch)).get("run_dir")
    root = Path(run_dir) if run_dir else None
    if root is None or not root.is_dir():
        root = find_dir_by_name(epoch)
    return (root / "analysis") if root else None


def export_analysis(epoch, run_dir=None):
    """Write deterministic results, keeping the LLM explanation in its own file."""
    try:
        if run_dir:
            out = Path(run_dir) / "analysis"
        else:
            out = run_analysis_dir(epoch)
        if out is None:
            return
        out.mkdir(parents=True, exist_ok=True)
        conclusion = conclusion_payload(epoch)
        analysis = conclusion.get("analysis") or {}
        run = RT.store.get_run(epoch) or {}
        feedback = build_feedback(epoch, run, RT.store.list_traces(epoch),
                                  RT.store.list_outcomes(epoch), RT.store)
        feedback["analysis"] = analysis
        files = {"signals.json": signals_payload(epoch), "conclusion.json": conclusion,
                 "feedback.json": feedback}
        if analysis:
            files["analysis.json"] = {
                "epoch": epoch,
                "generated_at": conclusion.get("generated_at"),
                "note": "LLM 归因，仅供参考；确定性指标见 signals.json / conclusion.json",
                **analysis,
            }
        for name, data in files.items():
            (out / name).write_text(
                json.dumps(data, ensure_ascii=False, indent=2, default=str), encoding="utf-8")
    except Exception as exc:
        print("[tracer] export analysis failed for %s: %r" % (epoch, exc),
              file=sys.stderr, flush=True)


def signals_payload(epoch):
    """Deterministic signals: rule-based only, safe for downstream consumers."""
    run = RT.store.get_run(epoch) or {}
    traces = RT.store.list_traces(epoch)
    outcomes = RT.store.list_outcomes(epoch)
    pop = population(traces, outcomes)
    payload = {"schema_version": 1, "epoch": epoch, "status": run.get("status"),
               "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
               "source": "rules", "population": pop,
               "signals": build_signals(traces, outcomes, pop)}
    # Profiling runs carry per-tier inference/hardware metrics instead of population data.
    if is_profiling_run(traces):
        perf = profiling_perf(traces)
        parent = attach_parent_perf(perf, epoch, run, RT.store)
        if parent:
            perf["parent"] = parent
        payload["profiling"] = perf
    return payload


def signals_markdown(p):
    lines = ["# 确定性信号 · epoch %s" % p["epoch"], "",
             "- status: %s" % (p.get("status") or "—"),
             "- generated_at: %s" % p["generated_at"],
             "- source: rules（不依赖 LLM，可重复计算）", ""]
    pop = p.get("population") or {}
    if pop:
        lines += ["| 指标 | 值 |", "| --- | --- |"]
        for k, v in pop.items():
            if isinstance(v, (int, float, str)) or v is None:
                lines.append("| %s | %s |" % (k, "—" if v is None else v))
        lines.append("")
    sigs = p.get("signals") or []
    counts = {}
    for s in sigs:
        counts[s.get("severity", "low")] = counts.get(s.get("severity", "low"), 0) + 1
    lines.append("## 汇总：%d 条（%s）" % (
        len(sigs), " · ".join("%s %d" % (k, v) for k, v in sorted(counts.items())) or "无"))
    lines.append("")
    for s in sigs:
        lines.append("### [%s] %s / %s" % (str(s.get("severity", "low")).upper(),
                                          s.get("target", ""), s.get("category", "")))
        lines.append("")
        lines.append(s.get("title", ""))
        if s.get("detail"):
            lines.append("")
            lines.append(s["detail"])
        sug = (s.get("suggestion") or {}).get("direction")
        if sug:
            lines.append("")
            lines.append("→ %s" % sug)
        ev = s.get("evidence")
        if ev:
            lines.append("")
            lines.append("evidence: `%s`" % json.dumps(ev, ensure_ascii=False, sort_keys=True))
        lines.append("")
    return "\n".join(lines)


def _parent_context(store, epoch, run):
    """Task-level delta only needs the parent's outcomes, not a full population pass."""
    if store is None or not run or not run.get("parent_id"):
        return None
    parent_epoch, _ = find_parent(store, epoch, run)
    if not parent_epoch:
        return None
    return {"epoch": parent_epoch, "outcomes": store.list_outcomes(parent_epoch)}


def conclusion_of(epoch, run=None, traces=None, outcomes=None, population_=None,
                  signals=None, delta=None, explain=None, analysis=None):
    """Build the conclusion, reusing any intermediate results already computed."""
    store = RT.store
    if run is None:
        run = store.get_run(epoch) or {}
    if traces is None:
        traces = store.list_traces(epoch)
    if outcomes is None:
        outcomes = store.list_outcomes(epoch)
    pop = population(traces, outcomes) if population_ is None else population_
    sigs = build_signals(traces, outcomes, pop) if signals is None else signals
    if delta is None and run.get("parent_id"):
        parent_epoch, parent_run = find_parent(store, epoch, run)
        if parent_epoch:
            parent_pop = population(store.list_traces(parent_epoch),
                                    store.list_outcomes(parent_epoch))
            delta, explain = compute_delta(run, pop, parent_run, parent_pop, parent_epoch)
    if analysis is None:
        analysis = store.get_latest_analysis(epoch)
    return build_conclusion(epoch, run, pop, sigs, outcomes, traces=traces,
                            delta=delta, explain=explain,
                            parent=_parent_context(store, epoch, run),
                            analysis=analysis)


def conclusion_payload(epoch, format_="json"):
    c = conclusion_of(epoch)
    if format_ == "md":
        return conclusion_markdown(c)
    return c
