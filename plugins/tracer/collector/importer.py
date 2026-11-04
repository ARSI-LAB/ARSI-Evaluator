"""Import offline result directories or uploaded files into the store."""
from __future__ import annotations

import json
import re
from pathlib import Path

from ingest import EVENT_STEP_SEQ, EVENT_TYPES, broadcast, handle_doc
from runtime import RT

_UUID_RE = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-"
                      r"[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")
STATIC_NAMES = ("agentx-summary.json", "trajectory.jsonl", "trajectory.json")
_MAX_FILES = 5000


def _static_attempt(rel: str) -> str:
    """Use attempts/<attemptId> as session id when the path exposes one."""
    parts = Path(rel).parts
    if "attempts" in parts:
        i = len(parts) - 1 - parts[::-1].index("attempts")
        if i + 1 < len(parts):
            return parts[i + 1]
    return Path(rel).parent.name or "static"


def _static_epoch(rel: str, fallback: str) -> str:
    """Prefer the picked run directory, then the first uuid in the relative path."""
    if _UUID_RE.match(fallback or ""):
        return fallback
    for part in Path(rel).parts:
        if _UUID_RE.match(part):
            return part
    return fallback or "static"


def _summary_session(rel: str, data) -> str:
    """Without a directory, derive a stable session from the workload."""
    if len(Path(rel).parts) > 1:
        return _static_attempt(rel)
    w = (data or {}).get("workload") or {}
    bits = [str(w.get("mode") or ""), str(w.get("variant") or "")]
    if w.get("concurrency") is not None:
        bits.append("c%s" % w["concurrency"])
    return "-".join([b for b in bits if b]) or Path(rel).stem


def _entry_run_ids(entries):
    """Recover runIds from trajectory events when file paths carry no epoch."""
    ids = []
    for rel, text in entries:
        if Path(rel).name != "trajectory.jsonl":
            continue
        for ln in text.splitlines():
            try:
                key = json.loads(ln).get("key") or {}
            except Exception:
                continue
            rid = key.get("runId")
            if rid and rid not in ids:
                ids.append(rid)
    return ids


async def import_static(entries, fixed_epoch, fallback_epoch):
    """Import (relative path, text) pairs, dispatching by file name."""
    counts = {"summary": 0, "trajectory": 0, "skipped": 0, "errors": 0}
    epochs = []
    # Uploaded files carry no epoch; a single shared runId becomes the default.
    run_ids = _entry_run_ids(entries)
    default_epoch = fixed_epoch or (run_ids[0] if len(run_ids) == 1 else fallback_epoch)

    def ep_of(rel):
        ep = fixed_epoch or _static_epoch(rel, default_epoch)
        if ep not in epochs:
            epochs.append(ep)
        return ep

    async def emit(evt):
        if evt is not None:
            await broadcast(evt)

    for rel, text in sorted(entries):
        name = Path(rel).name
        if name == "agentx-summary.json":
            ep = ep_of(rel)
            try:
                data = json.loads(text)
            except Exception:
                counts["errors"] += 1
                continue
            evt = await handle_doc(None, {"session": _summary_session(rel, data), "epoch": ep,
                                          "seq": 1, "data": data})
            if evt is None:
                counts["skipped"] += 1
            else:
                counts["summary"] += 1
                await emit(evt)
        elif name == "trajectory.jsonl":
            ep = ep_of(rel)
            attempt = _static_attempt(rel)
            # Skip a file already rebuilt from events to avoid double-counting steps.
            if len(Path(rel).parts) > 1 and RT.store is not None \
                    and RT.store.list_events(ep, attempt):
                counts["skipped"] += 1
                continue
            accepted = skipped = 0
            for ln in text.splitlines():
                if not ln.strip():
                    continue
                try:
                    obj = json.loads(ln)
                except Exception:
                    counts["errors"] += 1
                    continue
                if not isinstance(obj, dict) or obj.get("type") not in EVENT_TYPES:
                    skipped += 1
                    continue
                key = obj.get("key") or {}
                line_ep = fixed_epoch or key.get("runId") or ep
                line_attempt = key.get("attemptId") or attempt
                if line_ep not in epochs:
                    epochs.append(line_ep)
                obj["epoch"] = line_ep
                evt = await handle_doc(line_attempt, obj)
                if evt is None:
                    skipped += 1
                else:
                    accepted += 1
                    await emit(evt)
            counts["trajectory"] += accepted
            counts["skipped"] += skipped
        elif name == "trajectory.json":
            ep = ep_of(rel)
            try:
                data = json.loads(text)
            except Exception:
                counts["errors"] += 1
                continue
            if not isinstance(data, dict) or not isinstance(data.get("steps"), list):
                counts["skipped"] += 1
                continue
            evt = await handle_doc(None, {"session": _static_attempt(rel), "epoch": ep,
                                          "seq": EVENT_STEP_SEQ, "data": data})
            if evt is None:
                counts["skipped"] += 1
            else:
                counts["trajectory"] += 1
                await emit(evt)

    # Imported snapshots never emit a finish event; mark them finished so
    # background analysis is not blocked forever.
    if RT.store is not None:
        for ep in epochs:
            cur = RT.store.get_run(ep) or {}
            if (cur.get("status") or "").lower() not in ("finished",):
                RT.store.finish_run(ep)

    return {"epoch": epochs[0] if epochs else (fixed_epoch or fallback_epoch),
            "epochs": epochs, **counts}


def collect_dir_entries(root: Path):
    """Read every recognized artifact under a directory."""
    entries = []
    for p in sorted(root.rglob("*")):
        if p.is_file() and p.name in STATIC_NAMES:
            try:
                entries.append((str(p.relative_to(root)), p.read_text(encoding="utf-8")))
            except Exception:
                pass
    return entries


def parse_files_payload(files):
    """Normalize the JSON upload payload into (relative path, text) entries."""
    entries = []
    for f in files[:_MAX_FILES]:
        if not isinstance(f, dict):
            continue
        rel = str(f.get("path") or "").strip()
        text = f.get("text")
        if rel and isinstance(text, str) and Path(rel).name in STATIC_NAMES:
            entries.append((rel, text))
    return entries
