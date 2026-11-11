import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { executeWarmup } from "../../src/application/warmup.js";
import { loadNetworkConfig } from "../../src/config/network.js";
import { safeTaskKey } from "../../src/core/artifacts/artifacts.js";
import { PINNED_NODE_IMAGE } from "../../src/infrastructure/containers/runtime-contract.js";
import { NetworkRuntime } from "../../src/infrastructure/network/runtime.js";
import { Evaluator } from "../../src/index.js";
import { LocalEnvironment } from "../../src/plugins/environments/local/environment.js";
import { ZCodeSolver } from "../../src/plugins/solvers/zcode.js";
import { writeFixture } from "../fixtures/dataset-tasks.js";

const secret = "fixture-zcode-service-secret";
const model = "fixture-zcode";
const answer = "任务完成";
const apis = ["openai-completions", "openai-responses", "anthropic-messages"] as const;
type Api = typeof apis[number];

function sse<T extends { type: string }>(response: ServerResponse, events: T[]) {
  response.writeHead(200, { "content-type": "text/event-stream" });
  for (const event of events) response.write("event: " + event.type + "\ndata: " + JSON.stringify(event) + "\n\n");
  response.end();
}

async function fixture(api: Api, docker: boolean, bash: boolean) {
  const requests: Array<{ model: unknown; authenticated: boolean; input: string; tools: string[] }> = [];
  const path = api === "openai-completions" ? "/v1/chat/completions" : api === "openai-responses" ? "/v1/responses" : "/v1/messages";
  const server = createServer(async (req, res) => {
    if (req.method !== "POST" || req.url?.split("?")[0] !== path) return res.writeHead(404).end();
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const tool = bash && requests.length === 0;
      requests.push({
        model: body.model,
        authenticated: api === "anthropic-messages" ? req.headers["x-api-key"] === secret
          : req.headers.authorization === "Bearer " + secret,
        input: JSON.stringify(body.messages ?? body.input),
        tools: (body.tools ?? []).map((item: { name?: string; function?: { name: string } }) => item.name ?? item.function?.name),
      });
      const n = requests.length;
      if (api === "openai-completions") {
        const call = { id: "call_1", type: "function", function: {
          name: "Bash",
          arguments: JSON.stringify({
            command: "needle='fixture-zcode-service-'; needle=\"${needle}secret\"; if env | grep -Fq \"$needle\"; then exit 9; fi; " +
              "test -f \"$HOME/provider_config.json\" || exit 11; " +
              "if grep -Fq \"$needle\" \"$HOME/provider_config.json\"; then exit 10; fi; printf answer > result.txt; echo written",
            description: "Write the answer",
          }),
        } };
        const usage = { prompt_tokens: 15, completion_tokens: 7, total_tokens: 22, prompt_tokens_details: { cached_tokens: 3 } };
        const meta = { id: "chatcmpl_" + n, model, created: 1 };
        if (!body.stream) return res.setHeader("content-type", "application/json").end(JSON.stringify({
          ...meta, object: "chat.completion", usage, choices: [{ index: 0, finish_reason: tool ? "tool_calls" : "stop",
            message: tool ? { role: "assistant", content: null, tool_calls: [call] } : { role: "assistant", content: answer } }],
        }));
        res.writeHead(200, { "content-type": "text/event-stream" });
        for (const item of [
          { choices: [{ index: 0, finish_reason: null, delta: tool
            ? { role: "assistant", tool_calls: [{ index: 0, ...call }] } : { role: "assistant", content: answer } }] },
          { choices: [{ index: 0, finish_reason: tool ? "tool_calls" : "stop", delta: {} }], usage },
        ]) res.write("data: " + JSON.stringify({ ...meta, object: "chat.completion.chunk", ...item }) + "\n\n");
        return res.end("data: [DONE]\n\n");
      }
      if (api === "anthropic-messages") {
        const usage = { input_tokens: 15, output_tokens: 7, cache_read_input_tokens: 3, cache_creation_input_tokens: 2 };
        const message = { id: "msg_" + n, type: "message", role: "assistant", model, content: [], stop_reason: null,
          stop_sequence: null, usage: { ...usage, output_tokens: 0 } };
        if (!body.stream) return res.setHeader("content-type", "application/json").end(JSON.stringify({
          ...message, usage, content: [{ type: "text", text: answer }], stop_reason: "end_turn",
        }));
        return sse(res, [
          { type: "message_start", message },
          { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
          { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: answer } },
          { type: "content_block_stop", index: 0 },
          { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 7 } },
          { type: "message_stop" },
        ]);
      }
      const part = { type: "output_text", text: answer, annotations: [], logprobs: [] };
      const item = { id: "msg_" + n, type: "message", role: "assistant", status: "completed", content: [part] };
      const response = { id: "resp_" + n, object: "response", created_at: 1, model, status: "in_progress", output: [] };
      const usage = { input_tokens: 15, input_tokens_details: { cached_tokens: 3 }, output_tokens: 7,
        output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 22 };
      const completed = { ...response, status: "completed", output: [item], usage };
      if (!body.stream) return res.setHeader("content-type", "application/json").end(JSON.stringify(completed));
      return sse(res, [
        { type: "response.created", response },
        { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } },
        { type: "response.content_part.added", output_index: 0, content_index: 0, item_id: item.id, part: { ...part, text: "" } },
        { type: "response.output_text.delta", output_index: 0, content_index: 0, item_id: item.id, delta: answer, logprobs: [] },
        { type: "response.output_text.done", output_index: 0, content_index: 0, item_id: item.id, text: answer, logprobs: [] },
        { type: "response.output_item.done", output_index: 0, item },
        { type: "response.completed", response: completed },
      ]);
    } catch {
      return res.writeHead(500).end();
    }
  });
  await new Promise<void>(resolve => server.listen(0, docker ? "0.0.0.0" : "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture did not bind");
  return {
    requests,
    endpoint: "http://" + (docker ? "host.docker.internal" : "127.0.0.1") + ":" + address.port + "/v1",
    close: () => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

function enabled(environment: "local" | "docker"): boolean {
  return [environment, "all"].includes(process.env.EVALUATOR_ZCODE_TEST ?? "");
}

async function checkEvidence(agent: string): Promise<void> {
  for (const name of ["session.jsonl", "trajectory.jsonl", "stderr.log"]) {
    expect(await readFile(join(agent, name), "utf8")).not.toContain(secret);
  }
}

test.skipIf(!enabled("local"))("ZCode binds three model protocols and uses Bash in the local workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "ember-zcode-local-"));
  const signal = AbortSignal.timeout(1_800_000);
  const networkPath = process.env.EVALUATOR_ZCODE_TEST_NETWORK;
  const network = networkPath === undefined ? new NetworkRuntime() : new NetworkRuntime(await loadNetworkConfig(networkPath));
  try {
    const environment = new LocalEnvironment(undefined, undefined, network);
    let runtimeRoot: string | undefined;
    for (const api of apis) {
      const bash = api === "openai-completions";
      const mock = await fixture(api, false, bash);
      const agent = join(root, api, "agent");
      const paths = { root: join(root, api), agent, verifier: join(root, api, "verifier"), artifacts: join(root, api, "artifacts") };
      const key = { runId: "local", taskId: api, attemptId: "first" };
      const solver = new ZCodeSolver({ model: { name: model, provider: null, endpoint: mock.endpoint, api },
        auth: { value: secret, reference: null } });
      try {
        const session = await environment.prepare({ image: null, workdir: ".", runtime: solver.requirements(),
          installation: await solver.runtimeInstallation(signal), initialFiles: [] }, paths, "solve", signal);
        try {
          if (runtimeRoot !== undefined) expect(session.runtime?.root).toBe(runtimeRoot);
          runtimeRoot = session.runtime?.root;
          const result = await solver.solve({ id: api, prompt: "中文文本测试" }, session, { key, paths, signal });
          expect(result).toEqual({ finalText: answer, usage: bash
            ? { inputTokens: 30, outputTokens: 14, totalTokens: 44 }
            : api === "anthropic-messages" ? { inputTokens: 20, outputTokens: 7, totalTokens: 27 }
              : { inputTokens: 15, outputTokens: 7, totalTokens: 22 } });
          expect(mock.requests).toHaveLength(bash ? 2 : 1);
          for (const request of mock.requests) expect(request).toMatchObject({ model, authenticated: true });
          expect(mock.requests[0]?.input).toContain("中文文本测试");
          if (bash) {
            expect(mock.requests[0]?.tools).toContain("Bash");
            expect(mock.requests[1]?.input).toContain("written");
            expect(await readFile(join(session.workdir, "result.txt"), "utf8")).toBe("answer");
          }
          await checkEvidence(agent);
          expect(await readdir(session.runtime!.stateRoot!)).toEqual([]);
        } finally {
          await session.dispose(AbortSignal.timeout(10_000));
        }
      } finally {
        await mock.close();
      }
    }
  } finally {
    await network.dispose();
    await rm(root, { recursive: true, force: true });
  }
}, 1_830_000);

test.skipIf(!enabled("docker"))("ZCode uses the Docker model gateway and scores a Harbor file task", async () => {
  const root = await mkdtemp(join(tmpdir(), "ember-zcode-docker-"));
  const mock = await fixture("openai-completions", true, true);
  try {
    const configPath = join(root, "experiment.yaml");
    await writeFixture(root, {
      "dataset/tasks/zcode/task.toml": 'artifacts = []\n[environment]\ndocker_image = "' + PINNED_NODE_IMAGE +
        '"\nworkdir = "/workspace"\n[agent]\nnetwork_mode = "no-network"\n[verifier]\nenvironment_mode = "shared"\n',
      "dataset/tasks/zcode/instruction.md": "Write answer to /workspace/result.txt.",
      "dataset/tasks/zcode/tests/test.sh": 'set -eu\ntest "$(cat /workspace/result.txt)" = answer\nprintf \'{"reward":1}\' > /logs/verifier/reward.json\n',
    });
    await writeFile(configPath, JSON.stringify({
      services: { fixture: { model, base_url: mock.endpoint, api: "openai-completions", api_key: "${ZCODE_FIXTURE_KEY}" } },
      benchmark: { name: "harbor", config: { source: { kind: "local", path: "./dataset" } },
        solver: { name: "zcode", service: "fixture" } },
      environment: "docker",
      run: { maxTasks: 1, preparation: { environmentTimeoutSeconds: 1800, roundTimeoutSeconds: 1800 } },
      output: { directory: "./results" },
    }));
    const networkConfigPath = process.env.EVALUATOR_ZCODE_TEST_NETWORK;
    const options = { configPath, signal: AbortSignal.timeout(1_800_000),
      ...(networkConfigPath === undefined ? {} : { networkConfigPath }) };
    const warmup = await executeWarmup(options);
    expect(warmup, JSON.stringify(warmup.failures)).toMatchObject({ status: "ready", failures: [] });
    expect(warmup.readyTaskIds).toHaveLength(1);
    expect(mock.requests).toEqual([]);
    const result = await new Evaluator().run({ ...options, env: { ZCODE_FIXTURE_KEY: secret } });
    if (result.kind !== "local") throw new Error("Expected evaluation on the local scheduler");
    const [attempt] = result.snapshot.records;
    expect(attempt, JSON.stringify(attempt?.errors)).toMatchObject({ executionStatus: "completed", scoreStatus: "valid", verdict: { score: 1 },
      collection: { trajectory: "complete" }, solve: { finalText: answer, usage: { inputTokens: 30, outputTokens: 14, totalTokens: 44 } } });
    expect(result.snapshot.run.solverProvenance).toMatchObject({ zcodeVersion: "0.17.1" });
    expect(mock.requests).toHaveLength(2);
    for (const request of mock.requests) expect(request).toMatchObject({ model, authenticated: true });
    expect(mock.requests[1]?.input).toContain("written");
    if (!attempt) throw new Error("Missing attempt");
    await checkEvidence(join(result.runDirectory, "tasks", safeTaskKey(attempt.key.taskId), "attempts", attempt.key.attemptId, "agent"));
  } finally {
    await mock.close();
    await rm(root, { recursive: true, force: true });
  }
}, 1_830_000);
