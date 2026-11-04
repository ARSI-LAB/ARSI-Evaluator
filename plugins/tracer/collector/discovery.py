"""Locate result directories under the repository results root."""
from __future__ import annotations

import os
from pathlib import Path

_RESULT_PATTERNS = (
    "agentx-summary.json", "trajectory.jsonl",
    "tasks/*/attempts/*/agent/agentx-summary.json",
    "tasks/*/attempts/*/agent/trajectory.jsonl",
    "*/tasks/*/attempts/*/agent/agentx-summary.json",
    "*/tasks/*/attempts/*/agent/trajectory.jsonl",
)
_MAX_SCAN_DEPTH = 4


def dir_roots():
    """Browse roots for result directories: cwd/results first, then repo/results."""
    cands = [Path.cwd() / "results", Path(__file__).resolve().parents[3] / "results"]
    roots = []
    for c in cands:
        if c.is_dir():
            r = c.resolve()
            if r not in roots:
                roots.append(r)
    return roots


def has_results(p: Path) -> bool:
    """Whether a directory holds importable artifacts, checked on fixed patterns only."""
    for pat in _RESULT_PATTERNS:
        try:
            next(p.glob(pat))
            return True
        except StopIteration:
            pass
    return False


def find_dir_by_name(name: str) -> Path | None:
    """Resolve a run directory by name under the results root.

    Browsers only expose the picked folder's name, so the server searches its own
    roots. When several directories share the name, prefer one holding artifacts,
    then the newest.
    """
    if not name or name in (".", "..") or "/" in name or "\\" in name:
        return None
    best = None
    for root in dir_roots():
        for cur, dirs, _files in os.walk(root):
            depth = len(Path(cur).relative_to(root).parts)
            dirs[:] = [] if depth >= _MAX_SCAN_DEPTH else [
                d for d in dirs if not d.startswith(".") and d not in ("node_modules", "__pycache__")]
            p = Path(cur)
            if p.name != name:
                continue
            score = (has_results(p), p.stat().st_mtime)
            if best is None or score > best[0]:
                best = (score, p)
            dirs[:] = []
    return best[1] if best else None
