"""Process-wide runtime state shared by every collector module."""
from __future__ import annotations

import asyncio
from collections import deque

from fastapi import Request
from fastapi.responses import JSONResponse


class Cfg:
    def __init__(self, a):
        self.host = a.host
        self.port = a.port
        self.view = a.view
        self.token = a.token
        self.max_queue = a.max_queue
        self.max_body = a.max_body_mb * 1024 * 1024
        self.workers = a.workers
        self.sample_rate = a.sample_rate
        self.max_batches = a.max_batches
        self.max_seen = a.max_seen
        self.sub_queue = a.sub_queue
        self.db = a.db
        self.spool = a.spool
        self.shutdown_timeout = a.shutdown_timeout
        self.replay_max = a.replay_max
        self.retention_days = a.retention_days
        self.retention_interval = a.retention_interval


class State:
    def __init__(self, cfg):
        self.cfg = cfg
        self.queue = asyncio.Queue(maxsize=cfg.max_queue)
        self.sessions = {}
        self.seen = {}
        self.subscribers = set()
        self.queued = set()
        self.stopping = False
        self.metrics = {"received_lines": 0, "accepted": 0, "deduped": 0,
                        "sampled_drop": 0, "rejected_429": 0, "bad_lines": 0,
                        "broadcasts": 0, "unknown_kind_lines": 0,
                        "unknown_format_lines": 0, "processing_errors": 0,
                        "dead_letter_lines": 0, "db_errors": 0,
                        "events_accepted": 0, "unknown_event_lines": 0,
                        "outcomes_accepted": 0,
                        "sse_dropped": 0, "retention_purged_epochs": 0}


class Runtime:
    """Mutable container so modules can share cfg/st/store without rebinding imports."""

    def __init__(self):
        self.cfg = None
        self.st = None
        self.store = None

    def start(self, cfg, state, store):
        self.cfg = cfg
        self.st = state
        self.store = store


RT = Runtime()


def authorized(request: Request):
    return not RT.cfg.token or request.headers.get("authorization") == "Bearer " + RT.cfg.token


def unauthorized():
    return JSONResponse({"error": "unauthorized"}, status_code=401,
                        headers={"WWW-Authenticate": "Bearer"})


def new_batches():
    return deque(maxlen=RT.cfg.max_batches)
