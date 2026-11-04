"""Adapt Evaluator trajectory events and result.json into the Collector's step/outcome model."""
from __future__ import annotations

from datetime import datetime

TEXT_LIMIT = 2000
OBSERVATION_LIMIT = 4000

LLM_FUNCTION = "llm.call"
AGENT_FUNCTION = "agent.run"


def _sec(at):
    """ISO8601 -> epoch seconds (float); returns None if parsing fails."""
    if not isinstance(at, str) or not at:
        return None
    try:
        return datetime.fromisoformat(at.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def _clip(text, limit):
    if not isinstance(text, str):
        return ""
    if limit and len(text) > limit:
        return text[:limit] + "…(truncated)"
    return text


def _num(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return value


def _text_of(content):
    """Extract plain text from pi's content array, ignoring blocks such as thinking."""
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    parts = []
    for item in content:
        if isinstance(item, dict) and item.get("type") == "text":
            text = item.get("text")
            if isinstance(text, str):
                parts.append(text)
    return "\n".join(parts)


def _tool_calls_of(content):
    """Extract toolCall blocks from an assistant message's content."""
    if not isinstance(content, list):
        return []
    calls = []
    for item in content:
        if isinstance(item, dict) and item.get("type") == "toolCall":
            calls.append({"id": item.get("id"), "function_name": item.get("name"),
                          "arguments": item.get("arguments")})
    return calls


def _make_step(index, source, fn, message, start=None, end=None, *,
               timestamp=None, status="ok", error=None, metrics=None,
               tool_calls=None, observation=None, parent_id=None, model_name=None):
    step = {"step_id": "s%d" % index, "source": source, "message": message}
    if timestamp:
        step["timestamp"] = timestamp
    if metrics:
        step["metrics"] = metrics
    if tool_calls:
        step["tool_calls"] = tool_calls
    if observation is not None:
        step["observation"] = {"content": observation}
    if model_name:
        step["model_name"] = model_name
    invocation = {"status": status}
    if start is not None:
        invocation["start_timestamp"] = round(start, 6)
    if end is not None:
        invocation["end_timestamp"] = round(end, 6)
    if error is not None:
        invocation["error"] = error
    step["extra"] = {
        "ancestry": {"function_id": "f%d" % index, "function_name": fn,
                     "parent_id": parent_id},
        "invocation": invocation,
    }
    return step


def steps_from_events(events, *, text_limit=TEXT_LIMIT, observation_limit=OBSERVATION_LIMIT):
    """Rebuild a single attempt's event stream into an ATIF-style payload.

    Returns a dict holding schema_version / session_id / steps plus meta such as
    run_id, task_id, attempt_id, status, usage, error and final_text.
    """
    rows = [e for e in events or [] if isinstance(e, dict) and isinstance(e.get("type"), str)]
    rows.sort(key=lambda e: _num(e.get("seq")) or 0)

    steps = []
    meta = {"run_id": None, "task_id": None, "attempt_id": None,
            "status": "incomplete", "usage": None, "error": None,
            "final_text": None, "model": None, "prompt": None, "system": None}
    # Trajectory bounds come from the first and last at of the stream: runs like agentx
    # only emit start/end and have no steps, yet the UI still needs an attempt timeline.
    first_at = None
    last_at = None
    pending = {}        # tool call id -> index of that tool step in steps
    llm_step_of = {}    # tool call id -> id of the llm step that issued it
    prev_at = None

    for row in rows:
        typ = row.get("type")
        data = row.get("data")
        data = data if isinstance(data, dict) else {}
        at = _sec(row.get("at"))

        key = row.get("key")
        if isinstance(key, dict):
            for field, name in (("runId", "run_id"), ("taskId", "task_id"),
                                ("attemptId", "attempt_id")):
                if meta[name] is None and key.get(field) is not None:
                    meta[name] = key[field]

        if typ == "start":
            inp = data.get("input")
            if isinstance(inp, dict):
                meta["prompt"] = inp.get("prompt")
                if meta["task_id"] is None:
                    meta["task_id"] = inp.get("id")

        elif typ == "message":
            role = data.get("role")
            content = data.get("content")
            if role == "system":
                # the system prompt is large and repeats every turn: keep it in meta only, no step
                sections = data.get("sections")
                meta["system"] = _clip(_text_of(content) or
                                       (sections.get("preamble") if isinstance(sections, dict) else ""),
                                       text_limit)
            elif role == "user":
                steps.append(_make_step(
                    len(steps) + 1, "user", "user.input",
                    _clip(_text_of(content), text_limit),
                    at, at, timestamp=row.get("at")))
            elif role == "assistant":
                duration = _num(data.get("durationMs"))
                duration_s = duration / 1000.0 if duration is not None and duration >= 0 else None
                # message events are flushed after the response completes, so at is the end;
                # derive the start from it
                end = at
                start = at - duration_s if at is not None and duration_s is not None else at
                usage = data.get("usage") if isinstance(data.get("usage"), dict) else {}
                metrics = {}
                prompt_tokens = _num(usage.get("input"))
                completion_tokens = _num(usage.get("output"))
                # cacheRead is a separate field and must not be folded into input,
                # otherwise cache reuse is invisible
                cached_tokens = _num(usage.get("cacheRead"))
                if prompt_tokens is not None:
                    metrics["prompt_tokens"] = int(prompt_tokens)
                if completion_tokens is not None:
                    metrics["completion_tokens"] = int(completion_tokens)
                if cached_tokens is not None:
                    metrics["cached_tokens"] = int(cached_tokens)
                model = data.get("model") or data.get("responseModel")
                calls = _tool_calls_of(content)
                step = _make_step(
                    len(steps) + 1, "agent", LLM_FUNCTION,
                    _clip(_text_of(content), text_limit),
                    start, end, timestamp=row.get("at"),
                    metrics=metrics or None, tool_calls=calls or None,
                    model_name=model if isinstance(model, str) else None)
                steps.append(step)
                if meta["model"] is None and isinstance(model, str):
                    meta["model"] = model
                for call in calls:
                    if call.get("id"):
                        llm_step_of[call["id"]] = step["step_id"]
            # role == "toolResult" duplicates the tool_result event, skip it

        elif typ == "tool_start":
            call_id = data.get("id")
            name = data.get("name") or "tool"
            index = len(steps) + 1
            steps.append(_make_step(
                index, "system", str(name), "",
                at, None, timestamp=row.get("at"), status="incomplete",
                parent_id=llm_step_of.get(call_id)))
            if call_id is not None:
                pending[call_id] = index - 1

        elif typ == "tool_result":
            call_id = data.get("id")
            name = data.get("name") or "tool"
            result = data.get("result") if isinstance(data.get("result"), dict) else {}
            text = _clip(_text_of(result.get("content")), observation_limit)
            failed = data.get("isError") is True
            index = pending.pop(call_id, None)
            if index is None:
                # no matching tool_start (truncated trace or lost event): synthesize a full step
                steps.append(_make_step(
                    len(steps) + 1, "system", str(name), "",
                    at, at, timestamp=row.get("at"),
                    status="error" if failed else "ok",
                    error=text if failed else None,
                    observation=text, parent_id=llm_step_of.get(call_id)))
            else:
                step = steps[index]
                invocation = step["extra"]["invocation"]
                invocation["status"] = "error" if failed else "ok"
                if at is not None:
                    invocation["end_timestamp"] = round(at, 6)
                if failed:
                    invocation["error"] = text
                step["observation"] = {"content": text}

        elif typ == "error":
            message = data.get("message")
            if not isinstance(message, str) or not message:
                message = data.get("name") or "error"
            steps.append(_make_step(
                len(steps) + 1, "agent", AGENT_FUNCTION,
                _clip(message, text_limit),
                prev_at if prev_at is not None else at, at,
                timestamp=row.get("at"), status="error", error=message))
            meta["error"] = {"name": data.get("name"), "message": data.get("message")}
            meta["status"] = "failed"

        elif typ == "usage":
            meta["usage"] = {"input_tokens": data.get("inputTokens"),
                             "output_tokens": data.get("outputTokens"),
                             "total_tokens": data.get("totalTokens")}

        elif typ == "end":
            status = data.get("status")
            meta["status"] = status if isinstance(status, str) and status else "completed"
            meta["final_text"] = data.get("finalText")
        # agent_end is the Agent-layer retry boundary and produces no step

        if at is not None:
            if first_at is None:
                first_at = at
            last_at = at
            prev_at = at

    for index in sorted(pending.values()):
        # tool_start without tool_result: keep the half-open interval and mark it incomplete
        steps[index]["extra"]["invocation"]["status"] = "incomplete"

    for index, step in enumerate(steps, start=1):
        step["step_id"] = "s%d" % index

    # The header stats read final_metrics: without them the token column would keep
    # showing "—", even though the data is spread across each step's metrics.
    totals = {"total_steps": len(steps)}
    seen_tokens = False
    for step in steps:
        metrics = step.get("metrics") or {}
        for key, name in (("prompt_tokens", "total_prompt_tokens"),
                          ("completion_tokens", "total_completion_tokens"),
                          ("cached_tokens", "total_cached_tokens")):
            value = metrics.get(key)
            if isinstance(value, int):
                totals[name] = totals.get(name, 0) + value
                seen_tokens = True
    if not seen_tokens:
        usage = meta["usage"] or {}
        if isinstance(usage.get("input_tokens"), int):
            totals["total_prompt_tokens"] = usage["input_tokens"]
        if isinstance(usage.get("output_tokens"), int):
            totals["total_completion_tokens"] = usage["output_tokens"]

    return {
        "schema_version": "ATIF-v1.7",
        "session_id": meta["attempt_id"],
        "trajectory_id": meta["attempt_id"],
        # name is for list rendering, model_name for the header bar; missing either shows "model —".
        "agent": {"name": meta["model"] or "evaluator", "model_name": meta["model"]},
        "run_id": meta["run_id"],
        "task_id": meta["task_id"],
        "attempt_id": meta["attempt_id"],
        "status": meta["status"],
        "started_at": first_at,
        "ended_at": last_at,
        "prompt": meta["prompt"],
        "system_prompt": meta["system"],
        "final_text": meta["final_text"],
        "usage": meta["usage"],
        "error": meta["error"],
        "final_metrics": totals,
        "steps": steps,
    }


def outcome_from_result(result):
    """Map the Evaluator's result.json onto the Collector's outcome record.

    Field mapping:
        key.taskId           -> task_id
        verdict.passed       -> success (an agent_timeout with a null verdict counts as failure)
        verdict.score        -> reward (left empty when unavailable, never assumed 0)
        accounting.cost      -> cost_usd
        executionStatus      -> status (stored with the record, not used in aggregation)

    Note: durationMs is deliberately not written into latency_ms. It is the wall-clock
    time of the whole task, including container setup, while latency.* thresholds are
    defined for inference latency; filling it in would keep that signal permanently lit.
    """
    if not isinstance(result, dict):
        return None
    key = result.get("key") if isinstance(result.get("key"), dict) else {}
    verdict = result.get("verdict") if isinstance(result.get("verdict"), dict) else {}
    details = verdict.get("details") if isinstance(verdict.get("details"), dict) else None
    accounting = (result.get("accounting")
                  if isinstance(result.get("accounting"), dict) else {})
    usage = accounting.get("usage") if isinstance(accounting.get("usage"), dict) else None
    return {
        "kind": "outcome",
        "run_id": key.get("runId"),
        "attempt_id": key.get("attemptId"),
        "task_id": str(key.get("taskId") or result.get("taskId") or ""),
        "success": bool(verdict.get("passed")),
        "reward": _num(verdict.get("score")),
        "cost_usd": _num(accounting.get("cost")),
        # when no price table exists cost stays 0, so token usage is the usable magnitude
        "tokens": usage,
        "status": result.get("executionStatus"),
        # scoring details (extracted / method etc.) let the analysis layer tell a wrong
        # model answer apart from a scorer that failed to recognize it
        "verdict_details": details,
    }
