import { test, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DockerEnvironment } from "../../src/plugins/environments/docker/environment.js";
import { PINNED_NODE_IMAGE } from "../../src/infrastructure/containers/runtime-contract.js";
import { consumeDsh } from "../../src/runtimes/dsh/protocol.js";
import { readProcess } from "../../src/infrastructure/process/output.js";

test.skipIf(process.env.EVALUATOR_TEST_DOCKER !== "1")("container agent output is verified live, preserved on cleanup, and shared mounts stay unchanged", async () => {
  const root = await mkdtemp(join(tmpdir(), "private-agent-logs-"));
  const key = { runId: "fixture-" + randomUUID(), taskId: "agent-logs", attemptId: randomUUID() };
  const attempt = join(root, key.attemptId);
  await mkdir(attempt); await writeFile(join(attempt, "allocation.json"), JSON.stringify({ key }));
  const paths = { root: attempt, agent: join(attempt, "agent"), verifier: join(attempt, "verifier"), artifacts: join(attempt, "artifacts") };
  const environment = new DockerEnvironment({ agentLogStorage: "container", agentLogStorageReason: "non-scoring storage regression" });
  const signal = AbortSignal.timeout(120_000);
  let session;
  try {
    const spec = await environment.materialize({ image: PINNED_NODE_IMAGE, workdir: "/workspace", initialFiles: [], runtime: [], network: "none" }, signal);
    session = await environment.prepare(spec, paths, "solve", signal);
    expect(session.metadata).toMatchObject({ agentLogs: { storage: "container" } });
    const script = `const f=require('node:fs'),c=require('node:crypto');
const data='generic fixture output\\n'.repeat(10000);f.mkdirSync('/logs/agent/tool-outputs');f.writeFileSync('/logs/agent/tool-outputs/fixture.txt',data,{mode:0o600});
f.writeFileSync('/logs/agent/native.log','original native evidence',{mode:0o600});
const events=[{type:'session',sessionId:'fixture',cwd:'/workspace'},
{type:'status',phase:'turn_start',turn:1},{type:'status',phase:'step_start',turn:1,step:1},
{type:'tool_call',callId:'call',tool:'bash',input:{}},
{type:'tool_result',callId:'call',status:'completed',result:'generic preview',truncated:true,originalBytes:Buffer.byteLength(data),storedBytes:Buffer.byteLength(data),resultRef:'agent/tool-outputs/fixture.txt',sha256:c.createHash('sha256').update(data).digest('hex')},
{type:'status',phase:'step_end',turn:1,step:1},{type:'status',phase:'turn_end',turn:1,reason:{kind:'completed'}},{type:'final',text:'fixture complete'}];
for(const e of events)console.log(JSON.stringify(e));`;
    const handle = await session.start({ executable: "node", args: ["-e", script], cwd: "/workspace", env: {}, input: null }, signal);
    const result = await consumeDsh(handle, { key, paths, signal, environment: session }, "");
    expect(result.finalText).toBe("fixture complete");
    expect(await readFile(join(paths.agent, "tool-outputs/fixture.txt"), "utf8")).toBe("generic fixture output\n".repeat(10000));
    const trajectory = await readFile(join(paths.agent, "trajectory.jsonl"));
    await session.dispose(signal); session = undefined;
    expect(await readFile(join(paths.agent, "native.log"), "utf8")).toBe("original native evidence");
    expect(await readFile(join(paths.agent, "trajectory.jsonl"))).toEqual(trajectory);
    // A shared phase must still use its original bind mounts.
    session = await environment.prepare({ ...spec, sharedLogs: true }, paths, "solve", signal);
    expect(session.metadata).not.toHaveProperty("agentLogs");
    const shared = await session.start({ executable: "node", args: ["-e", "require('node:fs').writeFileSync('/logs/agent/shared.txt','shared evidence')"], cwd: "/workspace", env: {}, input: null }, signal);
    expect((await readProcess(shared, signal)).code).toBe(0);
    expect(await readFile(join(paths.agent, "shared.txt"), "utf8")).toBe("shared evidence");
  } finally { if (session) await session.dispose(AbortSignal.timeout(60_000)); await rm(root, { recursive: true, force: true }); }
}, 150_000);
