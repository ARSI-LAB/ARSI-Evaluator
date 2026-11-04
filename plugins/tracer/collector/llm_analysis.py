"""Optional LLM feedback analysis; inactive without TRACER_LLM_BASE_URL and TRACER_LLM_MODEL."""
from __future__ import annotations

import hashlib
import json
import os
import time
import urllib.error
import urllib.request

from aggregate import is_profiling_run, population, profiling_perf

SEVERITIES = ("high", "medium", "low")
MAX_FINDINGS = 12
MAX_ATTEMPTS = 50
MAX_FAILED_TASKS = 20

# The real performance measure for profiling. Tier index, duration and load do not count: only
# numeric values in these fields prove metrics were sampled, otherwise the summary is an empty shell.
PROFILING_METRIC_KEYS = ("ttft_p50", "ttft_p95", "itl_mean", "latency_p95", "throughput",
                         "interactivity", "cache_hit", "npu_util", "aicore_util",
                         "hbm_usage", "temperature")

# Process-wide counters exposed via /metrics to tell whether the LLM was called and how it failed.
STATS = {"calls": 0, "cache_hits": 0, "failures": 0, "dropped": 0, "last_error": None}

TRAJ_PROMPT = (
    "You diagnose ONE agent attempt from an LLM evaluation run. FACTS is a digest: "
    "attempt id, totals, inference/cache/hardware metrics, and steps with "
    "{step_id, fn, dur, status, error, msg}.\n"
    "Rules:\n"
    "1. Never invent step ids or metric names. Only reference values present in FACTS.\n"
    "2. Put exactly one reference in evidence: {\"step_id\": ...} or {\"metric\": ...}.\n"
    "3. Focus on the slowest steps, failed steps and any obviously wasteful pattern; "
    "explain what to change in this attempt specifically.\n"
    "4. Return at most 8 findings, ordered by how much each one affects task success "
    "first, then by time/cost, and put the highest severity first. Keep title short "
    "and detail/recommendation under 120 characters each; never paste commands, logs "
    "or stack traces into the output.\n"
    "5. Do not report missing telemetry as a problem; skip categories the data cannot "
    "support. Write summary/title/detail/recommendation in Simplified Chinese (简体中文); "
    "keep JSON keys and identifiers (step_id, metric, category, severity, function names) "
    "unchanged. Respond with strict JSON, no prose, no code fences:\n"
    "{\"summary\": \"one sentence\", \"findings\": [{\"severity\": \"high|medium|low\", "
    "\"category\": \"bottleneck|error|quality|cost|cache|latency|efficiency\", "
    "\"title\": \"short\", \"detail\": \"evidence-based explanation\", "
    "\"evidence\": {\"step_id\": \"s3\"}, \"recommendation\": \"what to change\"}]}"
)

# Scenario blocks: shared rules live once in BASE_PROMPT, scenarios only fill in the differences.
# To add a scenario (e.g. operator-optimization RSI), add one entry plus a facts builder; the template stays put.
SCENARIOS = {
    "run": {
        "role": ("an LLM agent evaluation run. You are given FACTS only: population metrics, "
                 "per-attempt step summaries, and failed tasks."),
        "focus": ("Focus on failed and slowest steps plus obviously wasteful patterns, and explain "
                  "what to change in this run specifically. Do not report missing telemetry as a "
                  "problem; skip categories the data cannot support (e.g. cache when "
                  "cache_observable is false)."),
        "evidence": ('{"step_id": ...}, {"session": ...} or {"metric": ...}; omit evidence when '
                     "nothing specific applies"),
        "evidence_example": '{"step_id": "s3"}',
        "ordering": "by how much each one affects task success, then by time/cost",
        "categories": "bottleneck|error|quality|cost|cache|latency|efficiency",
    },
    "profiling": {
        "role": ("one inference profiling run (agentx workload) of an LLM deployment. FACTS holds "
                 "one row per concurrency tier: ttft_p50/ttft_p95/itl_mean/latency_p95 in ms, "
                 "throughput in tokens/s, interactivity in tokens/s/user, cache_hit as a 0..1 "
                 "ratio, npu_util/aicore_util/hbm_usage in %, temperature in °C, plus that tier's "
                 "requests, input/output tokens, duration_s and warmup_ttft_p95."),
        "focus": ("Every row is one concurrency level: compare rows to judge scaling (how "
                  "throughput grows versus how TTFT/ITL grow), name the affected tier, and give a "
                  "concrete tuning action (chunked prefill, max-num-seqs, max-model-len, prefix "
                  "caching, KV cache, tensor/data parallel, gpu-memory-utilization, scheduling). "
                  "This run has no agent steps by design: never ask for step/span telemetry, never "
                  "treat empty steps, tasks or population as an instrumentation bug, and never "
                  "discuss task success rate, reward or cost per task."),
        "evidence": '{"metric": "<key from FACTS>"}',
        "evidence_example": '{"metric": "ttft_p95"}',
        "ordering": "by how much each one limits throughput or tail latency",
        "categories": "bottleneck|latency|efficiency|cache|error",
    },
}

BASE_PROMPT = (
    "You diagnose {role}\n"
    "Rules:\n"
    "1. Never invent numbers, ids, sessions or metric names. Only refer to values present in FACTS.\n"
    "2. {focus}\n"
    "3. Put exactly one reference in evidence: {evidence}.\n"
    "4. If FACTS marks the data as missing (data_missing=true), state in summary that the metrics "
    "are missing and return no findings instead of guessing.\n"
    "5. Return at most 8 findings, highest severity first, {ordering}. Keep title short and "
    "detail/recommendation under 120 characters each; never paste commands, logs or stack traces.\n"
    "6. Write summary/title/detail/recommendation in Simplified Chinese (简体中文); keep JSON keys "
    "and identifiers (step_id, session, metric, category, severity, function names) unchanged. "
    "Respond with strict JSON, no prose, no code fences:\n"
    "{{\"summary\": \"one sentence\", \"findings\": [{{\"severity\": \"high|medium|low\", "
    "\"category\": \"{categories}\", \"title\": \"short\", "
    "\"detail\": \"evidence-based explanation\", \"evidence\": {evidence_example}, "
    "\"recommendation\": \"what to change\"}}]}}"
)

# Precompiled: scenarios only supply data instead of each assembling its own prompt string
PROMPTS = {name: BASE_PROMPT.format(**cfg) for name, cfg in SCENARIOS.items()}


def config():
    """Read provider config; returns None when required settings are missing (rules-only mode).

    TRACER_LLM_* is the collector-specific override and takes precedence; when absent it falls
    back to the evaluation side's MODEL_NAME / MODEL_ENDPOINT / MODEL_API_KEY. Those are usually
    always present, so making them win would disable the override entirely.
    """
    base = (os.environ.get("TRACER_LLM_BASE_URL") or os.environ.get("MODEL_ENDPOINT") or "").strip().rstrip("/")
    model = (os.environ.get("TRACER_LLM_MODEL") or os.environ.get("MODEL_NAME") or "").strip()
    if not base or not model:
        return None
    return {
        "base": base,
        "model": model,
        "key": (os.environ.get("TRACER_LLM_API_KEY") or os.environ.get("MODEL_API_KEY") or "").strip(),
        # Reasoning models think before answering; 30-90s per call is common, so 30s would time out.
        "timeout": _num("TRACER_LLM_TIMEOUT", 120.0),
        # Reasoning models spend reasoning_tokens first, and 3000 is often eaten entirely, leaving an
        # empty body; default to a generous 8000 and override with TRACER_LLM_MAX_TOKENS to save quota.
        "max_tokens": int(_num("TRACER_LLM_MAX_TOKENS", 8000)),
    }


def _num(name, default):
    try:
        return float(os.environ.get(name) or default)
    except ValueError:
        return default


def canonical(value):
    """For stable serialization: sort dict keys and fix float precision so the same facts hash the same."""
    if isinstance(value, dict):
        return {key: canonical(value[key]) for key in sorted(value)}
    if isinstance(value, list):
        return [canonical(item) for item in value]
    if isinstance(value, float):
        return round(value, 4)
    return value


def digest_hash(facts):
    text = json.dumps(canonical(facts), ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


# Per-field cap: stack traces, bash commands and logs easily run tens of thousands of characters;
# passing them whole makes the model copy them into findings and blow the output (finish_reason=length).
MAX_FIELD_CHARS = 200


def _clip(value, limit=MAX_FIELD_CHARS):
    if isinstance(value, str) and len(value) > limit:
        return value[:limit] + "…"
    return value


def _shrink_digest(digest):
    """Truncate long strings in the digest while keeping structure and step_id so evidence still validates."""
    out = {key: _clip(value) for key, value in digest.items() if key != "steps"}
    out["steps"] = [{key: _clip(value) for key, value in step.items()}
                    for step in digest.get("steps") or [] if isinstance(step, dict)]
    return out


def _profiling_facts(traces, outcomes=None):
    """Facts for a profiling run: inference/hardware metrics and load per concurrency tier.

    agentx profiling trajectories only carry lifecycle events (steps are always empty) and the population
    is entirely empty too; handing that to the model only yields the wrong conclusion that instrumentation
    is broken, so supply data that really explains performance and state that empty steps are by design.
    """
    perf = profiling_perf(traces)
    # Align load fields by (concurrency tier, source session): when one tier has several summaries,
    # keying by tier alone lets the later one overwrite the earlier and mixes A's requests into B's metrics.
    extra_by_key = {}
    for trace in traces or []:
        if trace.get("kind") != "summary":
            continue
        payload = trace.get("payload") or {}
        work = payload.get("workload") or {}
        prof = payload.get("profiling") or payload.get("profiling_metrics") or {}
        conc = work.get("concurrency")
        key = (conc if isinstance(conc, int) else None, str(trace.get("session") or ""))
        warm_ttft = (payload.get("warmup") or {}).get("ttft")
        extra_by_key[key] = {
            "warmup_ttft_p95": warm_ttft.get("p95") if isinstance(warm_ttft, dict) else None,
            "variant": work.get("variant"),
            "duration_s": work.get("durationSeconds"),
            "requests": (prof.get("requests") or {}).get("mean"),
            "input_tokens": (prof.get("inputTokens") or {}).get("mean"),
            "output_tokens": (prof.get("outputTokens") or {}).get("mean"),
        }
    tiers = []
    for row in perf["tiers"]:
        tier = dict(row)
        key = (row.get("concurrency"), str(row.get("session") or ""))
        extra = extra_by_key.get(key)
        if extra is None:
            # Fallback: when summaries do not line up with tier rows, take the first by tier; better under-aligned than dropped.
            extra = next((v for (c, _), v in extra_by_key.items()
                          if c == row.get("concurrency")), {})
        tier.update({k: v for k, v in extra.items() if v is not None})
        tiers.append(tier)
    facts = {"mode": "profiling", "tiers": tiers,
             "cache_observable": any(t.get("cache_hit") is not None for t in tiers)}
    # Mark data as missing when only the summary shell exists (no profiling numbers, no telemetry),
    # so the model states "metrics missing" instead of inventing tuning advice from tier numbers.
    if not any(isinstance(tier.get(k), (int, float)) for tier in tiers
               for k in PROFILING_METRIC_KEYS):
        facts["data_missing"] = True
    refs = {"step_ids": set(),
            "sessions": {str(t.get("session")) for t in tiers if t.get("session")},
            # Evidence only accepts numeric metric keys, so descriptive fields like variant cannot be cited as a metric.
            "metrics": {k for tier in tiers for k, v in tier.items()
                        if isinstance(v, (int, float))}}
    return facts, refs


def _run_facts(traces, outcomes):
    """Facts for a normal agent run: population, per-attempt step summary and failed tasks."""
    pop = population(traces, outcomes)
    attempts, step_ids, sessions = [], set(), set()
    cache_observed = False
    for trace in traces:
        if str(trace.get("kind") or "") != "trajectory":
            continue
        payload = trace.get("payload") or {}
        steps = payload.get("steps") or []
        session = str(trace.get("session") or payload.get("session_id") or "")
        sessions.add(session)
        rows = []
        for step in steps:
            if not isinstance(step, dict):
                continue
            step_id = str(step.get("step_id") or "")
            if step_id:
                step_ids.add(step_id)
            extra = step.get("extra") or {}
            inv = extra.get("invocation") or {}
            anc = extra.get("ancestry") or {}
            metrics = step.get("metrics") or {}
            start, end = inv.get("start_timestamp"), inv.get("end_timestamp")
            duration = (round(float(end) - float(start), 3)
                        if isinstance(start, (int, float)) and isinstance(end, (int, float)) else None)
            rows.append({"step_id": step_id,
                         "fn": anc.get("function_name") or step.get("source") or "",
                         "source": step.get("source"),
                         "duration_s": duration,
                         "status": inv.get("status"),
                         "prompt_tokens": metrics.get("prompt_tokens"),
                         "completion_tokens": metrics.get("completion_tokens"),
                         "cached_tokens": metrics.get("cached_tokens")})
            if isinstance(metrics.get("cached_tokens"), (int, float)):
                cache_observed = True
        timed = [row for row in rows if row["duration_s"] is not None]
        attempts.append({
            "session": session,
            "steps": len(steps),
            "slowest": sorted(timed, key=lambda row: -row["duration_s"])[:5],
            "errors": [row for row in rows
                       if str(row.get("status") or "").lower() not in ("", "ok", "success")][:10],
        })
    failed = [{"task_id": o.get("task_id"), "reward": o.get("reward"),
               "latency_ms": o.get("latency_ms"), "status": o.get("status"),
               # The answer and method extracted by the grader, to tell "model answered wrong" from "grader missed it".
               "verification": o.get("verdict_details")}
              for o in outcomes if not o.get("success")][:MAX_FAILED_TASKS]
    facts = {"population": pop, "tasks": len(outcomes), "failed_tasks": failed,
             "cache_observable": cache_observed,
             "attempts": attempts[:MAX_ATTEMPTS]}
    refs = {"step_ids": step_ids, "sessions": sessions,
            "metrics": set(pop or {}) | {"success_rate", "steps_mean", "p50_latency_ms",
                                         "p95_latency_ms", "cost_usd", "cost_per_task"}}
    return facts, refs


# Scenario -> facts builder. Adding a scenario only needs one builder registered here.
FACT_BUILDERS = {"run": _run_facts, "profiling": _profiling_facts}


def mode_of(traces):
    return "profiling" if is_profiling_run(traces) else "run"


def build_facts(traces, outcomes):
    """Compress traces into deterministic facts and return the reference sets used to validate evidence."""
    return FACT_BUILDERS[mode_of(traces)](traces, outcomes)


def prompt_for(facts):
    """Scenario -> prompt. Scenario differences live in SCENARIOS; the template itself is shared via BASE_PROMPT."""
    return PROMPTS.get((facts or {}).get("mode") or "run", PROMPTS["run"])


def pending(store, epoch):
    """Whether finish still needs an LLM analysis: provider configured and current digest not cached."""
    cfg = config()
    if cfg is None:
        return False
    traces = store.list_traces(epoch)
    if not traces:
        return False
    facts, _ = build_facts(traces, store.list_outcomes(epoch))
    return store.get_analysis(epoch, digest_hash(facts), cfg["model"]) is None


def analyze_trajectory(store, digest, epoch=None):
    """Run one LLM analysis on a single trajectory digest; returns None without a provider or steps."""
    cfg = config()
    if cfg is None or not isinstance(digest, dict):
        return None
    steps = [step for step in (digest.get("steps") or []) if isinstance(step, dict)]
    if not steps:
        return None
    # Scoring details are not in the trace, so pull them from the outcome: otherwise "model answered wrong" and "grader missed it" look identical.
    outcome = store.get_outcome(epoch, digest.get("attempt")) if epoch else None
    if isinstance(outcome, dict):
        digest = dict(digest)
        detail = {key: outcome[key] for key in ("task_id", "success", "reward", "status")
                  if key in outcome}
        if outcome.get("verdict_details") is not None:
            detail["verification"] = outcome["verdict_details"]
        digest["outcome"] = detail
    # Truncate oversized fields: the model only sees the summary and cannot copy commands/stack traces verbatim
    digest = _shrink_digest(digest)
    steps = digest["steps"]
    refs = {"step_ids": {str(step.get("step_id")) for step in steps
                         if step.get("step_id") is not None},
            "sessions": {str(digest["attempt"])} if digest.get("attempt") else set(),
            "metrics": _metric_names(digest)}
    cache_observable = any(isinstance(step.get("cached_tokens"), (int, float))
                           for step in steps)
    digest_hash_value = digest_hash(digest)
    scope_epoch = epoch or "adhoc"
    cached = store.get_analysis(scope_epoch, digest_hash_value, cfg["model"],
                                scope="trajectory")
    if cached is not None:
        STATS["cache_hits"] += 1
        return cached
    STATS["calls"] += 1
    try:
        summary, findings, dropped = _validate(_call(cfg, digest, TRAJ_PROMPT), refs)
        findings, suppressed = _filter_noise(findings, len(steps), cache_observable)
        dropped += suppressed
    except Exception as exc:
        STATS["failures"] += 1
        STATS["last_error"] = str(exc)
        return {"source": "rules", "scope": "trajectory", "model": cfg["model"],
                "digest_hash": digest_hash_value, "generated_at": time.time(),
                "error": str(exc), "summary": "LLM 分析失败，已回退规则结果",
                "findings": [], "dropped_findings": 0}
    STATS["dropped"] += dropped
    payload = {"source": "llm", "scope": "trajectory", "model": cfg["model"],
               "digest_hash": digest_hash_value, "generated_at": time.time(),
               "summary": summary, "findings": findings, "dropped_findings": dropped}
    store.save_analysis(scope_epoch, digest_hash_value, cfg["model"], payload,
                        scope="trajectory")
    return payload


def _filter_noise(findings, steps=None, cache_observable=True):
    """Drop findings that current data cannot verify, plus generic items that always hold on short traces.

    steps=None means an epoch-wide view, where short-trace suppression is skipped: each attempt in
    an epoch having only 2 steps does not mean the epoch has no latency or efficiency problem.
    """
    kept, dropped = [], 0
    for finding in findings:
        category = str(finding.get("category") or "").lower()
        if category == "cache" and not cache_observable:
            dropped += 1
            continue
        if steps is not None and category in ("latency", "efficiency") and steps < 3:
            dropped += 1
            continue
        kept.append(finding)
    return kept, dropped


def _metric_names(digest):
    names = set(digest.get("totals") or {})
    for section in ("inference", "cache", "hardware"):
        block = digest.get(section)
        if isinstance(block, dict):
            names.update(block)
    if isinstance(digest.get("outcome"), dict):
        names.update(digest["outcome"])
    return names


def analyze_epoch(store, epoch, force=False):
    """Run one LLM analysis for an epoch; returns None without a provider or traces.

    force=True skips the cache and recomputes (used by the panel's "Re-analyze" button).
    """
    cfg = config()
    if cfg is None:
        return None
    traces = store.list_traces(epoch)
    if not traces:
        return None
    outcomes = store.list_outcomes(epoch)
    facts, refs = build_facts(traces, outcomes)
    digest = digest_hash(facts)
    cached = None if force else store.get_analysis(epoch, digest, cfg["model"])
    if cached is not None:
        STATS["cache_hits"] += 1
        return cached
    STATS["calls"] += 1
    try:
        summary, findings, dropped = _validate(_call(cfg, facts, prompt_for(facts)), refs)
        findings, suppressed = _filter_noise(
            findings, cache_observable=bool(facts.get("cache_observable")))
        dropped += suppressed
    except Exception as exc:  # network/parse failure: do not cache, fall back to the rule layer
        STATS["failures"] += 1
        STATS["last_error"] = str(exc)
        return {"source": "rules", "model": cfg["model"],
                "digest_hash": digest, "generated_at": time.time(),
                "error": str(exc), "summary": "LLM 分析失败，已回退规则结果",
                "findings": [], "dropped_findings": 0}
    STATS["dropped"] += dropped
    payload = {"source": "llm", "model": cfg["model"],
               "digest_hash": digest, "generated_at": time.time(),
               "summary": summary, "findings": findings, "dropped_findings": dropped}
    store.save_analysis(epoch, digest, cfg["model"], payload)
    return payload


def _call(cfg, facts, prompt=None):
    prompt = prompt or PROMPTS["run"]
    body = json.dumps({
        "model": cfg["model"],
        "temperature": 0,
        "max_tokens": cfg["max_tokens"],
        "messages": [{"role": "system", "content": prompt},
                     {"role": "user", "content": json.dumps(facts, ensure_ascii=False)}],
    }).encode("utf-8")
    headers = {"Content-Type": "application/json"}
    if cfg["key"]:
        headers["Authorization"] = "Bearer " + cfg["key"]
    request = urllib.request.Request(cfg["base"] + "/chat/completions", data=body, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=cfg["timeout"]) as response:
            data = json.loads(response.read().decode("utf-8", "replace"))
    except urllib.error.HTTPError as exc:
        # The provider's error body (e.g. "Consumer is forbidden.") explains the cause better than the status line
        detail = exc.read().decode("utf-8", "replace").strip()[:200]
        raise RuntimeError("HTTP %d %s: %s" % (exc.code, exc.reason, detail)) from None
    choice = data["choices"][0]
    if str(choice.get("finish_reason") or "") == "length":
        raise ValueError("response truncated (finish_reason=length); "
                         "raise TRACER_LLM_MAX_TOKENS")
    return choice["message"]["content"]


def _validate(text, refs):
    data = _parse(text)
    summary = str(data.get("summary") or "").strip()
    valid, dropped = [], 0
    for item in data.get("findings") or []:
        finding = _finding(item, refs)
        if finding is None:
            dropped += 1
        else:
            valid.append(finding)
    # Keep by severity when over the limit: model ordering is unreliable, so sort before truncating
    # to avoid dropping high items that came later (ties keep the model's relative order).
    valid.sort(key=lambda f: SEVERITIES.index(f["severity"]))
    findings = valid[:MAX_FINDINGS]
    return summary, findings, dropped + len(valid) - len(findings)


def _finding(item, refs):
    """Validate one finding; return None when evidence references a nonexistent object (treated as hallucination)."""
    if not isinstance(item, dict):
        return None
    severity = str(item.get("severity") or "").lower()
    title = str(item.get("title") or "").strip()
    if severity not in SEVERITIES or not title:
        return None
    evidence = item.get("evidence")
    evidence = evidence if isinstance(evidence, dict) else {}
    if evidence.get("step_id") is not None and str(evidence["step_id"]) not in refs["step_ids"]:
        return None
    if evidence.get("metric") is not None and str(evidence["metric"]) not in refs["metrics"]:
        return None
    if evidence.get("session") is not None and str(evidence["session"]) not in refs["sessions"]:
        return None
    return {"severity": severity,
            "category": str(item.get("category") or "analysis"),
            "title": title,
            "detail": str(item.get("detail") or ""),
            "evidence": evidence,
            "recommendation": str(item.get("recommendation") or "")}


def _parse(text):
    """Lenient parsing: accepts plain JSON, ```json code fences, and text with surrounding prose."""
    body = (text or "").strip()
    if body.startswith("```"):
        body = body.strip("`")
        if body.lower().startswith("json"):
            body = body[4:]
    try:
        return json.loads(body)
    except Exception:
        pass
    start, end = body.find("{"), body.rfind("}")
    if 0 <= start < end:
        try:
            return json.loads(body[start:end + 1])
        except Exception:
            pass
    raise ValueError("model did not return JSON")
