function setTab(t){TAB=t;document.querySelectorAll(".tab").forEach(b=>b.classList.toggle("on",b.dataset.t===t));document.querySelectorAll(".pane").forEach(p=>p.classList.toggle("on",p.id==="pane-"+t));
  // AI analysis targets the selected trajectory and only makes sense on the Trajectory tab.
  const ab=$("#analyze");ab.disabled=(t!=="traj");ab.title=(t==="traj")?"":"AI 分析作用于当前选中的轨迹，请先切到轨迹标签页";
  // The tab goes into the hash so a refresh, or a server redirect to another epoch, keeps the same page.
  if(tabFromHash()!==t){try{history.replaceState(null,"",location.pathname+location.search+"#"+t);}catch(e){}}
  updateMeta();if(t==="fb")loadFeedback();}
const TABS=["traj","met","fb"];
function tabFromHash(){
  let t=String(location.hash||"").replace(/^#\/?/,"");
  // Legacy #inf / #hw links map to #met so bookmarked URLs don't land on an empty page.
  if(t==="inf"||t==="hw")t="met";
  return TABS.includes(t)?t:null;
}
document.getElementById("tabs").onclick=e=>{const b=e.target.closest(".tab");if(b){AUTO_TAB=false;setTab(b.dataset.t);}};
document.getElementById("trajList").onclick=e=>{const b=e.target.closest(".trajitem");if(!b)return;selectTrace(+b.dataset.i);renderNav();};
document.getElementById("expandAll").onclick=()=>{COLLAPSED.clear();render();};
document.getElementById("collapseAll").onclick=()=>{ROWS.forEach(r=>{if(r.hasChildren)COLLAPSED.add(r.id);});render();};
document.getElementById("resetZoom").onclick=()=>{VS=DATA0;VE=DATA1;render();};
function ingest(text,live){
  let docs;try{docs=parseDocs(text);}catch(e){if(!live)toast("JSON 解析失败："+e.message);return false;}
  let traj=null,sum=null;
  docs.forEach(o=>{const c=classifyDoc(o);if(c.kind==="trajectory")traj={o,c};else if(c.kind==="summary")sum={o,c};});
  if(!traj&&!sum){if(!live)toast("无法识别的文档：需要 ATIF 轨迹或 AgentX 汇总数据。");return false;}
  if(traj){ATTEMPT.trajKey=traj.c.attemptKey||null;addTrace(traj.o);}
  if(sum){const sk=sumKeyOf(sum.o);SUMMARIES.set(sk,sum.o);
    SUM_META.set(sk,{attempt:sum.c.attemptKey||null,conc:concOf(sum.o)});
    ATTEMPT.sumKey=sum.c.attemptKey||null;METRICS_RAW=sum.o;METRICS=buildFromSummaries([...SUMMARIES.values()]);renderMetrics();updateProfMode();
    // Summary-only pushes skip render(), so refresh the header here or it stays at "metrics not reported".
    if(TAB==="met")updateMeta();}
  ATTEMPT.warn=ATTEMPT.trajKey&&ATTEMPT.sumKey&&ATTEMPT.trajKey!==ATTEMPT.sumKey?'attempt 不一致：轨迹 "'+ATTEMPT.trajKey+'" vs 汇总 "'+ATTEMPT.sumKey+'"':null;
  ATTEMPT.key=ATTEMPT.sumKey||ATTEMPT.trajKey||null;
  // Live pushes arrive every second: never steal the user's tab while subscribed, or Feedback can never be viewed.
  if(!live){if(sum&&!traj)setTab("met");else if(traj&&!sum)setTab("traj");else setTab(TAB);}
  return true;
}
function loadFiles(files){
  const list=[...files];if(!list.length)return;
  list.forEach(f=>{const rd=new FileReader();rd.onload=()=>ingest(rd.result);rd.onerror=()=>toast("无法读取 "+f.name);rd.readAsText(f);});
}
// Open directory: the native picker only exposes a folder name, so the Collector opens the
// desktop dialog itself and returns an absolute path. Any directory on the host can be imported.
$("#openDir").onclick=async()=>{
  toast("请在弹出的对话框中选择目录…");
  try{
    const r=await fetch("/v1/pick-dir",{method:"POST"});
    const j=await r.json();
    if(!r.ok)throw new Error(j.error||("HTTP "+r.status));
    if(j.cancelled){toast("已取消");return;}
    importDir({dir:j.dir},j.dir);
  }catch(e){
    // No desktop dialog (headless/remote host): fall back to a typed absolute path.
    const dir=prompt("服务器上的 run 目录绝对路径：","");
    if(dir&&dir.trim())importDir({dir:dir.trim()},dir.trim());
    else toast("打开失败："+e.message);
  }
};
async function importDir(body,label){
  toast("正在导入 "+label+"…");
  try{
    const r=await fetch("/v1/load-dir",{method:"POST",headers:{"content-type":"application/json"},
      body:JSON.stringify(body)});
    const j=await r.json();
    if(!r.ok)throw new Error(j.error||("HTTP "+r.status));
    // On a re-import summary/trajectory are both 0 but skipped>0, so the directory can still be opened directly.
    if(!j.summary&&!j.trajectory&&!j.skipped){toast("目录里没有可识别文件");return;}
    toast(j.summary||j.trajectory?`已导入 ${j.summary} 份汇总 / ${j.trajectory} 条轨迹，正在打开…`:`已存在，跳过 ${j.skipped} 个文件，正在刷新…`);
    openEpoch(j);
  }catch(e){toast("打开失败："+e.message);}
}
// Manual export: write the epoch's deterministic results and analysis to <run>/analysis/ for downstream RSI.
async function exportFiles(){
  if(!CUR_EPOCH){toast("先选择一个 epoch");return;}
  toast("正在导出 "+CUR_EPOCH+"…");
  try{
    const r=await fetch("/v1/export-files?epoch="+encodeURIComponent(CUR_EPOCH));
    const j=await r.json();
    if(!r.ok)throw new Error(j.error||("HTTP "+r.status));
    toast(j.exported?`已导出到 ${CUR_EPOCH}/analysis/`:"没找到该 run 的目录，导出跳过");
  }catch(e){toast("导出失败："+e.message);}
}
// Snapshot export: let the browser download a single HTML file; no data assembly on the frontend.
$("#snapBtn").onclick=()=>{
  if(!CUR_EPOCH){toast("先选择一个 epoch");return;}
  location.href="/v1/export?epoch="+encodeURIComponent(CUR_EPOCH);
};
function openEpoch(j){
  const u=new URL(location.href);u.searchParams.set("epoch",j.epoch);
  // Re-importing the same epoch replaces to the identical URL, which triggers no navigation and leaves "opening…" stuck;
  // reload explicitly to both complete the jump and render the newly added files.
  if(j.epoch===CUR_EPOCH){location.reload();return;}
  location.replace(u.toString());
}
document.addEventListener("dragover",e=>e.preventDefault());
document.addEventListener("drop",e=>{e.preventDefault();loadFiles(e.dataTransfer.files);});
const ANALYZE_ENDPOINT="/v1/analyze";
function buildDigest(){
  const fm=totalsOf();
  const steps=STEPS.map(st=>{const o=T.get(st),a=(st.extra&&st.extra.ancestry)||{},inv=(st.extra&&st.extra.invocation)||{},m=st.metrics||{};
    return{step_id:st.step_id,fn:a.function_name||st.source,parent:a.parent_id||null,source:st.source,dur:realDur(o),status:inv.status||null,prompt_tokens:m.prompt_tokens||null,completion_tokens:m.completion_tokens||null,cached_tokens:m.cached_tokens||null,msg:trunc(st.message||""),error:inv.status&&inv.status!=="ok"?String(inv.error||inv.status):null};});
  const md=METRICS_RAW||{},p=md.profiling||md.profiling_metrics||{},inf={};
  ["ttft","itl","requestLatency","inputThroughput","outputThroughput"].forEach(k=>{if(p[k]&&p[k].mean!=null)inf[k]={mean:p[k].mean,p50:p[k].p50,p95:p[k].p95,p99:p[k].p99};});
  const srcs=(md.telemetry&&md.telemetry.sources)||[];
  const pick=(src,keys)=>{if(!src)return null;const m=seriesMap(src),o={};keys.forEach(k=>{if(m[k]&&m[k].mean!=null)o[k]={mean:m[k].mean,max:m[k].max,total:m[k].total};});return Object.keys(o).length?o:null;};
  return{attempt:activeAttempt(),totals:fm,steps,inference:inf,
    cache:pick(srcs.find(x=>x.kind==="vllm"),["vllm:kv_cache_usage_perc","vllm:prefix_cache_queries","vllm:prefix_cache_hits"]),
    hardware:pick(srcs.find(x=>x.kind==="ascend"),["ascend_npu_utilization_percent","ascend_npu_aicore_utilization_percent","ascend_npu_hbm_usage_percent","ascend_npu_hbm_bandwidth_percent","ascend_npu_power_watts","ascend_npu_temperature_celsius"])};
}
function heuristicFindings(d){
  const out=[],total=d.steps.reduce((a,s)=>a+(s.dur||0),0)||1;
  d.steps.forEach(s=>{if(s.error)out.push({severity:"high",category:"error",title:s.fn+" 执行失败",evidence:{step_id:s.step_id},detail:String(s.error),recommendation:"检查工具依赖与重试策略"});
    else if(s.dur!=null&&s.dur/total>=0.3)out.push({severity:"high",category:"bottleneck",title:s.fn+" 占全程 "+(s.dur/total*100).toFixed(0)+"%",evidence:{step_id:s.step_id},detail:"该步 "+s.dur.toFixed(2)+"s / 总 "+total.toFixed(2)+"s",recommendation:"考虑拆分或并行化该步骤"});});
  const c=d.cache;if(c&&c["vllm:prefix_cache_queries"]&&c["vllm:prefix_cache_hits"]){const q=c["vllm:prefix_cache_queries"].total,h=c["vllm:prefix_cache_hits"].total;if(q>0&&h/q<0.5)out.push({severity:"medium",category:"cache",title:"prefix cache 命中率仅 "+(h/q*100).toFixed(0)+"%",evidence:{metric:"vllm:prefix_cache_hits"},detail:h+"/"+q+" tokens",recommendation:"统一 system prompt 前缀以提高复用"});}
  const hw=d.hardware||{},nu=hw["ascend_npu_utilization_percent"];
  if(nu&&nu.mean!=null&&nu.mean<30)out.push({severity:"medium",category:"utilization",title:"NPU 利用率偏低 (mean "+nu.mean+"%)",evidence:{metric:"ascend_npu_utilization_percent"},detail:"max "+nu.max+"%",recommendation:"提高并发 batch 以打满算力"});
  const ttft=d.inference&&d.inference.ttft;if(ttft&&ttft.p95!=null&&ttft.p95>150)out.push({severity:"medium",category:"latency",title:"TTFT p95 偏高 ("+ttft.p95+"ms)",evidence:{metric:"ttft.p95"},detail:"prefill 阶段可能排队",recommendation:"检查 prefill 并发 / chunked prefill / KV cache 冷启动"});
  if(!out.length)out.push({severity:"low",category:"summary",title:"未发现明显异常",detail:"轨迹与指标均在合理范围",recommendation:"—"});
  return{summary:"启发式分析（离线模式，未调用 LLM）",scores:null,findings:out};
}
async function runAnalysis(){
  const body=$("#aibody");$("#aipanel").classList.add("on");$("#aiback").classList.add("on");body.innerHTML='<div class="kv"><span class="spin"></span>正在分析当前轨迹…</div>';
  // The panel analyzes only the current trajectory (digest level); epoch-level analysis lives on the Feedback page.
  const digest=buildDigest();
  if(!ANALYZE_ENDPOINT){renderFindings(heuristicFindings(digest));return;}
  try{
    const r=await fetch(ANALYZE_ENDPOINT,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({digest,epoch:CUR_EPOCH})});
    if(!r.ok)throw new Error("HTTP "+r.status);
    renderFindings(await r.json());
  }catch(e){
    const h=heuristicFindings(digest);h.llm_error="后端分析不可用："+e.message+"（已回退本地启发式）";
    renderFindings(h);
  }
}
const SEVRANK={high:0,medium:1,low:2};
function renderFindings(r){
  const fnds=(r.findings||[]).slice().sort((a,b)=>(SEVRANK[a.severity]??9)-(SEVRANK[b.severity]??9));
  let h='';
  if(r.source){const label=r.source==="llm"?'LLM · 轨迹级 · '+esc(r.model||"?"):"规则分析";
    h+='<div class="kv" style="opacity:.75">来源：'+label+(r.dropped_findings?'（丢弃证据不实的条目 '+r.dropped_findings+' 条）':'')+'</div>';}
  h+='<div class="kv">'+esc(r.summary||"")+'</div>';
  if(r.llm_error)h+='<div class="kv" style="color:#f85149">LLM 调用失败：'+esc(r.llm_error)+'</div>';
  if(r.scores)h+='<div class="aiscore">'+Object.entries(r.scores).map(([k,v])=>'<div class="stat"><span>'+esc(k)+'</span><b>'+(v*100).toFixed(0)+'%</b></div>').join('')+'</div>';
  h+=fnds.map(x=>'<div class="fnd"><span class="sev '+esc(x.severity||"low")+'">'+esc(x.severity||"low")+'</span> <span class="kv" style="display:inline">'+esc(x.category||"")+'</span><div class="t">'+esc(x.title||"")+'</div>'+(x.detail?'<div class="kv">'+esc(x.detail)+'</div>':'')+(x.recommendation?'<div class="kv">→ '+esc(x.recommendation)+'</div>':'')+evHTML(x.evidence)+'</div>').join('');
  $("#aibody").innerHTML=h;
}
function evHTML(ev){if(!ev)return"";if(ev.step_id!=null){const known=STEPS.some(s=>String(s.step_id)===String(ev.step_id));return'<div class="ev">'+(known?'<button data-step="'+esc(ev.step_id)+'">定位 step '+esc(stepNo(ev.step_id))+'</button>':'<span class="kv">evidence: step '+esc(stepNo(ev.step_id))+'（不在当前轨迹）</span>')+'</div>';}if(ev.metric)return'<div class="ev kv">evidence: '+esc(ev.metric)+'</div>';return"";}

// ---- Evidence navigation for Feedback page LLM findings ----
// Evidence metric names are short in profiling facts and long in hardware samples, so merge the aliases here.
const METRIC_ALIAS={
  ttft_p50:["ttft_p50","ttft"],ttft_p95:["ttft_p95","ttft"],ttft_mean:["ttft_mean","ttft"],
  "ttft.p95":["ttft_p95","ttft"],itl_mean:["itl_mean","itl"],latency_p95:["latency_p95","requestLatency"],
  throughput:["throughput"],interactivity:["interactivity"],
  cache_hit:["cache_hit"],"vllm:prefix_cache_hits":["cache_hit"],
  npu_util:["npu_util","ascend_npu_utilization_percent"],
  aicore_util:["aicore_util","ascend_npu_aicore_utilization_percent"],
  hbm_usage:["hbm_usage","ascend_npu_hbm_usage_percent"],
  temperature:["temperature","ascend_npu_temperature_celsius"],
  warmup_ttft_p95:["warmup_ttft_p95"],requests:["requests"],
  input_tokens:["input_tokens"],output_tokens:["output_tokens"],duration_s:["duration_s"],
  success_rate:["success_rate"],tasks:["tasks"],p50_latency_ms:["p50_latency_ms"],
  p95_latency_ms:["p95_latency_ms"],cost_usd:["cost_usd"],cost_per_task:["cost_usd"],
  steps_mean:["steps_mean"],tokens:["tokens"]
};
// Metric keys locatable on the panel: both short names and hardware long names count as known.
const METRIC_KEYS=new Set(Object.keys(METRIC_ALIAS));
Object.values(METRIC_ALIAS).forEach(list=>list.forEach(k=>METRIC_KEYS.add(k)));
function evChips(ev){
  const out=[];
  if(ev.step_id!=null){
    out.push(traceOfStep(ev.step_id)>=0
      ?'<button class="copybtn" data-loc-step="'+esc(ev.step_id)+'">定位 step '+esc(stepNo(ev.step_id))+'</button>'
      :'<span class="kv">evidence: step '+esc(stepNo(ev.step_id))+'（不在本 epoch）</span>');
  }
  if(ev.session!=null){
    // profiling/agentx only have an attempt lifecycle and no replayable steps, so session cannot jump to a trajectory.
    const i=traceOfSession(ev.session);
    out.push(i>=0&&traceHasSteps(i)
      ?'<button class="copybtn" data-loc-session="'+esc(ev.session)+'">定位轨迹</button>'
      :'<span class="kv">session '+esc(ev.session)+'（无执行轨迹）</span>');
  }
  if(ev.metric!=null){
    // Only render a button when the metric actually maps to a row, avoiding dead links that just say "not found".
    out.push(METRIC_KEYS.has(ev.metric)
      ?'<button class="copybtn" data-loc-metric="'+esc(ev.metric)+'">定位 '+esc(trunc(String(ev.metric)))+'</button>'
      :'<span class="kv">evidence: '+esc(ev.metric)+'（未在面板展示）</span>');
  }
  return out;
}
function fbEvHTML(ev){
  const out=ev?evChips(ev):[];
  return out.length?'<div class="ev">'+out.join("")+'</div>':"";
}
// Rule diagnostic evidence carries counts, samples and other fields beyond the anchors: buttons first, the rest verbatim.
function sigEvHTML(ev){
  if(!ev||typeof ev!=="object")return"";
  const out=evChips(ev);
  const rest={};
  Object.keys(ev).forEach(k=>{
    if(ev[k]!=null&&k!=="step_id"&&k!=="session"&&k!=="metric")rest[k]=ev[k];
  });
  const t=evText(rest);
  if(!out.length&&!t)return"";
  return '<div class="ev">'+out.join("")+(t?'<span class="kv" style="margin-left:8px">evidence: '+esc(t)+'</span>':"")+'</div>';
}
function traceOfSession(s){return TRACES.findIndex(t=>String(t.session)===String(s));}
function traceHasSteps(i){
  let n=0;
  walkAll((TRACES[i]||{}).traj||{},()=>{n++;});
  return n>0;
}
function traceOfStep(id){
  for(let i=0;i<TRACES.length;i++){
    let hit=false;
    walkAll(TRACES[i].traj||{},st=>{if(!hit&&String(st.step_id)===String(id))hit=true;});
    if(hit)return i;
  }
  return -1;
}
function locateStep(id){
  const i=traceOfStep(id);
  if(i<0){toast("step "+stepNo(id)+" 不在本 epoch 的轨迹里");return;}
  if(i!==ACTIVE)selectTrace(i);
  gotoStep(id);
}
function locateSession(s){
  const i=traceOfSession(s);
  if(i<0){toast("轨迹 "+s+" 尚未回放，可能还在传输");return;}
  selectTrace(i);setTab("traj");
}
function flashEl(el){
  if(!el)return;
  el.scrollIntoView({block:"center",behavior:"smooth"});
  el.style.outline="2px solid #58a6ff";el.style.outlineOffset="2px";el.style.borderRadius="4px";
  setTimeout(()=>{el.style.outline="";el.style.outlineOffset="";el.style.borderRadius="";},1600);
}
function locateMetric(metric){
  const names=METRIC_ALIAS[metric]||[String(metric)];
  const sel=n=>'[data-metric="'+String(n).replace(/"/g,'\\"')+'"]';
  // Current-epoch metrics live on the Feedback page itself: stay here and scroll to the matching row.
  for(const n of names){const el=document.querySelector("#fbpane "+sel(n));if(el){flashEl(el);return;}}
  // Inference / hardware metrics live on the Metrics tab.
  for(const n of names){const el=document.querySelector("#metpane "+sel(n));if(el){setTab("met");flashEl(el);return;}}
  setTab("met");toast("指标页没有 "+metric+" 对应行");
}
function gotoStep(id){const st=STEPS.find(s=>String(s.step_id)===String(id));if(!st)return;const r=ROWS.find(x=>x.step===st);if(!r)return;const byId=new Map(ROWS.map(x=>[x.id,x]));let p=r.parent;while(p!=null){COLLAPSED.delete(p);const pr=byId.get(p);p=pr?pr.parent:null;}setTab("traj");render();const els=document.querySelectorAll('.wf-row[data-id="'+r.id+'"]');if(els.length){els[0].scrollIntoView({block:"center"});els.forEach(el=>{el.style.outline="2px solid #58a6ff";setTimeout(()=>el.style.outline="",1500);});}}
$("#analyze").onclick=runAnalysis;
$("#aiClose").onclick=()=>{$("#aipanel").classList.remove("on");$("#aiback").classList.remove("on");};
$("#aiback").onclick=()=>{$("#aipanel").classList.remove("on");$("#aiback").classList.remove("on");};
$("#aibody").onclick=e=>{const b=e.target.closest("button[data-step]");if(b)gotoStep(b.dataset.step);};
// Empty SSE replay: the epoch has no trajectory at all (happens when evaluation fails and only outcome is stored),
// so show an explicit hint; once a trajectory arrives, renderNav replaces this placeholder.
window.__emptyEpoch=function(tag){if(!TRACES.length)$("#trajList").innerHTML=emptyHTML("该范围没有轨迹数据","epoch "+esc(tag||"")+" 可能因评测失败未产生任何 step（只有 outcome 记录）");};
// Inline data injected by /v1/export: its presence means snapshot mode, with no network requests at all.
const SNAP=window.__SNAPSHOT__||null;
let SNAP_HEAD="";  // Fixed snapshot header text; updateMeta keeps it when switching tabs
function bootstrap(){
  if(SNAP){
    document.body.classList.add("snap");
    CUR_EPOCH=SNAP.epoch||"";
    // Raw trajectories go through the same ingest path as SSE replay, rebuilding waterfall/list/inference metrics offline.
    const docs=SNAP.docs||[];
    docs.forEach(d=>{try{ingest(JSON.stringify(d),false);}catch(e){console.warn("snapshot doc skipped",e);}});
    setTab(tabFromHash()||(docs.length?"traj":"fb"));
    const ab=document.getElementById("analyze");
    if(ab){ab.disabled=true;ab.title="快照为离线数据，不能触发在线分析";}
    // The header states snapshot identity (epoch, export time, rule version) so archived runs stay reconcilable.
    const bits=["离线快照 · epoch "+(SNAP.epoch||"")];
    if(SNAP.exported_at)bits.push("导出于 "+SNAP.exported_at);
    if(SNAP.rules_version!=null)bits.push("rules v"+SNAP.rules_version);
    if(SNAP.schema_version)bits.push(SNAP.schema_version);
    bits.push(docs.length?("内联 "+docs.length+" 条轨迹"):"仅反馈页（未内联轨迹）");
    SNAP_HEAD=bits.join(" · ");
    updateMeta();
    return;
  }
  restoreVars();
  renderMetrics();
  const ht=tabFromHash();
  // Only auto-select a tab by data type when the URL specifies none.
  AUTO_TAB=!ht;
  setTab(ht||"traj");
  loadEpochs();
  const want=new URLSearchParams(location.search).get("session");
  if(want){PENDING_SESSION=want;const t0=setInterval(()=>{
    const i=TRACES.findIndex(t=>t.session===want);
    if(i>=0){selectTrace(i);PENDING_SESSION=null;clearInterval(t0);}
  },200);setTimeout(()=>{PENDING_SESSION=null;},8000);}
}
bootstrap();
