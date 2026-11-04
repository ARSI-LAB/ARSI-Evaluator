"""HTTP routes for feedback, conclusions, signals and LLM analysis."""
from __future__ import annotations

import asyncio
import time

from fastapi import APIRouter, Query, Request, Response
from fastapi.responses import JSONResponse, PlainTextResponse

import llm_analysis as LLM
from aggregate import build_feedback, population
from analysis_service import (analyzing, artifacts_of, clear_failed, conclusion_of,
                              conclusion_payload, export_analysis, failed, mark_analyzing,
                              mark_failed, release, reanalyze, run_analysis_dir,
                              signals_markdown, signals_payload)
from ingest import _RUNNING_STATUSES
from llm_analysis import analyze_epoch, analyze_trajectory
from runtime import RT, authorized, unauthorized
from signals import analyze_digest, build_signals, signals_to_findings

router = APIRouter()


@router.get("/v1/outcomes")
async def get_outcomes(response: Response, epoch: str = Query(...)):
    response.headers["Cache-Control"] = "no-store"
    if RT.store is None:
        return JSONResponse({"error": "store disabled"}, status_code=503)
    return {"epoch": epoch, "outcomes": [
        {"task_id": o.get("task_id"), "success": o.get("success"), "reward": o.get("reward")}
        for o in RT.store.list_outcomes(epoch)]}


@router.get("/v1/feedback")
async def get_feedback(response: Response, epoch: str = Query(None), target: str = Query(None)):
    response.headers["Cache-Control"] = "no-store"
    if RT.store is None:
        return JSONResponse({"error": "store disabled"}, status_code=503)
    ep = epoch or RT.store.latest_epoch()
    if not ep:
        return JSONResponse({"error": "no epoch"}, status_code=404)
    run = RT.store.get_run(ep) or {}
    traces = RT.store.list_traces(ep)
    outcomes = RT.store.list_outcomes(ep)
    fb = build_feedback(ep, run, traces, outcomes, RT.store)
    # target filtering only affects the panel; the verdict uses all signals.
    all_signals = fb["signals"]
    if target:
        fb["signals"] = [s for s in fb["signals"] if s.get("target") == target]
    analysis = RT.store.get_latest_analysis(ep)
    stale = analysis is None
    if not stale and LLM.config() is not None:
        facts, _ = LLM.build_facts(traces, outcomes)
        stale = analysis.get("digest_hash") != LLM.digest_hash(facts)
    # Only finished epochs are analyzed automatically: running ones still change,
    # and imported snapshots may report "unknown" rather than "finished".
    if stale and (run.get("status") or "").lower() not in _RUNNING_STATUSES \
            and LLM.config() is not None \
            and not analyzing(ep) and not failed(ep):
        mark_analyzing(ep)
        asyncio.create_task(reanalyze(ep))
    if analysis is None:
        analysis = {"source": "rules", "model": None,
                    "digest_hash": None, "findings": signals_to_findings(fb["signals"])}
        if LLM.STATS.get("last_error"):
            analysis["llm_error"] = LLM.STATS["last_error"]
    fb["analysis"] = analysis
    fb["artifacts"] = artifacts_of(run)
    fb["conclusion"] = conclusion_of(ep, run=run, traces=traces, outcomes=outcomes,
                                     population_=fb.get("population"),
                                     signals=all_signals,
                                     delta=fb.get("delta_vs_parent"),
                                     explain=fb.get("explain"), analysis=analysis)
    fb["llm"] = {"calls": LLM.STATS["calls"], "cache_hits": LLM.STATS["cache_hits"],
                 "failures": LLM.STATS["failures"], "configured": LLM.config() is not None}
    RT.store.save_feedback(ep, fb)
    return fb


@router.get("/v1/conclusion")
async def get_conclusion(response: Response, epoch: str = Query(None),
                         format: str = Query("json")):
    """Deterministic verdict plus evidence, attribution and next actions."""
    response.headers["Cache-Control"] = "no-store"
    if RT.store is None:
        return JSONResponse({"error": "store disabled"}, status_code=503)
    ep = epoch or RT.store.latest_epoch()
    if not ep:
        return JSONResponse({"error": "no epoch"}, status_code=404)
    # Never return an empty conclusion for an explicitly unknown epoch.
    if RT.store.get_run(ep) is None and not RT.store.count_traces(ep) \
            and not RT.store.list_outcomes(ep):
        return JSONResponse({"error": "unknown epoch: %s" % ep}, status_code=404)
    payload = conclusion_payload(ep, format)
    if format == "md":
        return PlainTextResponse(payload, media_type="text/markdown; charset=utf-8")
    return payload


@router.get("/v1/signals")
async def get_signals(response: Response, epoch: str = Query(None), format: str = Query("json")):
    """Rule signals: json for downstream/RSI, md for humans."""
    response.headers["Cache-Control"] = "no-store"
    if RT.store is None:
        return JSONResponse({"error": "store disabled"}, status_code=503)
    ep = epoch or RT.store.latest_epoch()
    if not ep:
        return JSONResponse({"error": "no epoch"}, status_code=404)
    payload = signals_payload(ep)
    if format == "md":
        return PlainTextResponse(signals_markdown(payload),
                                 media_type="text/markdown; charset=utf-8")
    return payload


@router.get("/v1/export-files")
async def export_epoch_files(epoch: str = Query(None), all: int = Query(0)):
    """Write deterministic results to each run directory; never triggers an LLM call."""
    if RT.store is None:
        return JSONResponse({"error": "store disabled"}, status_code=503)
    if epoch:
        epochs = [epoch]
    elif all:
        epochs = [row["epoch"] for row in RT.store.list_epochs()]
    else:
        return JSONResponse({"error": "需要 epoch 或 all=1"}, status_code=400)
    done, no_dir = [], []
    for ep in epochs:
        if run_analysis_dir(ep) is None:
            no_dir.append(ep)
            continue
        export_analysis(ep)
        done.append(ep)
    return {"exported": len(done), "not_found": len(no_dir), "epochs": done, "no_dir": no_dir}


@router.post("/v1/feedback/rerun")
async def rerun_feedback(request: Request, epoch: str = Query(None)):
    """Force a fresh LLM analysis, bypassing the cache and the failure blacklist."""
    if not authorized(request):
        return unauthorized()
    if RT.store is None:
        return JSONResponse({"error": "store disabled"}, status_code=503)
    await request.body()
    ep = epoch or RT.store.latest_epoch()
    if not ep:
        return JSONResponse({"error": "no epoch"}, status_code=404)
    if LLM.config() is None:
        return JSONResponse({"error": "未配置 LLM provider"}, status_code=400)
    run = RT.store.get_run(ep) or {}
    # Imported snapshots may report "unknown"; only skip genuinely running epochs.
    if (run.get("status") or "").lower() in _RUNNING_STATUSES:
        return JSONResponse({"error": "epoch 尚未结束，无法分析"}, status_code=400)
    if analyzing(ep):
        return JSONResponse({"error": "该 epoch 正在分析中"}, status_code=409)
    mark_analyzing(ep)
    clear_failed(ep)
    try:
        result = await asyncio.to_thread(analyze_epoch, RT.store, ep, True)
    except Exception as exc:
        RT.st.metrics["processing_errors"] += 1
        mark_failed(ep)
        return JSONResponse({"error": repr(exc)}, status_code=500)
    finally:
        release(ep)
    if result is None:
        return JSONResponse({"error": "没有可分析的轨迹"}, status_code=400)
    if result.get("error"):
        # Failed runs are blacklisted too, so refreshes do not retry and re-bill.
        mark_failed(ep)
        return JSONResponse({"error": result["error"]}, status_code=502)
    export_analysis(ep)
    return {"ok": True, "epoch": ep, "source": result.get("source"),
            "model": result.get("model")}


@router.post("/v1/analyze")
async def analyze(request: Request):
    try:
        body = await request.json()
    except Exception:
        return JSONResponse({"error": "invalid json"}, status_code=400)
    if not isinstance(body, dict):
        return JSONResponse({"error": "object required"}, status_code=400)
    digest = body.get("digest")
    if digest is None and "steps" in body:
        digest = body
    if digest is not None:
        # Panel analysis targets one trajectory: LLM first (cached by digest),
        # falling back to rule-based analysis.
        if RT.store is not None:
            try:
                result = analyze_trajectory(RT.store, digest, body.get("epoch"))
            except Exception:
                result = None
            if result and result.get("source") == "llm":
                return result
            fallback = analyze_digest(digest)
            if result and result.get("error"):
                fallback["llm_error"] = result["error"]
            return fallback
        return analyze_digest(digest)
    ep = body.get("epoch")
    if not ep:
        return JSONResponse({"error": "epoch or digest required"}, status_code=400)
    if RT.store is None:
        return JSONResponse({"error": "store disabled"}, status_code=503)
    stored = RT.store.get_latest_analysis(ep)
    if stored:
        return {"epoch": ep, "summary": stored.get("summary") or "", "scores": None,
                "source": stored.get("source"), "model": stored.get("model"),
                "findings": stored.get("findings") or []}
    traces = RT.store.list_traces(ep)
    outcomes = RT.store.list_outcomes(ep)
    sigs = build_signals(traces, outcomes, population(traces, outcomes))
    result = {"epoch": ep, "summary": "规则分析（未调用 LLM）", "scores": None,
              "source": "rules", "findings": signals_to_findings(sigs)}
    if LLM.STATS.get("last_error"):
        result["llm_error"] = LLM.STATS["last_error"]
    return result
