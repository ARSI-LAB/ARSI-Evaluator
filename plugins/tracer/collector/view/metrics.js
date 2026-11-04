function buildFromSummary(s){
  const inf={title:"推理指标",cards:[],bars:[]},hw={title:"硬件指标",cards:[],bars:[]};
  const p=s.profiling||s.profiling_metrics||s.metrics||{};
  const card=(a,l,st,u,key)=>{if(st&&st.mean!=null)a.push({label:l,value:fv(st.mean),unit:u,key,sub:`p50 ${fv(st.p50)} · p95 ${fv(st.p95)} · p99 ${fv(st.p99)}${st.count!=null?" · n="+st.count:""}`});};
  const prof=[];card(prof,"TTFT",p.ttft,"ms","ttft");card(prof,"ITL",p.itl,"ms","itl");card(prof,"Request Latency",p.requestLatency,"ms","requestLatency");
  card(prof,"Input Throughput",p.inputThroughput,"tok/s","inputThroughput");card(prof,"Output Throughput",p.outputThroughput,"tok/s","outputThroughput");
  const srcs=(s.telemetry&&s.telemetry.sources)||[],cache=[];
  const v=srcs.find(x=>x.kind==="vllm");
  if(v){const m=seriesMap(v),kv=m["vllm:kv_cache_usage_perc"]||m["vllm:gpu_cache_usage_perc"];
    if(kv&&kv.mean!=null)cache.push({label:"KV Cache Usage",value:fv(kv.unit==="ratio"?kv.mean*100:kv.mean),unit:"%",sub:`min ${fv(kv.min)} · max ${fv(kv.max)}`});
    const hi=m["vllm:prefix_cache_hits"],qu=m["vllm:prefix_cache_queries"];
    if(hi&&qu&&hi.total!=null&&qu.total>0)cache.push({label:"Prefix Cache Hit Rate",value:fv(hi.total/qu.total*100),unit:"%",key:"cache_hit",sub:`${fv(hi.total)} / ${fv(qu.total)} tokens`});}
  inf.cards.push(...cache,...prof);
  const lit=[];[['TTFT','ttft'],['ITL','itl'],['Req Latency','requestLatency']].forEach(([nm,k])=>{const st=p[k];if(!st)return;['p50','p95','p99'].forEach(key=>{if(st[key]!=null)lit.push({label:nm+' '+key,value:st[key],color:PAL[lit.length%7]});});});
  bars(inf.bars,"Latency percentiles","ms",lit);
  bars(inf.bars,"Throughput","tok/s",[{label:"Input",value:meanOf(p.inputThroughput),color:PAL[0]},{label:"Output",value:meanOf(p.outputThroughput),color:PAL[1]},{label:"Total",value:meanOf(p.totalThroughput),color:PAL[2],key:"throughput"}]);
  const a=srcs.find(x=>x.kind==="ascend");
  if(a){const m=seriesMap(a),push=(l,k,u)=>{const x=m[k];if(x&&x.mean!=null)hw.cards.push({label:l,value:fv(x.mean),unit:u,key:k,sub:`min ${fv(x.min)} · max ${fv(x.max)}`});};
    push("NPU Utilization","ascend_npu_utilization_percent","%");push("AI Core Utilization","ascend_npu_aicore_utilization_percent","%");
    push("HBM Usage","ascend_npu_hbm_usage_percent","%");push("HBM Bandwidth","ascend_npu_hbm_bandwidth_percent","%");
    push("HBM Capacity","ascend_npu_hbm_capacity_megabytes","MB");push("Power","ascend_npu_power_watts","W");push("Temperature","ascend_npu_temperature_celsius","°C");
    bars(hw.bars,"Utilization (mean)","%",[{label:"NPU",value:meanOf(m["ascend_npu_utilization_percent"]),color:PAL[0]},{label:"AI Core",value:meanOf(m["ascend_npu_aicore_utilization_percent"]),color:PAL[4]},{label:"HBM",value:meanOf(m["ascend_npu_hbm_usage_percent"]),color:PAL[1]},{label:"HBM BW",value:meanOf(m["ascend_npu_hbm_bandwidth_percent"]),color:PAL[2]}]);}
  // Measurement trust: when sampling is incomplete or incomparable the numbers still look good but the conclusion is void, so it gets its own block before them
  const L=x=>Array.isArray(x)?x.filter(Boolean):(x?[String(x)]:[]),trust=[];
  if(typeof s.comparable==="boolean")
    trust.push({k:"可比性",v:s.comparable?"可比":"不可比",cls:s.comparable?"ok":"bad",
      d:s.comparable?"":L(s.incomparableReasons).slice(0,3).map(reasonCN).join("；")});
  if(s.upstreamSubmissionValid===false)
    trust.push({k:"上游提交",v:"不合规",cls:"bad",d:L(s.upstreamInvalidReasons).slice(0,3).join("；")});
  // Collection errors are an all-endpoints total: peel them out of each source and show them only once
  const globals=[];
  srcs.forEach(src=>{
    const n=s.telemetry&&s.telemetry.collectionErrors;
    if(typeof n==="number")globals.push(n);
    splitErrors(src.errors).glob.forEach(g=>globals.push(g.n));
  });
  if(globals.length){
    const n=Math.max(...globals);
    trust.push({k:"采集错误",v:n+" 次",cls:"warn",
      d:"全部端点合计，无法归属到具体来源；临时失败后会继续采集，已获得的统计保留"});
  }
  srcs.forEach(src=>{
    const label=src.kind==="vllm"?"vLLM 采样":src.kind==="ascend"?"NPU 采样":((src.kind||"未知")+" 采样");
    const bits=[];
    if(src.deviceId!=null)bits.push("设备 "+src.deviceId);
    if(src.samples!=null)bits.push(fmtNum(src.samples)+" 个采样点");
    const miss=L(src.missingMetrics);
    if(miss.length)bits.push("缺 "+miss.length+" 项指标："+miss.slice(0,3).join("、")+(miss.length>3?" 等":""));
    const own=splitErrors(src.errors).own;
    if(own.length)bits.push(own.length+" 类错误："+own.map(x=>x.text).join("；"));
    trust.push({k:label,v:statusCN(src.status),cls:statusCls(src.status),d:bits.join(" · ")});
  });
  const rc=s.replayCoverage;
  if(rc&&(rc.expectedRequests!=null||rc.complete!=null)){
    const bits=[];
    if(rc.expectedRequests!=null)bits.push("期望 "+rc.expectedRequests+" 条请求");
    if(rc.observedRequests!=null)bits.push("实际 "+rc.observedRequests+" 条");
    if(rc.missingRequests)bits.push("缺失 "+rc.missingRequests);
    if(rc.duplicateRequests)bits.push("重复 "+rc.duplicateRequests);
    if(rc.unexpectedRequests)bits.push("多余 "+rc.unexpectedRequests);
    trust.push({k:"重放覆盖",v:rc.complete?"完整":"不完整",cls:rc.complete?"ok":"bad",d:bits.join(" · ")});
  }
  // Main metrics exclude the warmup period, but the warmup sample count decides how many valid requests the numbers represent, so spell it out
  const wu=(s.warmup||{}).ttft;
  if(wu&&wu.count!=null){
    const bits=["n="+wu.count];
    if(wu.p50!=null)bits.push("TTFT p50 "+secFmt(wu.p50));
    if(wu.p95!=null)bits.push("p95 "+secFmt(wu.p95));
    trust.push({k:"预热段",v:"已剔除",cls:"",key:"warmup_ttft_p95",d:bits.join(" · ")});
  }
  if(trust.length)inf.trust=trust;
  return{inf,hw};
}
// agentx standard emits one summary per concurrency level (c1/c4/c8). A single summary keeps the card layout above;
// multiple summaries switch to a "columns = levels, rows = metrics" table with one shared trust block, so three sets of numbers do not drown each other.
const concOf=s=>{const w=(s&&s.workload)||{},v=w.concurrency!=null?w.concurrency:(s&&s.concurrency);return typeof v==="number"?v:null;};
const sumKeyOf=s=>{const w=(s&&s.workload)||{},c=concOf(s);
  return [w.mode||s.metrics_phase||"single",w.variant||"",c!=null?"c"+c:"single"].join("|");};
function buildFromSummaries(items){
  const list=(items||[]).filter(Boolean);
  if(list.length<=1)return buildFromSummary(list[0]||{});
  const pts=list.slice().sort((a,b)=>{const x=concOf(a),y=concOf(b);
    if(x==null)return 1;if(y==null)return -1;return x-y;});
  const prof=s=>(s&&(s.profiling||s.profiling_metrics||s.metrics))||{};
  const stat=(s,k,f)=>{const x=prof(s)[k];return x&&x[f]!=null?x[f]:null;};
  const label=s=>{const c=concOf(s);return c!=null?"c"+c:"单档";};
  const L=x=>Array.isArray(x)?x.filter(Boolean):(x?[String(x)]:[]);
  const tok=v=>v==null?null:(Math.abs(v)>=1e6?(v/1e6).toFixed(2)+"M":Math.abs(v)>=1e3?(v/1e3).toFixed(1)+"k":String(Math.round(v)));
  // Units move into the row label so cells hold numbers only. Inline mini bars normalize to the row max
  // to compare magnitude across levels; no extra "first vs last" percentage column, because with more
  // levels that derived column ignores the middle ones and cannot justify picking only the ends.
  const row=(name,fn,fmt,key)=>{
    const raw=pts.map(fn),f=fmt||fv;
    return{label:name,key,cells:raw.map(v=>({raw:v,text:v==null?null:f(v)}))};
  };
  // Prefix cache hit rate: LLM suggestions locate this row by cache_hit
  const cacheRate=s=>{
    const src=((s.telemetry&&s.telemetry.sources)||[]).find(x=>x.kind==="vllm");
    if(!src)return null;
    const m=seriesMap(src);
    const q=(m["vllm:prefix_cache_queries"]||{}).total,h=(m["vllm:prefix_cache_hits"]||{}).total;
    return(typeof q==="number"&&q>0&&typeof h==="number")?h/q:null;
  };
  const w=pts[0].workload||{};
  const subtitle=[pts.length+" 个档位",w.mode||"",w.variant||""].filter(Boolean).join(" · ");
  const inf={title:"推理指标",subtitle,cards:[],bars:[],table:{
    cols:pts.map(label),
    rows:[
      row("请求数",s=>stat(s,"requests","mean"),null,"requests"),
      row("TTFT mean (ms)",s=>stat(s,"ttft","mean"),v=>v==null?null:Math.round(v),"ttft_mean"),
      row("TTFT p95 (ms)",s=>stat(s,"ttft","p95"),v=>v==null?null:Math.round(v),"ttft_p95"),
      row("ITL mean (ms)",s=>stat(s,"itl","mean"),v=>v==null?null:+v.toFixed(1),"itl_mean"),
      row("Req Latency p95 (s)",s=>{const v=stat(s,"requestLatency","p95");return v==null?null:v/1000;},v=>v==null?null:+v.toFixed(1),"latency_p95"),
      row("总吞吐 (tok/s)",s=>stat(s,"totalThroughput","mean"),null,"throughput"),
      row("Interactivity (tok/s/user)",s=>stat(s,"interactivity","mean"),null,"interactivity"),
      row("Prefix Cache 命中率",cacheRate,v=>v==null?null:(v*100).toFixed(1)+"%","cache_hit"),
      // Request count and tokens measure workload, not quality; leave them uncolored so "more" is not read as "better"
      row("输入 tokens",s=>stat(s,"inputTokens","mean"),tok,"input_tokens"),
      row("输出 tokens",s=>stat(s,"outputTokens","mean"),tok,"output_tokens"),
      row("测量时长 (min)",s=>{const v=stat(s,"duration","mean");return v==null?null:v/60;},v=>v==null?null:Math.round(v),"duration_s"),
    ]}};
  const trust=[];
  const cmp=pts.filter(s=>typeof s.comparable==="boolean");
  if(cmp.length){const bad=pts.filter(s=>s.comparable===false);
    trust.push({k:"可比性",v:bad.length?bad.length+" 档不可比":"全部可比",cls:bad.length?"bad":"ok",
      d:bad.map(s=>label(s)+"："+(L(s.incomparableReasons).slice(0,2).map(reasonCN).join("；")||"未给出原因")).join(" · ")});}
  const up=pts.filter(s=>s.upstreamSubmissionValid===false);
  if(up.length)trust.push({k:"上游提交",v:up.length+" 档不合规",cls:"bad",
    d:up.map(s=>label(s)+"："+(L(s.upstreamInvalidReasons).slice(0,2).join("；")||"未给出原因")).join(" · ")});
  // Collection errors are an all-endpoints total shown once even across levels; old summaries repeated the same copy per source, so merge and dedupe
  const globals=[];
  pts.forEach(s=>{
    const n=s.telemetry&&s.telemetry.collectionErrors;
    if(typeof n==="number")globals.push({n,label:label(s)});
    ((s.telemetry&&s.telemetry.sources)||[]).forEach(src=>{
      splitErrors(src.errors).glob.forEach(g=>globals.push({n:g.n,label:label(s)}));});
  });
  if(globals.length){
    const n=Math.max(...globals.map(x=>x.n));
    const ls=[...new Set(globals.map(x=>x.label))];
    trust.push({k:"采集错误",v:n+" 次",cls:"warn",
      d:(ls.length<pts.length?ls.join("/")+" · ":"")+"全部端点合计，无法归属到具体来源；临时失败后会继续采集，已获得的统计保留"});
  }
  const byKind={};
  pts.forEach(s=>((s.telemetry&&s.telemetry.sources)||[]).forEach(src=>{
    const k=src.kind||"unknown";(byKind[k]=byKind[k]||[]).push({src,label:label(s)});}));
  Object.keys(byKind).forEach(kind=>{
    const list_=byKind[kind];
    const dirs=new Set(list_.map(x=>x.label));
    // Dedupe per-source errors by text after stripping the global total; name levels only when a subset is affected, so a partial failure is not read as all levels
    const errMap=new Map();
    list_.forEach(x=>splitErrors(x.src.errors).own.forEach(e=>{
      if(!errMap.has(e.text))errMap.set(e.text,new Set());
      errMap.get(e.text).add(x.label);}));
    const own=[...errMap.entries()].map(([text,ls])=>text+(ls.size<dirs.size?"（"+[...ls].join("/")+"）":""));
    const rank=v=>({complete:0,partial:1,unavailable:2})[v]??-1;
    const worst=list_.slice().sort((a,b)=>rank(b.src.status)-rank(a.src.status))[0];
    const samples=list_.reduce((a,x)=>a+(x.src.samples||0),0);
    const devices=[...new Set(list_.map(x=>x.src.deviceId).filter(v=>v!=null))];
    const bits=["档位状态："+list_.map(x=>x.label+" "+statusCN(x.src.status)).join(" · ")];
    if(samples)bits.push((dirs.size>1?dirs.size+" 档累计 ":"")+fmtNum(samples)+" 个采样点");
    if(devices.length)bits.push("设备 "+devices.join("、"));
    if(own.length)bits.push(own.length+" 类错误："+own.join("；"));
    const name=kind==="vllm"?"vLLM 采样":kind==="ascend"?"NPU 采样":(kind+" 采样");
    trust.push({k:name,v:statusCN(worst.src.status),cls:statusCls(worst.src.status),d:bits.join(" · ")});
  });
  // With multiple levels on one page, list warmup sample counts and TTFT ranges per level to show how many cold-start requests the main metrics dropped
  const warm=pts.map(s=>({l:label(s),t:(s.warmup||{}).ttft})).filter(x=>x.t&&x.t.count!=null);
  if(warm.length){
    const rg=v=>{const a=Math.min(...v),b=Math.max(...v);return a===b?secFmt(a):secFmt(a)+"–"+secFmt(b);};
    const bits=warm.map(x=>x.l+" n="+x.t.count);
    const p50=warm.map(x=>x.t.p50).filter(v=>v!=null);
    const p95=warm.map(x=>x.t.p95).filter(v=>v!=null);
    if(p50.length)bits.push("TTFT p50 "+rg(p50));
    if(p95.length)bits.push("p95 "+rg(p95));
    trust.push({k:"预热段",v:"已剔除",cls:"",key:"warmup_ttft_p95",d:bits.join(" · ")});
  }
  if(trust.length)inf.trust=trust;
  const hw={title:"硬件指标",subtitle,cards:[],bars:[],table:null};
  const hasHw=pts.some(s=>((s.telemetry&&s.telemetry.sources)||[]).some(x=>x.kind==="ascend"&&(x.series||[]).length));
  if(hasHw){
    const get=(s,k)=>{const src=((s.telemetry&&s.telemetry.sources)||[]).find(x=>x.kind==="ascend");
      const m=seriesMap(src);return m[k]&&m[k].mean!=null?m[k].mean:null;};
    hw.table={cols:pts.map(label),rows:[
      ["NPU Utilization (%)","ascend_npu_utilization_percent"],
      ["AI Core Utilization (%)","ascend_npu_aicore_utilization_percent"],
      ["HBM Usage (%)","ascend_npu_hbm_usage_percent"],
      ["HBM Bandwidth (%)","ascend_npu_hbm_bandwidth_percent"],
      ["HBM Capacity (MB)","ascend_npu_hbm_capacity_megabytes"],
      ["Power (W)","ascend_npu_power_watts"],
      ["Temperature (°C)","ascend_npu_temperature_celsius"],
    ].map(([name,k])=>row(name,s=>get(s,k),null,k))};
  }
  return{inf,hw};
}
// Merged metrics page: inference and hardware on one screen, so a missing half no longer takes a blank page of its own
const METRIC_EMPTY=["暂无指标","本 epoch 没有上报推理指标（TTFT / ITL / 吞吐）或硬件指标（NPU / HBM / 功耗）。评测端会在 run 收尾时回传 agentx-summary.json，导入后才会出现在这里。"];
function trustHTML(tre){
  if(!tre||!tre.length)return "";
  const issue=tre.filter(t=>t.cls==="bad"||t.cls==="warn").length;
  return '<div class="trust"><h4>测量可信度<span>'+(issue?issue+' 项需关注':'无异常')+'</span></h4><div class="tgrid">'+
    tre.map(t=>`<b>${esc(t.k)}</b><span class="${t.cls||''}"${t.key?' data-metric="'+esc(t.key)+'"':''}>${esc(t.v)}${t.d?'<i>'+esc(t.d)+'</i>':''}</span>`).join('')+'</div></div>';
}
// Render only non-empty blocks; renderMetrics owns the empty state, so merging never leaves an "inference yes, hardware none" stub
function metricBodyHTML(m){
  if(!m)return "";
  const tbl=m.table||null,hasTbl=!!(tbl&&tbl.rows&&tbl.rows.length);
  if(!m.cards.length&&!m.bars.length&&!hasTbl)return "";
  let h="";
  // Multiple levels: one table puts all concurrency levels side by side, missing values shown as a dimmed — rather than hiding the row.
  // Each value is preceded by an inline mini bar (normalized to the row max) so magnitude trends live inside the table.
  if(hasTbl){
    h+='<div class="xcmp"><table><thead><tr><th>指标</th>'+tbl.cols.map(c=>`<th title="${esc(String(c))}">${esc(c)}</th>`).join('')+'</tr></thead><tbody>'+
      tbl.rows.map(r=>{
        const mx=r.cells.reduce((a,c)=>c.raw==null?a:Math.max(a,Math.abs(c.raw)),0);
        // Metric and level names get clipped by horizontal scrolling on narrow screens, so hover reveals the full text
        return '<tr'+(r.key?' data-metric="'+esc(r.key)+'"':'')+'><td title="'+esc(r.label)+'">'+esc(r.label)+'</td>'+r.cells.map((c,i)=>{
          if(c.text==null)return '<td><span class="na">—</span></td>';
          const w=mx?Math.max(3,Math.abs(c.raw)/mx*100):0;
          return '<td><div class="vc"><span class="vbar"><i style="width:'+w.toFixed(0)+'%;background:'+PAL[i%PAL.length]+'"></i></span><b>'+esc(String(c.text))+'</b></div></td>';
        }).join('')+'</tr>';
      }).join('')+'</tbody></table></div>';}
  if(m.cards.length)h+='<div class="cards">'+m.cards.map(c=>`<div class="card"${c.key?' data-metric="'+esc(c.key)+'"':''}><div class="lbl">${esc(c.label)}</div><div class="val">${esc(c.value)}<small> ${esc(c.unit||'')}</small></div><div class="sub">${esc(c.sub||'')}</div></div>`).join('')+'</div>';
  (m.bars||[]).forEach(g=>{const mx=Math.max(...g.items.map(i=>Math.abs(i.value)))||1;
    h+=`<div class="bars"><h4>${esc(g.title)} <span style="text-transform:none">(${esc(g.unit||'')})</span></h4>`+g.items.map(i=>`<div class="bar-row"${i.key?' data-metric="'+esc(i.key)+'"':''}><div class="bl">${esc(i.label)}</div><div class="bt"><div class="bf" style="width:${(Math.abs(i.value)/mx*100).toFixed(1)}%;background:${i.color||PAL[0]}"></div></div><div class="bv">${esc(fv(i.value))}</div></div>`).join('')+'</div>';});
  return h;
}
function renderMetrics(){
  const m=METRICS||{inf:null,hw:null},el=$("#metpane");if(!el)return;
  const infBody=metricBodyHTML(m.inf),hwBody=metricBodyHTML(m.hw);
  const tre=(m.inf&&m.inf.trust)||[];
  if(!infBody&&!hwBody&&!tre.length){
    el.innerHTML='<div class="emptyfull">'+emptyHTML(METRIC_EMPTY[0],METRIC_EMPTY[1])+'</div>';return;}
  const sub=(m.inf&&m.inf.subtitle)||(m.hw&&m.hw.subtitle)||"";
  const srcNote=(METRICS_RAW&&METRICS_RAW.kind==="agentx")
    ?"来源 agentx-summary.json 的 profiling / warmup / telemetry 字段"
    :"来源为评测端回传的汇总数据";
  let h='<h3>指标</h3><div class="mtitle">'+(sub?esc(sub)+" · ":"")+esc(srcNote)+'</div>';
  h+=trustHTML(tre);
  if(infBody)h+='<h4 class="msec">推理指标</h4>'+infBody;
  if(hwBody)h+='<h4 class="msec">硬件指标</h4>'+hwBody;
  el.innerHTML=h;
}
