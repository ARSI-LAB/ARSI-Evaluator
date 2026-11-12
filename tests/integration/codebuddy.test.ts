import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { Evaluator } from "../../src/index.js";
import { safeTaskKey } from "../../src/core/artifacts/artifacts.js";
import { PINNED_NODE_IMAGE } from "../../src/infrastructure/containers/runtime-contract.js";
import { CODEBUDDY_VERSION } from "../../src/runtimes/codebuddy/runtime.js";
import { writeFixture } from "../fixtures/dataset-tasks.js";

const secret = "fixture-codebuddy-upstream-key";
const model = "deepseek-v4-flash";
const maxTokens = 123;

async function modelFixture(docker: boolean) {
  const windows = process.platform === "win32" && !docker;
  const tool = windows ? "PowerShell" : "Bash";
  const secretHash = createHash("sha256").update(secret).digest("hex");
  const script = [
    'const { createHash } = require("node:crypto");',
    'const { writeFileSync } = require("node:fs");',
    `if (Object.values(process.env).some(value => createHash("sha256").update(String(value)).digest("hex") === "${secretHash}")) process.exit(7);`,
    'writeFileSync("result.txt", "answer"); process.stdout.write("FILE_AND_KEY_OK");',
  ].join("\n");
  const command = `node -e 'eval(Buffer.from(process.argv[1], String.fromCharCode(98,97,115,101,54,52)).toString())' '${Buffer.from(script).toString("base64")}'${windows ? "; exit $LASTEXITCODE" : ""}`;
  const requests: Array<{ model: unknown; authenticated: boolean; maxOutput: unknown; input: string; toolOutput: string }> = [];
  const server = createServer(async (req, res) => {
    const path = docker ? "/v1/responses" : "/v1/chat/completions";
    if (req.method !== "POST" || req.url !== path) {
      res.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const messages: Array<{ role?: string; type?: string }> = docker ? body.input : body.messages;
    const input = JSON.stringify(messages);
    const toolOutput = JSON.stringify(messages.filter(item => item.role === "tool" || item.type === "function_call_output"));
    requests.push({ model: body.model, authenticated: req.headers.authorization === `Bearer ${secret}`,
      maxOutput: body.max_output_tokens ?? body.max_tokens ?? body.max_completion_tokens, input, toolOutput });
    const n = requests.length;
    const args = JSON.stringify({ command, description: "Write a file and check the isolated environment" });
    const answer = docker ? "文件已写入" : `答案已算出\nAnswer: ${/([A-D])\) 42/u.exec(requests[0]?.input ?? "")?.[1] ?? "?"}`;
    res.writeHead(200, { "content-type": "text/event-stream" });
    if (docker) {
      const item = n === 1 ? { id: "fc_1", type: "function_call", name: tool, call_id: "call_1", status: "completed", arguments: args }
        : { id: "msg_2", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: answer, annotations: [] }] };
      const response = { id: `resp_${n}`, object: "response", created_at: 1, model, status: "in_progress", output: [] };
      const usage = { input_tokens: 15, input_tokens_details: { cached_tokens: 3 }, output_tokens: 7,
        output_tokens_details: { reasoning_tokens: 2 }, total_tokens: 22 };
      for (const event of [
        { type: "response.created", response },
        { type: "response.output_item.added", output_index: 0, item },
        { type: "response.output_item.done", output_index: 0, item },
        { type: "response.completed", response: { ...response, status: "completed", output: [item], usage } },
      ]) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    } else {
      const base = { id: `chatcmpl_${n}`, object: "chat.completion.chunk", created: 1, model };
      const delta = n === 1 ? { role: "assistant", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: tool, arguments: args } }] }
        : { role: "assistant", content: answer };
      for (const chunk of [
        { choices: [{ index: 0, delta, finish_reason: null }] },
        { choices: [{ index: 0, delta: {}, finish_reason: n === 1 ? "tool_calls" : "stop" }] },
        { choices: [], usage: { prompt_tokens: 15, prompt_tokens_details: { cached_tokens: 3 }, completion_tokens: 7, total_tokens: 22 } },
      ]) res.write(`data: ${JSON.stringify({ ...base, ...chunk })}\n\n`);
      res.write("data: [DONE]\n\n");
    }
    res.end();
  });
  await new Promise<void>(resolve => server.listen(0, docker ? "0.0.0.0" : "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture did not bind a TCP port");
  return {
    requests,
    endpoint: `http://${docker ? "host.docker.internal" : "127.0.0.1"}:${address.port}/v1`,
    close: () => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

for (const environment of ["local", "docker"] as const) {
  const enabled = process.env.EVALUATOR_CODEBUDDY_TEST === environment || process.env.EVALUATOR_CODEBUDDY_TEST === "all";
  test.skipIf(!enabled)(`CodeBuddy solves and scores a real CLI attempt in ${environment}`, () => smoke(environment), 930_000);
}

async function smoke(environment: "local" | "docker"): Promise<void> {
  const docker = environment === "docker";
  const root = await mkdtemp(join(tmpdir(), "ember-codebuddy-test-"));
  const fixture = await modelFixture(docker);
  try {
    const configPath = join(root, "experiment.yaml");
    await writeFixture(root, {
      "gpqa.csv": "Question,Correct Answer,Incorrect Answer 1,Incorrect Answer 2,Incorrect Answer 3\n计算 6 × 7,42,36,40,49\n",
      "dataset/tasks/codebuddy/task.toml": `artifacts = []\n[environment]\ndocker_image = "${PINNED_NODE_IMAGE}"\nworkdir = "/workspace"\n[agent]\nnetwork_mode = "no-network"\n[verifier]\nenvironment_mode = "shared"\n`,
      "dataset/tasks/codebuddy/instruction.md": "Write answer to /workspace/result.txt.",
      "dataset/tasks/codebuddy/tests/test.sh": "set -eu\ntest \"$(cat /workspace/result.txt)\" = answer\nprintf '{\"reward\":1}' > /logs/verifier/reward.json\n",
    });
    await writeFile(configPath, JSON.stringify({
      services: { selected: { model, base_url: fixture.endpoint, api: docker ? "openai-responses" : "openai-completions",
        api_key: "${CODEBUDDY_FIXTURE_KEY}", maxTokens } },
      benchmark: {
        name: docker ? "harbor" : "gpqa",
        config: docker ? { source: { kind: "local", path: "./dataset" } } : { localPath: "./gpqa.csv" },
        solver: { name: "codebuddy", service: "selected" },
      },
      environment,
      run: { maxTasks: 1, preparation: { environmentTimeoutSeconds: 900, roundTimeoutSeconds: 900 } },
      output: { directory: "./results" },
    }));
    const networkConfigPath = process.env.EVALUATOR_CODEBUDDY_TEST_NETWORK;
    const result = await new Evaluator().run({ configPath, env: { CODEBUDDY_FIXTURE_KEY: secret }, signal: AbortSignal.timeout(900_000),
      ...(networkConfigPath === undefined ? {} : { networkConfigPath }) });
    if (result.kind !== "local") throw new Error("Expected evaluation on the local scheduler");
    const [attempt] = result.snapshot.records;
    if (!attempt) throw new Error("Missing attempt");
    expect(attempt, JSON.stringify(attempt.errors)).toMatchObject({
      executionStatus: "completed", scoreStatus: "valid", verdict: { score: 1 }, collection: { trajectory: "complete" },
      solve: { finalText: expect.stringContaining(docker ? "文件已写入" : "答案已算出"), usage: { inputTokens: 30, outputTokens: 14, totalTokens: 44 } },
    });
    expect(result.snapshot.run.solverProvenance).toMatchObject({ codebuddyVersion: CODEBUDDY_VERSION });
    expect(fixture.requests).toHaveLength(2);
    for (const request of fixture.requests) expect(request).toMatchObject({ model, authenticated: true, maxOutput: maxTokens });
    expect(fixture.requests[1]?.toolOutput).toContain("FILE_AND_KEY_OK");
    if (!docker) expect(fixture.requests[0]?.input).toContain("计算");
    const agent = join(result.runDirectory, "tasks", safeTaskKey(attempt.key.taskId), "attempts", attempt.key.attemptId, "agent");
    for (const filename of ["session.jsonl", "trajectory.jsonl", "stderr.log"]) {
      expect(await readFile(join(agent, filename), "utf8")).not.toContain(secret);
    }
  } finally {
    await fixture.close();
    await rm(root, { recursive: true, force: true });
  }
}
