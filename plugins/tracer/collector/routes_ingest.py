"""HTTP routes for ingestion, replay and session browsing."""
from __future__ import annotations

import asyncio
import gzip
import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path

from fastapi import APIRouter, Query, Request
from fastapi.responses import JSONResponse, PlainTextResponse, StreamingResponse

import llm_analysis as LLM
from analysis_service import export_analysis
from discovery import dir_roots, find_dir_by_name, has_results
from importer import collect_dir_entries, import_static, parse_files_payload
from ingest import (enqueue, materialize_attempt, spool_dir, spool_write)
from runtime import RT, authorized, unauthorized

router = APIRouter()


@router.post("/v1/ingest")
async def ingest(request: Request, session: str = Query(None)):
    if not authorized(request):
        return unauthorized()
    raw = await request.body()
    if request.headers.get("content-encoding", "").lower() == "gzip":
        try:
            raw = gzip.decompress(raw)
        except Exception:
            return JSONResponse({"error": "bad gzip"}, status_code=400)
    if len(raw) > RT.cfg.max_body:
        return JSONResponse({"error": "too large"}, status_code=413)
    lines = [ln for ln in raw.decode("utf-8", "replace").splitlines() if ln.strip()]
    if not lines:
        return JSONResponse({"error": "empty"}, status_code=400)
    try:
        path = await asyncio.to_thread(spool_write, session, lines)
    except Exception as exc:
        return JSONResponse({"error": "spool unavailable", "detail": str(exc)},
                            status_code=503)
    RT.st.metrics["received_lines"] += len(lines)
    if not enqueue(path):
        RT.st.metrics["rejected_429"] += 1
        return JSONResponse({"error": "backpressure"}, status_code=429,
                            headers={"Retry-After": "1"})
    return JSONResponse({"accepted": len(lines), "queue": RT.st.queue.qsize()}, status_code=202)


@router.get("/v1/dirs")
async def list_dirs(request: Request, path: str = Query("")):
    """Browse directories under results so the browser can pick a run folder."""
    if not authorized(request):
        return unauthorized()
    roots = dir_roots()
    if not roots:
        return JSONResponse({"error": "没找到 results 目录"}, status_code=400)
    root = roots[0]
    cur = (root / path.strip("/")).resolve()
    if cur != root and root not in cur.parents:
        return JSONResponse({"error": "路径越界"}, status_code=400)
    if not cur.is_dir():
        return JSONResponse({"error": "目录不存在"}, status_code=400)
    rel = "" if cur == root else str(cur.relative_to(root))
    parent = None if cur == root else ("" if cur.parent == root
                                       else str(cur.parent.relative_to(root)))
    entries = []
    for p in sorted(cur.iterdir()):
        if p.is_dir() and not p.name.startswith("."):
            entries.append({"name": p.name,
                            "path": str(p.relative_to(root)),
                            "hasResults": has_results(p)})
    return {"root": str(root), "path": rel, "parent": parent,
            "hasResults": has_results(cur), "entries": entries}


@router.post("/v1/load-dir")
async def load_dir(request: Request):
    """Import a server-side result directory.

    `dir` is an absolute path (CLI/debug); `name` is a folder name resolved
    under the results root, which is all the browser picker exposes.
    """
    if not authorized(request):
        return unauthorized()
    try:
        body = await request.json()
    except Exception:
        return JSONResponse({"error": "bad json"}, status_code=400)
    body = body or {}
    raw = str(body.get("dir") or "").strip()
    name = str(body.get("name") or "").strip()
    if raw:
        root = Path(raw).expanduser()
        if not root.is_absolute() or not root.is_dir():
            return JSONResponse({"error": "目录不存在（需要服务器上的绝对路径）：%s" % raw},
                                status_code=400)
    elif name:
        root = find_dir_by_name(name)
        if root is None:
            return JSONResponse({"error": "未在服务器 results 目录下找到 %s" % name},
                                status_code=400)
    else:
        return JSONResponse({"error": "需要 dir 或 name"}, status_code=400)
    res = await import_static(collect_dir_entries(root),
                              str(body.get("epoch") or "").strip(), root.name)
    # Offline imports skip the plugin export hook, so persist results here.
    for ep in res.get("epochs") or [res.get("epoch")]:
        if ep:
            export_analysis(ep, root)
    return {"dir": str(root), **res}


@router.post("/v1/pick-dir")
async def pick_dir(request: Request):
    """Open the desktop folder picker so any directory on this host can be imported."""
    if not authorized(request):
        return unauthorized()
    await request.body()
    path = await asyncio.to_thread(_pick_native_dir)
    if path is None:
        return JSONResponse({"error": "当前环境没有可用的目录选择对话框"}, status_code=501)
    if not path:
        return {"cancelled": True}
    root = Path(path).expanduser()
    if not root.is_dir():
        return JSONResponse({"error": "所选目录不可访问：%s" % path}, status_code=400)
    return {"dir": str(root)}


_PICK_PS = r"""$ErrorActionPreference = "Stop"
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

// The WinForms FolderBrowserDialog falls back to the legacy shell tree; use the
// system folder picker (IFileOpenDialog with FOS_PICKFOLDERS) instead.
public static class TracerFolderPicker
{
    [ComImport, Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7")]
    private class FileOpenDialogRCW { }

    [ComImport, Guid("d57c7288-d4ad-4768-be02-9d969532d960"),
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IFileOpenDialog
    {
        [PreserveSig] int Show(IntPtr parent);
        void SetFileTypes(uint cFileTypes, IntPtr rgFilterSpec);
        void SetFileTypeIndex(uint iFileType);
        void GetFileTypeIndex(out uint piFileType);
        void Advise(IntPtr pfde, out uint pdwCookie);
        void Unadvise(uint dwCookie);
        void SetOptions(uint fos);
        void GetOptions(out uint pfos);
        void SetDefaultFolder(IShellItem psi);
        void SetFolder(IShellItem psi);
        void GetFolder(out IShellItem ppsi);
        void GetCurrentSelection(out IShellItem ppsi);
        void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string pszName);
        void GetFileName(out IntPtr pszName);
        void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string pszTitle);
        void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string pszText);
        void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string pszLabel);
        void GetResult(out IShellItem ppsi);
        void AddPlace(IShellItem psi, int fdap);
        void SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string pszDefaultExtension);
        void Close(int hr);
        void SetClientGuid(ref Guid guid);
        void ClearClientData();
        void SetFilter(IntPtr pFilter);
        void GetResults(out IntPtr ppenum);
        void GetSelectedItems(out IntPtr ppsai);
    }

    [ComImport, Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe"),
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IShellItem
    {
        void BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppv);
        void GetParent(out IShellItem ppsi);
        void GetDisplayName(uint sigdnName, out IntPtr ppszName);
        void GetAttributes(uint sfgaoMask, out uint psfgaoAttribs);
        void Compare(IShellItem psi, uint hint, out int piOrder);
    }

    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    private const uint FOS_PICKFOLDERS = 0x20;
    private const uint FOS_FORCEFILESYSTEM = 0x40;
    private const uint FOS_PATHMUSTEXIST = 0x800;
    private const uint SIGDN_FILESYSPATH = 0x80058000;

    public static string Pick(string title)
    {
        var dlg = (IFileOpenDialog)new FileOpenDialogRCW();
        uint options;
        dlg.GetOptions(out options);
        dlg.SetOptions(options | FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST);
        dlg.SetTitle(title);
        // Owned by the active window so the dialog comes up in front of the browser.
        if (dlg.Show(GetForegroundWindow()) != 0) return "";
        IShellItem result;
        dlg.GetResult(out result);
        IntPtr name;
        result.GetDisplayName(SIGDN_FILESYSPATH, out name);
        string path = Marshal.PtrToStringUni(name);
        Marshal.FreeCoTaskMem(name);
        return path ?? "";
    }
}
'@
[TracerFolderPicker]::Pick('选择要导入的 run 目录')
"""


def _pick_native_dir():
    """Return a picked path, "" when cancelled, or None when no dialog exists here."""
    ps = shutil.which("powershell.exe")
    if ps:
        # WSL interop: the dialog runs on the Windows desktop, so translate its path back.
        return _run_windows_picker(ps)
    for cmd in (["zenity", "--file-selection", "--directory", "--title=选择要导入的 run 目录"],
                ["kdialog", "--getexistingdirectory", str(Path.home())]):
        if shutil.which(cmd[0]):
            return _run_picker(cmd)
    return None


def _run_windows_picker(ps):
    # -Command would garble the Chinese title; a UTF-8 BOM script file keeps it intact.
    fd, script = tempfile.mkstemp(suffix=".ps1")
    os.close(fd)
    try:
        Path(script).write_text(_PICK_PS, encoding="utf-8-sig")
        return _run_picker([ps, "-NoProfile", "-STA", "-WindowStyle", "Hidden",
                            "-ExecutionPolicy", "Bypass", "-File", _to_windows_path(script)])
    finally:
        try:
            os.unlink(script)
        except OSError:
            pass


def _run_picker(cmd):
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
    except Exception:
        return None
    picked = (out.stdout or "").strip().splitlines()
    if not picked:
        return ""
    return _to_local_path(picked[-1].strip())


def _to_windows_path(p) -> str:
    try:
        out = subprocess.run(["wslpath", "-w", str(p)], capture_output=True,
                             text=True, timeout=5)
        if out.returncode == 0 and out.stdout.strip():
            return out.stdout.strip()
    except Exception:
        pass
    return str(p)


def _to_local_path(picked: str) -> str:
    try:
        out = subprocess.run(["wslpath", "-u", picked], capture_output=True,
                             text=True, timeout=5)
        if out.returncode == 0 and out.stdout.strip():
            return out.stdout.strip()
    except Exception:
        pass
    return picked


@router.post("/v1/load-files")
async def load_files(request: Request):
    """Import file contents uploaded by the browser (Windows -> WSL paths are unreadable)."""
    if not authorized(request):
        return unauthorized()
    raw = await request.body()
    if len(raw) > RT.cfg.max_body:
        return JSONResponse({"error": "目录太大，请选择单个 run 目录"}, status_code=413)
    try:
        body = json.loads(raw.decode("utf-8", "replace") or "{}")
    except Exception:
        return JSONResponse({"error": "bad json"}, status_code=400)
    files = (body or {}).get("files") or []
    if not isinstance(files, list) or not files:
        return JSONResponse({"error": "没有收到文件"}, status_code=400)
    entries = parse_files_payload(files)
    if not entries:
        return JSONResponse({"error": "没有可识别的文件（agentx-summary.json / trajectory.jsonl）"},
                            status_code=400)
    return await import_static(entries, str((body or {}).get("epoch") or "").strip(), "static")


def _sse(event, data):
    return "event: %s\ndata: %s\n\n" % (event, json.dumps(data, ensure_ascii=False))


@router.get("/v1/stream")
async def stream(request: Request, session: str = Query(None), epoch: str = Query(None)):
    q = asyncio.Queue(maxsize=RT.cfg.sub_queue)
    RT.st.subscribers.add(q)

    async def gen():
        try:
            burst = [": connected\n\n", ": " + (" " * 2048) + "\n\n"]
            n = 0
            if RT.store is not None:
                for t in RT.store.replay_traces(session=session, epoch=epoch,
                                                limit=RT.cfg.replay_max):
                    payload = t["payload"]
                    # Old agentx traces lack started_at/ended_at; rebuild them from
                    # events when available so the overview shows real timings.
                    if (t["kind"] == "trajectory" and isinstance(payload, dict)
                            and payload.get("started_at") is None
                            and not payload.get("steps")
                            and t["session"] and RT.store.list_events(t["epoch"], t["session"])):
                        try:
                            payload = materialize_attempt(t["epoch"], t["session"])
                        except Exception:
                            RT.st.metrics["processing_errors"] += 1
                    burst.append(_sse("ingest", {"session": t["session"], "kind": t["kind"],
                                                 "seq": t["seq"], "epoch": t["epoch"],
                                                 "replay": True,
                                                 "text": json.dumps(payload,
                                                                    ensure_ascii=False)}))
                    n += 1
            if n == 0:
                for sid, s in list(RT.st.sessions.items()):
                    if session and sid != session:
                        continue
                    if epoch and s.get("epoch") != epoch:
                        continue
                    for b in list(s["batches"]):
                        if n >= RT.cfg.replay_max:
                            break
                        burst.append(_sse("ingest", {"session": sid, "kind": b["kind"],
                                                     "seq": b["seq"], "epoch": s.get("epoch"),
                                                     "replay": True,
                                                     "text": json.dumps(b["data"], ensure_ascii=False)}))
                        n += 1
            # Empty replay: tell the client explicitly instead of showing a blank page.
            if n == 0:
                burst.append(_sse("replay_empty", {"epoch": epoch, "session": session}))
            yield "".join(burst)
            while True:
                try:
                    evt = await asyncio.wait_for(q.get(), timeout=5)
                    yield _sse("ingest", evt)
                except asyncio.TimeoutError:
                    yield ": ping\n\n"
        finally:
            RT.st.subscribers.discard(q)

    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache, no-transform",
                                      "Connection": "keep-alive", "X-Accel-Buffering": "no"})


@router.get("/v1/sessions")
async def list_sessions(epoch: str = Query(None)):
    if RT.store is not None:
        return {"sessions": [{"id": r["session"], "epoch": r["epoch"], "kind": r["kind"],
                              "count": r["count"], "firstAt": r["first_at"],
                              "updatedAt": r["updated_at"], "stats": r["stats"]}
                             for r in RT.store.list_sessions(epoch)]}
    return {"sessions": [{"id": s["id"], "epoch": s.get("epoch"), "kind": s["kind"],
                          "count": s["count"], "firstAt": s.get("firstAt"),
                          "updatedAt": s.get("updatedAt"), "stats": s.get("stats")}
                         for s in RT.st.sessions.values()]}


@router.get("/v1/sessions/{sid}")
async def get_session(sid: str, epoch: str = Query(None),
                      limit: int = Query(200, ge=1, le=1000),
                      offset: int = Query(0, ge=0)):
    if RT.store is not None:
        ep = epoch or RT.store.latest_session_epoch(sid)
        row = RT.store.get_session(ep, sid) if ep else None
        if row:
            total = RT.store.count_traces(ep, sid)
            traces = RT.store.list_traces(ep, sid, limit=limit, offset=offset)
            return {"id": sid, "epoch": ep, "kind": row["kind"], "count": row["count"],
                    "firstAt": row["first_at"], "updatedAt": row["updated_at"],
                    "stats": row["stats"], "total": total, "limit": limit,
                    "offset": offset, "hasMore": offset + len(traces) < total,
                    "batches": [{"seq": t["seq"], "kind": t["kind"], "data": t["payload"]}
                                for t in traces]}
    s = RT.st.sessions.get(sid)
    if not s:
        return JSONResponse({"error": "not found"}, status_code=404)
    all_batches = list(s["batches"])
    total = len(all_batches)
    batches = all_batches[offset:offset + limit]
    return {"id": s["id"], "epoch": s.get("epoch"), "kind": s["kind"], "count": s["count"],
            "firstAt": s.get("firstAt"), "updatedAt": s.get("updatedAt"), "stats": s.get("stats"),
            "total": total, "limit": limit, "offset": offset,
            "hasMore": offset + len(batches) < total,
            "batches": [{"seq": b["seq"], "kind": b["kind"], "data": b["data"]} for b in batches]}


@router.delete("/v1/sessions/{sid}")
async def del_session(sid: str, request: Request, epoch: str = Query(None)):
    if not authorized(request):
        return unauthorized()
    RT.st.sessions.pop(sid, None)
    RT.st.seen.pop(sid, None)
    if RT.store is not None:
        RT.store.delete_session(sid, epoch)
    return {"ok": True}


@router.get("/metrics")
async def metrics():
    m = RT.st.metrics
    try:
        spool_depth = sum(1 for p in spool_dir().glob("*.ndjson")
                          if p.name != "dead-letter.ndjson")
    except Exception:
        spool_depth = -1
    body = "\n".join([
        f"trace_received_lines_total {m['received_lines']}",
        f"trace_accepted_lines_total {m['accepted']}",
        f"trace_deduped_lines_total {m['deduped']}",
        f"trace_sampled_dropped_total {m['sampled_drop']}",
        f"trace_rejected_429_total {m['rejected_429']}",
        f"trace_bad_lines_total {m['bad_lines']}",
        f"trace_broadcasts_total {m['broadcasts']}",
        f"trace_unknown_kind_lines_total {m['unknown_kind_lines']}",
        f"trace_unknown_format_lines_total {m['unknown_format_lines']}",
        f"trace_processing_errors_total {m['processing_errors']}",
        f"trace_dead_letter_total {m['dead_letter_lines']}",
        f"trace_events_accepted_total {m['events_accepted']}",
        f"trace_outcomes_accepted_total {m['outcomes_accepted']}",
        f"trace_unknown_event_lines_total {m['unknown_event_lines']}",
        f"trace_db_errors_total {m['db_errors']}",
        f"trace_sse_dropped_total {m['sse_dropped']}",
        f"trace_retention_purged_epochs_total {m['retention_purged_epochs']}",
        f"trace_spool_depth {spool_depth}",
        f"trace_queue_depth {RT.st.queue.qsize()}",
        f"trace_sse_clients {len(RT.st.subscribers)}",
        f"trace_sessions {len(RT.st.sessions)}",
        f"trace_llm_calls_total {LLM.STATS['calls']}",
        f"trace_llm_cache_hits_total {LLM.STATS['cache_hits']}",
        f"trace_llm_failures_total {LLM.STATS['failures']}",
        f"trace_llm_dropped_findings_total {LLM.STATS['dropped']}",
    ]) + "\n"
    return PlainTextResponse(body)


@router.get("/healthz")
async def healthz():
    return {"ok": True, "sessions": len(RT.st.sessions), "clients": len(RT.st.subscribers),
            "db": RT.cfg.db if RT.store is not None else None, "spool": RT.cfg.spool}
