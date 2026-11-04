from __future__ import annotations
import json
import math

MIN_TASKS = 20
SUCCESS_EPS = 0.02
LATENCY_REL = 0.10
CI_Z = 1.959963984540054  # 95% two-sided

DOMAIN_KEYS = {
    "prompt_hash": "harness",
    "tools": "harness",
    "solver": "harness",
    "model": "model",
    "api": "model",
    "infra": "infra",
    "environment": "infra",
    "scheduler": "infra",
    "benchmark": "benchmark",
    "run": "benchmark",
}

NOTES = {
    "infra": "本轮仅 infra 配置变更，指标变化归因于 Infra Agent",
    "harness": "本轮仅 harness（prompt/tools）变更，指标变化归因于 Harness Agent",
    "model": "本轮仅模型变更，指标变化归因于模型侧",
    "benchmark": "本轮仅评测集/范围变更，前后指标不可直接比较",
    "mixed": "本轮多个域同时变更，指标变化无法单独归因",
    "none": "本轮 fingerprint 与父版本一致，指标差异应来自噪声",
    "hash": "本轮配置整体已变更，但只上报了整体哈希，无法细分到 prompt/tools/model/infra",
    "unknown": "缺少 fingerprint，无法归因",
}


def _fp(run):
    # Prefer the structured config reported by the evaluator (manifest.configSummary),
    # which resolves down to individual domains; legacy rows only carry a whole-config
    # hash, where the only possible comparison is whether it changed.
    cfg = (run or {}).get("config")
    if isinstance(cfg, str):
        try:
            cfg = json.loads(cfg)
        except Exception:
            cfg = None
    if isinstance(cfg, dict) and cfg:
        return cfg
    fp = (run or {}).get("fingerprint")
    if isinstance(fp, str):
        try:
            fp = json.loads(fp)
        except Exception:
            pass
    if isinstance(fp, dict):
        return fp
    # when the client only reports a whole-config hash, all we can compare is whether it changed
    if isinstance(fp, str) and fp:
        return {"__config_hash__": fp}
    return {}


def _diff(cur, prev):
    if not isinstance(cur, (int, float)) or not isinstance(prev, (int, float)):
        return None
    return round(float(cur) - float(prev), 4)


def _fmt_ms(value, signed=False):
    """Adaptive millisecond units: values like 2270415ms are unreadable as raw milliseconds."""
    if not isinstance(value, (int, float)):
        return "—"
    value = float(value)
    sign = "+" if signed and value > 0 else ""
    if abs(value) < 1000:
        return "%s%.0f ms" % (sign, value)
    if abs(value) < 60000:
        return "%s%.1f s" % (sign, value / 1000.0)
    return "%s%.1f min" % (sign, value / 60000.0)


def _cost_per_task(pop):
    cost, tasks = pop.get("cost_usd"), pop.get("tasks") or 0
    if not isinstance(cost, (int, float)) or tasks <= 0:
        return None
    return round(float(cost) / tasks, 6)


def _attribution(cur_run, parent_run):
    cur, prev = _fp(cur_run), _fp(parent_run)
    if "__config_hash__" in cur and "__config_hash__" in prev:
        same = cur["__config_hash__"] == prev["__config_hash__"]
        return {"changed": "none" if same else "hash",
                "keys": [] if same else ["config_hash"],
                "unchanged": ["config_hash"] if same else [],
                "note": NOTES["none" if same else "hash"]}
    if "__config_hash__" in cur or "__config_hash__" in prev:
        return {"changed": "hash", "keys": [], "unchanged": [], "note": NOTES["hash"]}
    changed, unchanged = [], []
    for key in DOMAIN_KEYS:
        if key not in cur or key not in prev:
            continue
        if cur[key] == prev[key]:
            unchanged.append(key)
        else:
            changed.append(key)
    domains = []
    for key in changed:
        domain = DOMAIN_KEYS[key]
        if domain not in domains:
            domains.append(domain)
    if not cur or not prev:
        changed_domain = "unknown"
    elif not domains:
        changed_domain = "none"
    elif len(domains) == 1:
        changed_domain = domains[0]
    else:
        changed_domain = "mixed"
    return {"changed": changed_domain, "keys": changed, "unchanged": unchanged,
            "note": NOTES[changed_domain]}


def _wilson(k, n, z=CI_Z):
    """Wilson score interval: more stable than the normal approximation for small samples
    or proportions near 0/1."""
    if not n:
        return None
    p = k / float(n)
    denom = 1.0 + z * z / n
    center = (p + z * z / (2 * n)) / denom
    half = z / denom * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))
    return round(center - half, 4), round(center + half, 4)


def _newcombe(k1, n1, k2, n2):
    """95% interval for the difference of two proportions (p1-p2), Newcombe hybrid score.

    An interval spanning 0 means the two groups are statistically indistinguishable.
    It is more robust than a plain z-test when proportions approach 0/1.
    """
    if not n1 or not n2:
        return None
    p1, p2 = k1 / float(n1), k2 / float(n2)
    w1, w2 = _wilson(k1, n1), _wilson(k2, n2)
    if w1 is None or w2 is None:
        return None
    low = (p1 - p2) - math.sqrt((p1 - w1[0]) ** 2 + (w2[1] - p2) ** 2)
    high = (p1 - p2) + math.sqrt((w1[1] - p1) ** 2 + (p2 - w2[0]) ** 2)
    return round(low, 4), round(high, 4)


def _counts(pop):
    """success_rate is a rounded ratio; invert it back to success counts so proportion intervals apply."""
    rate, n = pop.get("success_rate"), pop.get("tasks") or 0
    if not isinstance(rate, (int, float)) or n <= 0:
        return None, 0
    return int(round(float(rate) * n)), int(n)


def _success_rate_ci(cur_pop, parent_pop):
    k1, n1 = _counts(cur_pop)
    k2, n2 = _counts(parent_pop)
    w1, w2 = (_wilson(k1, n1) if k1 is not None else None,
              _wilson(k2, n2) if k2 is not None else None)
    if w1 is None or w2 is None:
        return None
    diff = _newcombe(k1, n1, k2, n2)
    return {"confidence": 0.95,
            "current": list(w1),
            "parent": list(w2),
            "diff": list(diff) if diff else None}


def _significant(cur, parent, delta, ci=None):
    # Three gates: enough samples, enough effect size, and a confidence interval that
    # excludes 0. Point estimates alone would call a 2pp move on 20 samples significant
    # (standard error around ±11pp), and a false positive makes the verdict engine emit
    # accept -- its only path to a wrong release.
    if (cur.get("tasks") or 0) < MIN_TASKS or (parent.get("tasks") or 0) < MIN_TASKS:
        return False
    sr = delta.get("success_rate")
    if sr is not None and abs(sr) >= SUCCESS_EPS:
        diff_ci = (ci or {}).get("diff")
        if diff_ci and (diff_ci[0] > 0 or diff_ci[1] < 0):
            return True
    p95 = delta.get("p95_latency_ms")
    base = parent.get("p95_latency_ms")
    if p95 is not None and isinstance(base, (int, float)) and base:
        return abs(p95) / abs(base) >= LATENCY_REL
    return False


def _pct(v):
    return "%.1f%%" % (v * 100)


def _explain(cur, parent, delta, parent_epoch):
    bits = []
    if delta.get("success_rate") is not None:
        bits.append("成功率 %s → %s（%+.1fpp）" % (
            _pct(parent["success_rate"]), _pct(cur["success_rate"]),
            delta["success_rate"] * 100))
    if delta.get("p50_latency_ms") is not None:
        bits.append("P50 %s（%s → %s）" % (
            _fmt_ms(delta["p50_latency_ms"], signed=True),
            _fmt_ms(parent["p50_latency_ms"]), _fmt_ms(cur["p50_latency_ms"])))
    if delta.get("p95_latency_ms") is not None:
        bits.append("P95 %s（%s → %s）" % (
            _fmt_ms(delta["p95_latency_ms"], signed=True),
            _fmt_ms(parent["p95_latency_ms"]), _fmt_ms(cur["p95_latency_ms"])))
    if delta.get("cost_per_task") is not None:
        bits.append("单任务成本 $%.4f → $%.4f" % (
            _cost_per_task(parent), _cost_per_task(cur)))
    if delta.get("steps_mean") is not None:
        bits.append("平均步数 %.2f → %.2f" % (parent["steps_mean"], cur["steps_mean"]))
    if bits:
        text = "对比父版本 %s：%s。" % (parent_epoch, "，".join(bits))
    else:
        text = "对比父版本 %s：核心指标无变化。" % parent_epoch
    text += delta["attribution"]["note"] + "。"
    if not delta["significant"]:
        diff_ci = (delta.get("success_rate_ci") or {}).get("diff")
        if diff_ci and diff_ci[0] <= 0 <= diff_ci[1]:
            text += "成功率变化 95%% 区间 [%+.1fpp, %+.1fpp] 跨 0；" % (
                diff_ci[0] * 100, diff_ci[1] * 100)
        text += "样本量或变化幅度不足，结论仅供参考。"
    return text


def find_parent(store, epoch, run):
    """Resolve the parent epoch through runs.candidate_id."""
    parent_id = (run or {}).get("parent_id")
    if not parent_id or store is None:
        return None, None
    row = store.find_run_by_candidate(parent_id, exclude_epoch=epoch)
    if not row:
        return None, None
    return row["epoch"], row


def compute_delta(cur_run, cur_pop, parent_run, parent_pop, parent_epoch):
    delta = {
        "parent_epoch": parent_epoch,
        "success_rate": _diff(cur_pop.get("success_rate"), parent_pop.get("success_rate")),
        "p50_latency_ms": _diff(cur_pop.get("p50_latency_ms"), parent_pop.get("p50_latency_ms")),
        "p95_latency_ms": _diff(cur_pop.get("p95_latency_ms"), parent_pop.get("p95_latency_ms")),
        "cost_per_task": _diff(_cost_per_task(cur_pop), _cost_per_task(parent_pop)),
        "steps_mean": _diff(cur_pop.get("steps_mean"), parent_pop.get("steps_mean")),
        "samples": {"current": cur_pop.get("tasks") or 0,
                    "parent": parent_pop.get("tasks") or 0},
        # absolute values ship alongside the delta so the verdict engine can write
        # "before -> after" without querying the parent epoch again
        "values": {
            "current": {"success_rate": cur_pop.get("success_rate"),
                        "p50_latency_ms": cur_pop.get("p50_latency_ms"),
                        "p95_latency_ms": cur_pop.get("p95_latency_ms"),
                        "cost_per_task": _cost_per_task(cur_pop),
                        "steps_mean": cur_pop.get("steps_mean")},
            "parent": {"success_rate": parent_pop.get("success_rate"),
                       "p50_latency_ms": parent_pop.get("p50_latency_ms"),
                       "p95_latency_ms": parent_pop.get("p95_latency_ms"),
                       "cost_per_task": _cost_per_task(parent_pop),
                       "steps_mean": parent_pop.get("steps_mean")},
        },
        "attribution": _attribution(cur_run, parent_run),
    }
    delta["success_rate_ci"] = _success_rate_ci(cur_pop, parent_pop)
    delta["significant"] = _significant(cur_pop, parent_pop, delta,
                                        delta["success_rate_ci"])
    return delta, _explain(cur_pop, parent_pop, delta, parent_epoch)
