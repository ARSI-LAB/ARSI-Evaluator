import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";

// Exercise the pinned native driver/exporter, with a local gateway and an
// injected scheduler failure after its durable tool/call event. No task runs.
const home = "/tmp/dsh-pending-tool-fixture";
await mkdir(home);
const hook = home + "/scheduler-error.mjs";
await writeFile(hook, `import {registerHooks} from 'node:module';
registerHooks({load(url,context,nextLoad){
  const loaded=nextLoad(url,context);
  if(!new URL(url).pathname.endsWith('/@deepseek-ai/dsh-agent-loop/lib/index.js'))return loaded;
  const source=typeof loaded.source==='string'?loaded.source:Buffer.from(loaded.source).toString('utf8');
  const seam='function appendToolCall(session, turn, step, block) {';
  const start=source.indexOf(seam),end=source.indexOf('\\n}',start)+2;
  if(start<0||source.indexOf(seam,start+1)>=0||end<start)throw Error('Unsupported fixture driver');
  const original=source.slice(start,end);
  const replacement=original.replace('return session.append','const emitted = session.append')
    .replace('}).seq;', '}).seq;\\nthrow new Error("fixture scheduler failure");');
  if(replacement===original||!replacement.includes('const emitted'))throw Error('Fixture injection failed');
  return {...loaded,source:source.slice(0,start)+replacement+source.slice(end)};
}});
`);
let requests = 0;
const server = createServer(async (req, res) => {
  for await (const ignored of req) { void ignored; }
  requests++;
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  const chunk = (delta, reason) => ({ id: "fixture", object: "chat.completion.chunk", created: 1,
    model: "fixture-model", choices: [{ index: 0, delta, finish_reason: reason }] });
  res.end("data: " + JSON.stringify(chunk({ role: "assistant", tool_calls: [{ index: 0,
    id: "fixture-call", type: "function", function: { name: "bash", arguments: '{"command":"echo fixture"}' } }] }, null)) +
    "\n\ndata: " + JSON.stringify(chunk({}, "tool_calls")) + "\n\ndata: [DONE]\n\n");
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const cli = "/opt/evaluator-agent/node_modules/@deepseek-ai/dsh/lib/bin.js";
const env = { PATH: process.env.PATH, HOME: home, DSH_HOME: home, DSH_PERMISSION_MODE: "danger-full-access",
  DSH_TELEMETRY_DISABLED: "1", EMBER_EVALUATOR_API_KEY: "fixture-secret" };
function launch(args, input = "") {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", bytes => stdout += bytes);
    child.stderr.on("data", bytes => stderr += bytes);
    child.on("error", reject);
    child.on("close", code => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}
try {
  const setup = await launch([cli, "--profile", "evaluator", "--from-default-profile", "headless", "--dump-config"]);
  assert.equal(setup.code, 0, setup.stderr);
  const patch = [{ id: "agent-default-model", config: { provider: "fixture", model: "fixture-model" } },
    { id: "llm-pi-ai", config: { providers: { fixture: { apiKeyEnv: "EMBER_EVALUATOR_API_KEY",
      baseURL: `http://127.0.0.1:${server.address().port}/v1`, api: "openai-completions",
      models: [{ id: "fixture-model", maxTokens: 1024 }] } } } },
    { id: "session-title-llm", disabled: true }, { id: "approval", config: { policy: "never" } }];
  await writeFile(home + "/model.yaml", JSON.stringify(patch));
  const result = await launch(["--import", hook, cli, "--profile", "evaluator", "--patch", home + "/model.yaml", "--json"],
    "Use the bash tool to echo fixture.");
  const records = result.stdout.trim().split("\n").map(line => JSON.parse(line));
  assert.equal(result.code, 1);
  assert(records.some(record => record.type === "tool_call"));
  assert(!records.some(record => record.type === "tool_result"));
  assert(records.some(record => record.type === "status" && record.phase === "turn_end" && record.reason.kind === "error"));
  assert(result.stdout.includes("fixture scheduler failure"));
  console.log(JSON.stringify({ realProviderCalled: false, scoringPerformed: false, requests,
    exitCode: result.code, stream: result.stdout, stderr: result.stderr }));
} finally { await new Promise(resolve => server.close(resolve)); }
