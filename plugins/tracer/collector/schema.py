from __future__ import annotations
import json

SCHEMA_VERSION = "OptFeedback"

def make_feedback(epoch, candidate=None, population=None, signals=None,
                  delta=None, explain=None):
    c = dict(candidate or {})
    fp = c.get("fingerprint")
    if isinstance(fp, str):
        try:
            fp = json.loads(fp)
        except Exception:
            pass
    return {
        "schema_version": SCHEMA_VERSION,
        "epoch": epoch,
        "candidate": {
            "candidate_id": c.get("candidate_id"),
            "parent_id": c.get("parent_id"),
            "fingerprint": fp or {},
        },
        "population": population or {},
        "signals": signals or [],
        "delta_vs_parent": delta,
        "explain": explain,
    }
