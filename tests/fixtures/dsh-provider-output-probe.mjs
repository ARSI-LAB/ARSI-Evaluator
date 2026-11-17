import assert from "node:assert/strict";
import {createServer} from "node:http";
import {spawn} from "node:child_process";
import {mkdir,writeFile} from "node:fs/promises";
const requests=[];
const server=createServer(async(req,res)=>{
  let raw="";for await(const chunk of req)raw+=chunk;
  if(req.method!=="POST"){res.end(JSON.stringify({data:[{id:"fixture-model"}]}));return;}
  const body=JSON.parse(raw);const limit=body.max_completion_tokens??body.max_tokens;
  requests.push({limit:limit??null,stream:body.stream===true});
  if(limit>12288){res.writeHead(400,{"Content-Type":"application/json"});res.end(JSON.stringify({error:{message:"max_completion_tokens must be <= 12288, received "+limit,type:"invalid_request_error"}}));return;}
  res.writeHead(200,{"Content-Type":"text/event-stream"});
  const event=(content,finish)=>({id:"fixture",object:"chat.completion.chunk",created:1,model:"fixture-model",choices:[{index:0,delta:{role:"assistant",content},finish_reason:finish}]});
  res.end("data: "+JSON.stringify(event("OK",null))+"\n\ndata: "+JSON.stringify(event("","stop"))+"\n\ndata: [DONE]\n\n");
});
await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
const endpoint="http://127.0.0.1:"+server.address().port+"/v1";
const cli="/opt/evaluator-agent/node_modules/@deepseek-ai/dsh/lib/bin.js";
function launch(args,env){return new Promise((resolve,reject)=>{const child=spawn(process.execPath,args,{env,stdio:["pipe","pipe","pipe"]});let stdout="",stderr="";child.stdout.on("data",d=>stdout+=d);child.stderr.on("data",d=>stderr+=d);child.on("error",reject);child.on("close",code=>resolve({code,stdout,stderr}));child.stdin.end("Respond OK without tools.");});}
const rows=[];
try {
  for(const [name,hook,explicit]of [["original","/diagnosis/original-hook.mjs",undefined],["provider-default","/diagnosis/fixed-hook.mjs",undefined],["explicit","/diagnosis/fixed-hook.mjs",1024]]){
    const home="/tmp/dsh-output-"+name;await mkdir(home);await mkdir(home+"/output");
    const env={PATH:process.env.PATH,HOME:home,DSH_HOME:home,DSH_PERMISSION_MODE:"danger-full-access",DSH_TELEMETRY_DISABLED:"1",EMBER_EVALUATOR_API_KEY:"fixture-key",EVALUATOR_DSH_OUTPUT_DIR:home+"/output",...(name==="original"?{}:{EVALUATOR_DSH_PROVIDER_OUTPUT:JSON.stringify({provider:"ember-evaluator",model:"fixture-model"})})};
    const setup=await launch([cli,"--profile","evaluator","--from-default-profile","headless","--dump-config"],env);assert.equal(setup.code,0,setup.stderr.slice(-1000));
    const patch=[{id:"agent-default-model",config:{provider:"ember-evaluator",model:"fixture-model"}},{id:"llm-pi-ai",config:{providers:{"ember-evaluator":{apiKeyEnv:"EMBER_EVALUATOR_API_KEY",baseURL:endpoint,api:"openai-completions",models:[{id:"fixture-model",...(explicit===undefined?{}:{maxTokens:explicit})}]}}}},{id:"session-title-llm",disabled:true},{id:"approval",config:{policy:"never"}}];
    await writeFile(home+"/model.yaml",JSON.stringify(patch));
    const start=requests.length;
    const result=await launch(["--import",hook,cli,"--profile","evaluator","--patch",home+"/model.yaml","--json"],env);
    const calls=requests.slice(start);
    rows.push({name,exitCode:result.code,requests:calls,stderr:result.stderr.slice(-1200)});
    if(name==="original"){assert(calls.length>0);assert(calls.every(r=>r.limit===32768));assert.notEqual(result.code,0);}
    else {assert.equal(result.code,0,result.stderr);assert(calls.length>0);assert(calls.every(r=>r.limit===(explicit??null)));}
  }
  console.log(JSON.stringify({checkedAt:new Date().toISOString(),scoringPerformed:false,realProviderCalled:false,rows}));
}finally{await new Promise(resolve=>server.close(resolve));}
