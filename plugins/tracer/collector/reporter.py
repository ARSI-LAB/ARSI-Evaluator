from __future__ import annotations
import gzip
import json
import random
import threading
import time
import urllib.request
import uuid
from collections import deque

class TraceReporter:
    def __init__(self, endpoint, token=None, session=None, batch_size=64,
                 flush_interval=1.0, max_buffer=20000, compress=True,
                 timeout=5.0, max_retries=3, sample_rate=1.0):
        self.endpoint = endpoint.rstrip("/")
        self.token = token
        self.session = session
        self.batch_size = max(1, int(batch_size))
        self.flush_interval = float(flush_interval)
        self.max_buffer = max(1, int(max_buffer))
        self.compress = compress
        self.timeout = float(timeout)
        self.max_retries = int(max_retries)
        self.sample_rate = float(sample_rate)

        self._buf = deque()
        self._lock = threading.Lock()
        self._cv = threading.Condition(self._lock)
        self._stop = threading.Event()
        self._seq = 0

        self.sent = 0
        self.dropped = 0
        self.failed = 0
        self.sampled_out = 0

        self._t = threading.Thread(target=self._worker, name="trace-reporter", daemon=True)
        self._t.start()

    def report(self, trajectory, session=None, kind=None, seq=None, context=None, force=False):
        if not force and self.sample_rate < 1.0 and random.random() > self.sample_rate:
            self.sampled_out += 1
            return False
        self._seq += 1
        line = {"session": session or self.session or "default",
                "kind": kind, "seq": seq if seq is not None else self._seq,
                "event_id": uuid.uuid4().hex,
                "at": time.time(), "data": trajectory}
        for k in ("epoch", "candidate_id", "parent_id", "task_id"):
            if context and context.get(k) is not None:
                line[k] = context[k]
        item = json.dumps(line, ensure_ascii=False, separators=(",", ":"))
        with self._cv:
            if len(self._buf) >= self.max_buffer:
                self._buf.popleft()
                self.dropped += 1
            self._buf.append(item)
            self._cv.notify()
        return True

    def report_outcome(self, task_id, success, reward=None, latency_ms=None,
                       cost_usd=None, session=None, epoch=None, seq=None):
        return self.report({"task_id": task_id, "success": bool(success), "reward": reward,
                            "latency_ms": latency_ms, "cost_usd": cost_usd},
                           session=session, kind="outcome", seq=seq,
                           context={"epoch": epoch}, force=True)

    def close(self, timeout=5.0):
        self._stop.set()
        with self._cv:
            self._cv.notify_all()
        self._t.join(timeout=timeout)

    def stats(self):
        with self._lock:
            return {"buffered": len(self._buf), "sent": self.sent,
                    "dropped": self.dropped, "failed": self.failed,
                    "sampled_out": self.sampled_out}

    def _drain(self, limit):
        with self._lock:
            out = []
            while self._buf and len(out) < limit:
                out.append(self._buf.popleft())
            return out

    def _worker(self):
        while not self._stop.is_set():
            with self._cv:
                if not self._buf:
                    self._cv.wait(timeout=self.flush_interval)
            if self._stop.is_set():
                return
            while not self._stop.is_set():
                batch = self._drain(self.batch_size)
                if not batch:
                    break
                if self._send(batch):
                    self.sent += len(batch)
                else:
                    self.failed += len(batch)

    def _send(self, batch):
        body = ("\n".join(batch) + "\n").encode("utf-8")
        headers = {"Content-Type": "application/x-ndjson"}
        if self.compress:
            body = gzip.compress(body)
            headers["Content-Encoding"] = "gzip"
        if self.token:
            headers["Authorization"] = "Bearer " + self.token
        delay = 0.5
        for attempt in range(self.max_retries + 1):
            try:
                req = urllib.request.Request(self.endpoint + "/v1/ingest", data=body,
                                             headers=headers, method="POST")
                with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                    return 200 <= resp.status < 300
            except Exception:
                if attempt >= self.max_retries:
                    return False
                time.sleep(delay)
                delay = min(delay * 2, 5.0)
        return False