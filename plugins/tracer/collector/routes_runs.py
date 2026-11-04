"""HTTP routes for run lifecycle, epoch administration and maintenance."""
from __future__ import annotations

import asyncio
import json
import time
from collections import deque

from fastapi import APIRouter, Query, Request, Response
from fastapi.responses import JSONResponse

from analysis_service import analyze_epoch_task
from ingest import _drop_local_epochs, spool_dir
from llm_analysis import pending
from runtime import RT, authorized, unauthorized

router = APIRouter()


@router.post("/v1/runs")
async def create_run(request: Request):
    if not authorized(request):
        return unauthorized()
    if RT.store is None:
        return JSONResponse({"error": "store disabled"}, status_code=503)
    body = await request.json()
    epoch = body.get("epoch")
    if not epoch:
        return JSONResponse({"error": "epoch required"}, status_code=400)
    RT.store.upsert_run(epoch, body.get("candidate_id"), body.get("parent_id"),
                        body.get("fingerprint"), body.get("config"))
    return {"ok": True, "epoch": epoch}


def _manual_cid(epoch):
    return "manual-" + (epoch if len(epoch) <= 16 else epoch[:8])


@router.post("/v1/runs/{epoch}/link")
async def link_run(epoch: str, request: Request):
    """Manually link a run to a parent epoch (empty parent unlinks).

    A missing candidate_id is generated so two manual runs still produce a delta.
    """
    if not authorized(request):
        return unauthorized()
    if RT.store is None:
        return JSONResponse({"error": "store disabled"}, status_code=503)
    body = await request.json()
    cur = RT.store.get_run(epoch)
    if not cur:
        return JSONResponse({"error": "unknown epoch: %s" % epoch}, status_code=404)
    parent_epoch = body.get("parent_epoch") if isinstance(body, dict) else None
    if not parent_epoch:
        RT.store.set_parent(epoch, None)
        return {"ok": True, "epoch": epoch, "candidate_id": cur.get("candidate_id"),
                "parent_id": None}
    if parent_epoch == epoch:
        return JSONResponse({"error": "不能把自身设为父轮次"}, status_code=400)
    par = RT.store.get_run(parent_epoch)
    if not par:
        return JSONResponse({"error": "unknown parent epoch: %s" % parent_epoch}, status_code=404)
    par_cid = par.get("candidate_id") or _manual_cid(parent_epoch)
    cur_cid = cur.get("candidate_id") or _manual_cid(epoch)
    RT.store.upsert_run(parent_epoch, par_cid)
    RT.store.upsert_run(epoch, cur_cid, par_cid)
    return {"ok": True, "epoch": epoch, "candidate_id": cur_cid,
            "parent_id": par_cid, "parent_epoch": parent_epoch}


@router.post("/v1/runs/{epoch}/finish")
async def finish_run(epoch: str, request: Request):
    if not authorized(request):
        return unauthorized()
    if RT.store is None:
        return JSONResponse({"error": "store disabled"}, status_code=503)
    # Clients send an empty JSON body; it must be consumed before responding.
    await request.body()
    run = RT.store.finish_run(epoch)
    # analysis_pending tells callers to keep polling /v1/feedback for LLM results.
    pending_analysis = pending(RT.store, epoch)
    asyncio.create_task(analyze_epoch_task(epoch))
    return {"ok": True, "epoch": epoch, "status": run.get("status"),
            "finished_at": run.get("finished_at"),
            "analysis_pending": pending_analysis}


@router.post("/v1/runs/{epoch}/artifacts")
async def put_artifacts(epoch: str, request: Request):
    """Record where the evaluator saved its deterministic artifacts."""
    if not authorized(request):
        return unauthorized()
    if RT.store is None:
        return JSONResponse({"error": "store disabled"}, status_code=503)
    try:
        body = await request.json()
    except Exception:
        return JSONResponse({"error": "invalid json"}, status_code=400)
    if not isinstance(body, dict):
        return JSONResponse({"error": "invalid json"}, status_code=400)
    if RT.store.get_run(epoch) is None:
        return JSONResponse({"error": "unknown epoch: %s" % epoch}, status_code=404)
    RT.store.set_artifacts(epoch, {k: str(v) for k, v in body.items()
                                   if isinstance(v, (str, int, float))})
    return {"ok": True, "epoch": epoch}


@router.get("/v1/epochs")
async def list_epochs(response: Response):
    response.headers["Cache-Control"] = "no-store"
    if RT.store is None:
        return JSONResponse({"error": "store disabled"}, status_code=503)
    return {"epochs": RT.store.list_epochs()}


@router.delete("/v1/epochs/{epoch}")
async def delete_epoch(epoch: str, request: Request):
    if not authorized(request):
        return unauthorized()
    if RT.store is None:
        return JSONResponse({"error": "store disabled"}, status_code=503)
    RT.store.delete_epoch(epoch)
    for sid in [k for k, v in list(RT.st.sessions.items()) if v.get("epoch") == epoch]:
        RT.st.sessions.pop(sid, None)
        RT.st.seen.pop(sid, None)
    return {"ok": True, "epoch": epoch}


@router.get("/v1/admin/dead-letter")
async def dead_letter(request: Request, limit: int = Query(50, ge=1, le=1000)):
    if not authorized(request):
        return unauthorized()
    path = spool_dir() / "dead-letter.ndjson"
    items = []
    if path.exists():
        with path.open(encoding="utf-8", errors="replace") as f:
            for ln in deque(f, maxlen=limit):
                try:
                    items.append(json.loads(ln))
                except Exception:
                    items.append({"line": ln.rstrip("\n")})
    return {"count": len(items), "limit": limit, "items": items}


@router.post("/v1/admin/retention")
async def run_retention(request: Request, days: float = Query(None, ge=0)):
    if not authorized(request):
        return unauthorized()
    if RT.store is None:
        return JSONResponse({"error": "store disabled"}, status_code=503)
    window = RT.cfg.retention_days if days is None else days
    if not window or window <= 0:
        return JSONResponse({"error": "retention disabled; pass ?days=N"}, status_code=400)
    cutoff = time.time() - window * 86400
    purged = await asyncio.to_thread(RT.store.purge_older_than, cutoff)
    RT.st.metrics["retention_purged_epochs"] += len(purged)
    _drop_local_epochs(purged)
    return {"ok": True, "retention_days": window, "purged": purged}


@router.delete("/v1/admin/db")
async def purge_db(request: Request, confirm: str = Query("")):
    if not authorized(request):
        return unauthorized()
    if RT.store is None:
        return JSONResponse({"error": "store disabled"}, status_code=503)
    if confirm != "yes":
        return JSONResponse({"error": "pass ?confirm=yes"}, status_code=400)
    RT.store.purge()
    RT.st.sessions.clear()
    RT.st.seen.clear()
    return {"ok": True}
