"""Spool buffering and ingestion of traces, events and task outcomes."""
from __future__ import annotations

import asyncio
import json
import os
import random
import time
import uuid
from collections import deque
from pathlib import Path

from evaluator_events import outcome_from_result, steps_from_events
from runtime import RT, new_batches

KNOWN_KINDS = {"trajectory", "outcome", "summary"}
# External producers may label a summary differently (AgentX writes kind=agentx).
KIND_ALIASES = {"agentx": "summary"}
KNOWN_FORMAT_PREFIXES = ("atif", "agentx")

EVENT_TYPES = {"start", "message_start", "message", "tool_start", "tool_result",
               "agent_end", "usage", "end", "error"}
EVENT_TERMINAL_TYPES = ("end", "error")
# A rebuilt attempt is stored as a single row, so a fixed seq lets rebuilds overwrite it.
EVENT_STEP_SEQ = 0
# Rebuild while a run is still streaming at most once per interval; terminal
# events bypass the throttle so the final state always lands in the database.
MATERIALIZE_INTERVAL_S = 1.0
# Values below are "not finished yet" for the purpose of background analysis.
_RUNNING_STATUSES = ("running", "started", "in_progress", "pending")

_LAST_MATERIALIZE = {}
_PENDING_MATERIALIZE = {}


def _infer_session(obj):
    if not isinstance(obj, dict):
        return None
    k = obj.get("key") or {}
    for n in ("session_id", "sessionId", "trajectory_id", "trajectoryId"):
        if obj.get(n):
            return obj[n]
    for n in ("session_id", "attemptId", "taskId", "runId"):
        if isinstance(k, dict) and k.get(n):
            return k[n]
    return None


def spool_dir():
    p = Path(RT.cfg.spool)
    p.mkdir(parents=True, exist_ok=True)
    return p


def spool_write(session, lines):
    d = spool_dir()
    name = "%d-%s.ndjson" % (time.time_ns(), uuid.uuid4().hex)
    tmp = d / (name + ".tmp")
    with open(tmp, "w", encoding="utf-8", newline="\n") as f:
        f.write(json.dumps({"__spool_header__": True, "session": session},
                           ensure_ascii=False) + "\n")
        for ln in lines:
            f.write(ln.rstrip("\n") + "\n")
        f.flush()
        os.fsync(f.fileno())
    final = d / name
    os.replace(tmp, final)
    return final


def spool_read(path):
    with open(path, encoding="utf-8") as f:
        first = f.readline()
        head = None
        try:
            obj = json.loads(first)
            if isinstance(obj, dict) and obj.get("__spool_header__"):
                head = obj
        except Exception:
            pass
        if head is not None:
            docs = [ln.rstrip("\n") for ln in f if ln.strip()]
            return head.get("session"), docs
        docs = [first.rstrip("\n")] if first.strip() else []
        docs.extend(ln.rstrip("\n") for ln in f if ln.strip())
        return None, docs


def dead_letter(line, reason):
    try:
        with (spool_dir() / "dead-letter.ndjson").open("a", encoding="utf-8") as f:
            f.write(json.dumps({"at": time.time(), "reason": reason, "line": line},
                               ensure_ascii=False) + "\n")
        RT.st.metrics["dead_letter_lines"] += 1
    except Exception:
        pass


def _format_ok(fmt):
    return str(fmt).lower().startswith(KNOWN_FORMAT_PREFIXES)


def enqueue(path):
    if path in RT.st.queued:
        return False
    try:
        RT.st.queue.put_nowait(path)
    except asyncio.QueueFull:
        return False
    RT.st.queued.add(path)
    return True


def _guess_kind(obj):
    if not isinstance(obj, dict):
        return "unknown"
    if obj.get("kind") == "outcome" or ("success" in obj and ("task_id" in obj or "taskId" in obj)):
        return "outcome"
    sv = str(obj.get("schema_version") or obj.get("schemaVersion") or "")
    if sv.startswith("ATIF") or obj.get("steps") or obj.get("subagent_trajectories"):
        return "trajectory"
    if obj.get("kind") == "agentx" or obj.get("profiling") or obj.get("profiling_metrics") \
            or obj.get("telemetry") or obj.get("metrics_phase"):
        return "summary"
    return "unknown"


def _trajectory_stats(data):
    if not isinstance(data, dict):
        return None
    steps = data.get("steps")
    if not isinstance(steps, list):
        return None
    errors = 0
    tokens = 0
    starts, ends = [], []
    for step in steps:
        if not isinstance(step, dict):
            continue
        inv = (step.get("extra") or {}).get("invocation") or {}
        status = str(inv.get("status") or step.get("status") or "").lower()
        if status in ("error", "failed", "failure", "timeout"):
            errors += 1
        m = step.get("metrics") or {}
        for k in ("prompt_tokens", "completion_tokens"):
            v = m.get(k)
            if isinstance(v, (int, float)):
                tokens += int(v)
        st, en = inv.get("start_timestamp"), inv.get("end_timestamp")
        if isinstance(st, (int, float)):
            starts.append(float(st))
        if isinstance(en, (int, float)):
            ends.append(float(en))
    duration_ms = None
    if starts and ends:
        duration_ms = max(0.0, (max(ends) - min(starts)) * 1000.0)
    return {"steps": len(steps), "errors": errors, "tokens": tokens,
            "duration_ms": round(duration_ms, 3) if duration_ms is not None else None}


def _store(sess, kind, seq, data, ctx=None, event_id=None):
    try:
        _persist(sess, kind, seq, data, ctx, event_id)
    except Exception:
        RT.st.metrics["db_errors"] += 1
        raise


def _persist(sess, kind, seq, data, ctx=None, event_id=None):
    ctx = ctx or {}
    if kind == "outcome":
        if RT.store is not None:
            ep = ctx.get("epoch") or ("adhoc:" + (sess or "default"))
            if ctx.get("candidate_id") or ctx.get("parent_id"):
                RT.store.upsert_run(ep, ctx.get("candidate_id"), ctx.get("parent_id"))
            RT.store.add_outcome(ep, data)
        return
    ep = ctx.get("epoch") or "adhoc"
    if RT.store is not None and (ctx.get("candidate_id") or ctx.get("parent_id")):
        RT.store.upsert_run(ep, ctx.get("candidate_id"), ctx.get("parent_id"))
    stats = _trajectory_stats(data) if kind == "trajectory" else None
    s = RT.st.sessions.get(sess)
    if not s:
        s = {"id": sess, "kind": kind or "unknown", "count": 0,
             "firstAt": time.time(), "updatedAt": time.time(), "epoch": ep,
             "stats": None, "batches": new_batches()}
        RT.st.sessions[sess] = s
    if kind and kind != "unknown" and (s["kind"] == "unknown" or kind == "trajectory"):
        s["kind"] = kind
    s["count"] += 1
    s["updatedAt"] = time.time()
    s["epoch"] = ep
    if stats is not None:
        s["stats"] = stats
    s["batches"].append({"seq": seq, "kind": kind, "data": data, "at": time.time()})
    if RT.store is not None:
        inserted = RT.store.add_trace(ep, sess, seq, kind, data, event_id)
        if inserted:
            RT.store.touch_session(ep, sess, kind, stats)


async def broadcast(evt):
    for q in list(RT.st.subscribers):
        try:
            q.put_nowait(evt)
        except asyncio.QueueFull:
            RT.st.metrics["sse_dropped"] += 1
    RT.st.metrics["broadcasts"] += 1


def _is_event_row(obj):
    """True for a single line of an Evaluator trajectory.jsonl."""
    if not isinstance(obj, dict):
        return False
    key = obj.get("key")
    return (isinstance(key, dict) and isinstance(obj.get("type"), str)
            and bool(key.get("runId") or key.get("attemptId")))


def _is_result_row(obj):
    """True for an Evaluator result.json document."""
    if not isinstance(obj, dict):
        return False
    key = obj.get("key")
    return (isinstance(key, dict) and bool(key.get("taskId"))
            and ("executionStatus" in obj or "verdict" in obj))


def _handle_result(obj):
    """Store result.json as an outcome keyed by runId."""
    if RT.store is None:
        return None
    out = outcome_from_result(obj)
    if not out.get("task_id"):
        RT.st.metrics["bad_lines"] += 1
        dead_letter(json.dumps(obj, ensure_ascii=False), "outcome without task_id")
        return None
    ep = str(obj.get("epoch") or out.get("run_id") or "adhoc")
    RT.store.add_outcome(ep, out)
    RT.st.metrics["outcomes_accepted"] += 1
    # A result forces one rebuild so traces missing an end event get their final shape.
    attempt = str(out.get("attempt_id") or "")
    if not attempt:
        return None
    _cancel_materialize(ep, attempt)
    _LAST_MATERIALIZE[(ep, attempt)] = time.monotonic()
    payload = materialize_attempt(ep, attempt)
    return {"session": attempt, "kind": "trajectory", "seq": EVENT_STEP_SEQ,
            "epoch": ep, "at": time.time(),
            "text": json.dumps(payload, ensure_ascii=False)}


def materialize_attempt(ep, attempt):
    """Rebuild stored events into an ATIF-style trajectory row."""
    payload = steps_from_events(RT.store.list_events(ep, attempt))
    stats = _trajectory_stats(payload)
    created = RT.store.put_trace(ep, attempt, EVENT_STEP_SEQ, "trajectory", payload)
    RT.store.touch_session(ep, attempt, "trajectory", stats, bump=created)
    return payload


def _allow_materialize(ep, attempt):
    now = time.monotonic()
    last = _LAST_MATERIALIZE.get((ep, attempt))
    return last is None or now - last >= MATERIALIZE_INTERVAL_S


def _schedule_materialize(ep, attempt):
    """Rebuild once the throttle window ends, so the last event of a burst is not lost."""
    key = (ep, attempt)
    if key in _PENDING_MATERIALIZE:
        return
    delay = MATERIALIZE_INTERVAL_S - (time.monotonic() - _LAST_MATERIALIZE.get(key, 0.0))

    async def run():
        try:
            await asyncio.sleep(max(0.0, delay))
            _LAST_MATERIALIZE[key] = time.monotonic()
            payload = materialize_attempt(ep, attempt)
            await broadcast({"session": attempt, "kind": "trajectory", "seq": EVENT_STEP_SEQ,
                             "epoch": ep, "at": time.time(),
                             "text": json.dumps(payload, ensure_ascii=False)})
        except asyncio.CancelledError:
            raise
        except Exception:
            RT.st.metrics["processing_errors"] += 1
        finally:
            _PENDING_MATERIALIZE.pop(key, None)

    try:
        _PENDING_MATERIALIZE[key] = asyncio.create_task(run())
    except RuntimeError:  # no event loop (sync callers in tests): rebuild per event
        _PENDING_MATERIALIZE.pop(key, None)


def _cancel_materialize(ep, attempt):
    pending = _PENDING_MATERIALIZE.pop((ep, attempt), None)
    if pending is not None:
        pending.cancel()


def _handle_event(obj):
    """Persist one trajectory event and rebuild the attempt when allowed."""
    etype = obj["type"]
    if etype not in EVENT_TYPES:
        RT.st.metrics["unknown_event_lines"] += 1
        dead_letter(json.dumps(obj, ensure_ascii=False), "unknown event type %r" % etype)
        return None
    key = obj.get("key") or {}
    # One epoch per run, one trajectory per attempt.
    ep = str(obj.get("epoch") or key.get("runId") or "adhoc")
    attempt = str(key.get("attemptId") or _infer_session(obj) or "default")
    if not RT.store.add_event(ep, attempt, obj.get("seq"), etype, obj.get("at"), obj):
        RT.st.metrics["deduped"] += 1
        return None
    RT.st.metrics["events_accepted"] += 1
    if etype not in EVENT_TERMINAL_TYPES and not _allow_materialize(ep, attempt):
        _schedule_materialize(ep, attempt)
        return None
    _cancel_materialize(ep, attempt)
    _LAST_MATERIALIZE[(ep, attempt)] = time.monotonic()
    payload = materialize_attempt(ep, attempt)
    return {"session": attempt, "kind": "trajectory", "seq": EVENT_STEP_SEQ,
            "epoch": ep, "at": time.time(),
            "text": json.dumps(payload, ensure_ascii=False)}


async def handle_doc(session_hint, obj):
    explicit_kind = obj.get("kind") if isinstance(obj, dict) else None
    if isinstance(explicit_kind, str):
        explicit_kind = KIND_ALIASES.get(explicit_kind, explicit_kind)
    fmt = obj.get("format") if isinstance(obj, dict) else None
    if explicit_kind and explicit_kind not in KNOWN_KINDS:
        RT.st.metrics["unknown_kind_lines"] += 1
        dead_letter(json.dumps(obj, ensure_ascii=False), "unknown kind %r" % explicit_kind)
        return None
    if fmt and not _format_ok(fmt):
        RT.st.metrics["unknown_format_lines"] += 1
        dead_letter(json.dumps(obj, ensure_ascii=False), "unknown format %r" % fmt)
        return None
    if _is_result_row(obj):
        return _handle_result(obj)
    if _is_event_row(obj):
        return _handle_event(obj)
    ctx = {}
    event_id = None
    if isinstance(obj, dict) and "data" in obj and ("session" in obj or "seq" in obj):
        sess = session_hint or obj.get("session") or "default"
        seq = obj.get("seq")
        data = obj["data"]
        event_id = obj.get("event_id")
        ctx = {k: obj.get(k) for k in ("epoch", "candidate_id", "parent_id", "task_id")}
        kind = explicit_kind or _guess_kind(data)
    else:
        sess = session_hint or _infer_session(obj) or "default"
        seq = None
        data = obj
        if isinstance(obj, dict):
            event_id = obj.get("event_id")
            ctx = {k: obj.get(k) for k in ("epoch", "candidate_id", "parent_id", "task_id")}
        kind = explicit_kind or _guess_kind(obj)
    dedupe = ("e:" + str(event_id)) if event_id else (("s:" + str(seq)) if seq is not None else None)
    if dedupe is not None:
        seen = RT.st.seen.setdefault(sess, set())
        if dedupe in seen:
            RT.st.metrics["deduped"] += 1
            return None
        seen.add(dedupe)
        if len(seen) > RT.cfg.max_seen:
            seen.pop()
    if kind == "trajectory" and RT.cfg.sample_rate < 1.0 and random.random() > RT.cfg.sample_rate:
        RT.st.metrics["sampled_drop"] += 1
        return None
    _store(sess, kind, seq, data, ctx, event_id)
    RT.st.metrics["accepted"] += 1
    if kind == "outcome":
        return None
    return {"session": sess, "kind": kind, "seq": seq, "epoch": ctx.get("epoch"),
            "at": time.time(), "text": json.dumps(data, ensure_ascii=False)}


async def consumer(_):
    while True:
        path = await RT.st.queue.get()
        done = False
        try:
            session_hint, lines = spool_read(path)
            for ln in lines:
                try:
                    obj = json.loads(ln)
                except Exception:
                    RT.st.metrics["bad_lines"] += 1
                    dead_letter(ln, "bad json")
                    continue
                try:
                    evt = await handle_doc(session_hint, obj)
                except Exception:
                    RT.st.metrics["processing_errors"] += 1
                    dead_letter(ln, "processing error")
                    continue
                if evt is not None:
                    await broadcast(evt)
            done = True
        except Exception:
            RT.st.metrics["processing_errors"] += 1
            try:
                path.replace(path.with_name(path.name + ".failed"))
                done = True
            except OSError:
                done = False
        finally:
            RT.st.queued.discard(path)
            if done:
                try:
                    path.unlink()
                except OSError:
                    pass
            RT.st.queue.task_done()


async def spool_sweeper(_):
    while not RT.st.stopping:
        await asyncio.sleep(2.0)
        if RT.st.stopping:
            return
        try:
            d = spool_dir()
        except Exception:
            continue
        if RT.st.queue.qsize() >= max(1, RT.cfg.max_queue // 2):
            continue
        for path in sorted(d.glob("*.ndjson")):
            if path.name == "dead-letter.ndjson":
                continue
            if not enqueue(path):
                break


def _drop_local_epochs(epochs):
    for ep in epochs:
        for sid in [k for k, v in list(RT.st.sessions.items()) if v.get("epoch") == ep]:
            RT.st.sessions.pop(sid, None)
            RT.st.seen.pop(sid, None)


def purge_retention():
    """Drop epochs whose last activity is older than the retention window."""
    if RT.store is None or not RT.cfg.retention_days or RT.cfg.retention_days <= 0:
        return []
    cutoff = time.time() - RT.cfg.retention_days * 86400
    purged = RT.store.purge_older_than(cutoff)
    RT.st.metrics["retention_purged_epochs"] += len(purged)
    _drop_local_epochs(purged)
    return purged


async def retention_sweeper(_):
    while not RT.st.stopping:
        await asyncio.sleep(RT.cfg.retention_interval)
        if RT.st.stopping:
            return
        try:
            await asyncio.to_thread(purge_retention)
        except Exception:
            pass
