"""Trace Collector entry point: app assembly, lifecycle and CLI."""
from __future__ import annotations

import argparse
import asyncio
from contextlib import asynccontextmanager
from pathlib import Path

import uvicorn
from fastapi import FastAPI, Query, Response

from ingest import consumer, purge_retention, retention_sweeper, spool_dir, spool_sweeper
from runtime import Cfg, RT, State
from trace_store import Store

import routes_ingest
import routes_query
import routes_runs
import views


@asynccontextmanager
async def lifespan(_app):
    RT.start(RT.cfg, State(RT.cfg), Store(RT.cfg.db) if RT.cfg.db else None)
    spool_dir()
    sweeper = asyncio.create_task(spool_sweeper("spool"))
    retention = None
    if RT.cfg.retention_days and RT.cfg.retention_days > 0:
        await asyncio.to_thread(purge_retention)
        retention = asyncio.create_task(retention_sweeper("retention"))
    tasks = [asyncio.create_task(consumer(i)) for i in range(RT.cfg.workers)]
    yield
    RT.st.stopping = True
    sweeper.cancel()
    await asyncio.gather(sweeper, return_exceptions=True)
    if retention is not None:
        retention.cancel()
        await asyncio.gather(retention, return_exceptions=True)
    try:
        await asyncio.wait_for(RT.st.queue.join(), timeout=RT.cfg.shutdown_timeout)
    except asyncio.TimeoutError:
        pass
    for t in tasks:
        t.cancel()
    await asyncio.gather(*tasks, return_exceptions=True)
    if RT.store is not None:
        RT.store.close()


app = FastAPI(lifespan=lifespan)
app.include_router(routes_ingest.router)
app.include_router(routes_runs.router)
app.include_router(routes_query.router)


@app.get("/")
async def index():
    return await views.index()


@app.get("/v1/export")
async def export_snapshot(response: Response, epoch: str = Query(...), traces: int = Query(1)):
    return await views.export_snapshot(response, epoch, traces)


def main():
    ap = argparse.ArgumentParser(description="Trace Collector (Tier 1)")
    ap.add_argument("--host", default="0.0.0.0")
    ap.add_argument("--port", type=int, default=8787)
    ap.add_argument("--view", default=str(Path(__file__).resolve().parent / "view" / "index.html"))
    ap.add_argument("--token", default="")
    ap.add_argument("--max-queue", type=int, default=2000)
    ap.add_argument("--max-body-mb", type=int, default=64)
    ap.add_argument("--workers", type=int, default=2)
    ap.add_argument("--sample-rate", type=float, default=1.0)
    ap.add_argument("--max-batches", type=int, default=500)
    ap.add_argument("--max-seen", type=int, default=100000)
    ap.add_argument("--sub-queue", type=int, default=2000)
    ap.add_argument("--db", default=str(Path(__file__).resolve().parent / "trace.db"))
    ap.add_argument("--spool", default=str(Path(__file__).resolve().parent / "spool"))
    ap.add_argument("--shutdown-timeout", type=float, default=5.0)
    ap.add_argument("--replay-max", type=int, default=2000)
    ap.add_argument("--retention-days", type=float, default=0,
                    help="drop epochs idle for longer than N days; 0 disables")
    ap.add_argument("--retention-interval", type=float, default=3600,
                    help="seconds between retention sweeps")
    RT.cfg = Cfg(ap.parse_args())
    uvicorn.run(app, host=RT.cfg.host, port=RT.cfg.port, log_level="info")


if __name__ == "__main__":
    main()
