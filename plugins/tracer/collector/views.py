"""HTML rendering: the live dashboard and the offline single-file snapshot."""
from __future__ import annotations

import json
import time
from pathlib import Path

from fastapi.responses import HTMLResponse, JSONResponse

from runtime import RT

_CSS_SLOT = "<!-- VIEW_CSS -->"
_JS_SLOT = "<!-- VIEW_JS -->"

# Loaded in order into one script block, so globals stay shared.
JS_FILES = ("core.js", "traj.js", "metrics.js", "feedback.js", "app.js")

LIVE_BOOTSTRAP = """
<script>
(function(){
  if(!window.EventSource) return;
  var qs=new URLSearchParams(location.search);
  var session=qs.get("session")||"";
  var epoch=qs.get("epoch")||"";
  var n=0;
  var es=null;
  var hideT=null;
  var pill=document.createElement("div");
  pill.style.cssText="position:fixed;right:12px;bottom:12px;z-index:99999;padding:4px 10px;border-radius:12px;font:13px/1.6 ui-monospace,Menlo,monospace;background:#21262d;color:#8b949e;border:1px solid #30363d;display:none;transition:opacity .5s";
  pill.title="SSE 实时推送：评测运行中的事件会即时追加到页面，无需刷新";
  document.body.appendChild(pill);
  // The badge only appears for live events; replay and history stay silent.
  function showPill(txt,color){pill.textContent=txt;pill.style.color=color;pill.style.display="block";pill.style.opacity="1";clearTimeout(hideT);hideT=setTimeout(function(){pill.style.opacity="0";},8000);}
  function tag(){return epoch||session||"全部";}
  function handle(e){
    var m;try{m=JSON.parse(e.data);}catch(err){console.warn("[live] bad json",err);return;}
    if(epoch&&m.epoch!==epoch){console.log("[live] skip epoch",m.epoch,"current",epoch);return;}
    if(m.text!=null&&typeof window.ingest==="function"){try{window.ingest(m.text,true);}catch(err){console.warn("[live] ingest failed",err);}}
    if(m.replay)return;
    n++;
    var steps=typeof window.__stepCount==="function"?window.__stepCount():null;
    showPill("\\u25cf 实时推送 \\u00b7 "+tag()+(steps==null?" \\u00b7 新事件 #"+n:" \\u00b7 步骤 "+steps),"#3fb950");
    console.log("[live] event #"+n,m.kind,m.session);
  }
  function connect(){
    if(es){try{es.close();}catch(err){}es=null;}
    n=0;
    // Replay always covers the whole epoch; session only restores the selection,
    // otherwise a refresh would leave a single trajectory in the list.
    var p=[];
    if(epoch)p.push("epoch="+encodeURIComponent(epoch));
    var url="/v1/stream"+(p.length?"?"+p.join("&"):"");
    es=new EventSource(url);
    es.addEventListener("open",function(){console.log("[live] connected",url);});
    es.addEventListener("error",function(){showPill("\\u25cb 实时推送：重连中…","#d29922");console.log("[live] reconnecting");});
    es.addEventListener("ingest",handle);
    es.addEventListener("replay_empty",function(){if(typeof window.__emptyEpoch==="function")window.__emptyEpoch(tag());});
    es.onmessage=handle;
  }
  window.__liveConnect=function(ep){epoch=ep||"";connect();};
  window.__clearSession=function(){session="";};
  // Follow the newest epoch unless the user picked one explicitly.
  function pollLatest(){
    if(session)return;
    fetch("/v1/epochs",{cache:"no-store"}).then(function(r){return r.json();}).then(function(d){
      var latest=d.epochs&&d.epochs[0]&&d.epochs[0].epoch;
      if(!latest||latest===epoch)return;
      if(typeof window.__followLatest!=="function"||!window.__followLatest())return;
      if(typeof window.__setEpoch!=="function")return;
      epoch=latest;window.__setEpoch(latest,true);
    }).catch(function(){});
  }
  setInterval(pollLatest,5000);
  if(epoch){connect();return;}
  // Opened with ?session= only: resolve its epoch before connecting.
  if(session){
    fetch("/v1/sessions",{cache:"no-store"}).then(function(r){return r.json();}).then(function(d){
      var arr=d.sessions||[];
      for(var i=0;i<arr.length;i++){if(arr[i].id===session&&arr[i].epoch){epoch=arr[i].epoch;break;}}
      if(typeof window.__syncEpoch==="function")window.__syncEpoch(epoch);
      connect();
    }).catch(function(){connect();});
    return;
  }
  fetch("/v1/epochs").then(function(r){return r.json();}).then(function(d){
    epoch=(d.epochs&&d.epochs[0]&&d.epochs[0].epoch)||"";
    if(typeof window.__syncEpoch==="function")window.__syncEpoch(epoch);
    connect();
  }).catch(function(){connect();});
})();
</script>"""

_PAGE_CACHE = {"html": None, "stamp": None}


def _view_dir() -> Path:
    p = Path(RT.cfg.view)
    return p if p.is_dir() else p.parent


def _source_files():
    d = _view_dir()
    return [d / "index.html", d / "view.css", *[d / name for name in JS_FILES]]


def _stamp(paths):
    return tuple(p.stat().st_mtime_ns for p in paths)


def _compose(snapshot_script=""):
    d = _view_dir()
    html = (d / "index.html").read_text(encoding="utf-8")
    html = html.replace(_CSS_SLOT, "<style>\n%s\n</style>"
                        % (d / "view.css").read_text(encoding="utf-8"))
    js = "\n".join((d / name).read_text(encoding="utf-8") for name in JS_FILES)
    html = html.replace(_JS_SLOT, "%s<script>\n%s\n</script>" % (snapshot_script, js))
    return html


def render_live_page():
    paths = _source_files()
    stamp = _stamp(paths)
    if _PAGE_CACHE["html"] is None or _PAGE_CACHE["stamp"] != stamp:
        html = _compose()
        html = (html.replace("</body>", LIVE_BOOTSTRAP + "\n</body>")
                if "</body>" in html else html + LIVE_BOOTSTRAP)
        _PAGE_CACHE["html"] = html
        _PAGE_CACHE["stamp"] = stamp
    return _PAGE_CACHE["html"]


def render_snapshot(snapshot):
    # "</" is escaped so payload data cannot close the script block early.
    payload = json.dumps(snapshot, ensure_ascii=False).replace("</", "<\\/")
    return _compose("<script>window.__SNAPSHOT__=%s;</script>\n" % payload)


async def index():
    return HTMLResponse(render_live_page(), headers={"Cache-Control": "no-store"})


async def export_snapshot(response, epoch, traces=1):
    """Single-file HTML snapshot with feedback and trace payloads inlined."""
    from routes_query import get_feedback

    if RT.store is None:
        return JSONResponse({"error": "store disabled"}, status_code=503)
    fb = await get_feedback(response, epoch=epoch, target=None)
    if not isinstance(fb, dict):
        return fb
    cn = fb.get("conclusion") or {}
    snapshot = {
        "epoch": fb.get("epoch") or epoch,
        "exported_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "schema_version": cn.get("schema_version"),
        "rules_version": (cn.get("engine") or {}).get("rules_version"),
        "feedback": fb,
    }
    if traces:
        snapshot["docs"] = [row["payload"] for row in RT.store.list_traces(epoch=snapshot["epoch"])]
    short = str(snapshot["epoch"])[:8]
    return HTMLResponse(render_snapshot(snapshot), headers={
        "Cache-Control": "no-store",
        "Content-Disposition": 'attachment; filename="tracer-%s-snapshot.html"' % short,
    })
