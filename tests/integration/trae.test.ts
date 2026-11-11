import { createServer } from "node:http";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { Evaluator } from "../../src/index.js";
import { safeTaskKey } from "../../src/core/artifacts/artifacts.js";
import { PINNED_NODE_IMAGE } from "../../src/infrastructure/containers/runtime-contract.js";
import { TRAE_VERSION } from "../../src/runtimes/trae/runtime.js";
import { writeFixture } from "../fixtures/dataset-tasks.js";

const secret = "fixture-trae-auth-value";
const model = "fixture-trae";

const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const powerShellQuote = (value: string) => `'${value.replaceAll("'", "''")}'`;

async function responsesFixture(docker: boolean, outside: string | undefined) {
  const windows = process.platform === "win32" && !docker;
  const commands = [windows
    ? "if (Test-Path Env:EVALUATOR_TRAE_API_KEY) { throw 'key present' }; Set-Content -LiteralPath result.txt -Value answer -ErrorAction Stop; Write-Output ((Get-Content -LiteralPath result.txt) + ' KEY_ABSENT')"
    : "test -z \"${EVALUATOR_TRAE_API_KEY:-}\" && printf answer > result.txt && cat result.txt && printf ' KEY_ABSENT'"];
  if (outside !== undefined) {
    commands.push(windows ? `Set-Content -LiteralPath ${powerShellQuote(outside)} -Value outside -ErrorAction Stop`
      : `printf outside > ${shellQuote(outside)}`);
  }
  const requests: Array<{ model: unknown; authenticated: boolean; input: string }> = [];
  const server = createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/v1/responses") {
      res.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const input = JSON.stringify(body.input);
    requests.push({ model: body.model, authenticated: req.headers.authorization === `Bearer ${secret}`, input });
    const n = requests.length;
    const command = commands[n - 1];
    const item = command !== undefined
      ? { id: `fc_${n}`, type: "function_call", name: windows ? "PowerShell" : "Bash", call_id: `call_${n}`, status: "completed",
          arguments: JSON.stringify({ command, description: n === 1 ? "Write and read the task file" : "Check outside workspace policy" }) }
      : { id: `msg_${n}`, type: "message", role: "assistant", status: "completed",
          content: [{ type: "output_text", text: docker ? "文件已写入" : `答案已算出\nAnswer: ${/([A-D])\) 42/u.exec(requests[0]?.input ?? "")?.[1] ?? "?"}`, annotations: [] }] };
    const response = { id: `resp_${n}`, object: "response", created_at: 1, model, status: "in_progress", output: [] };
    const usage = { input_tokens: 15, input_tokens_details: { cached_tokens: 3 }, output_tokens: 7,
      output_tokens_details: { reasoning_tokens: 2 }, total_tokens: 22 };
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const event of [
      { type: "response.created", response },
      { type: "response.output_item.added", output_index: 0, item },
      { type: "response.output_item.done", output_index: 0, item },
      { type: "response.completed", response: { ...response, status: "completed", output: [item], usage } },
    ]) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
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
  const enabled = process.env.EVALUATOR_TRAE_TEST === environment || process.env.EVALUATOR_TRAE_TEST === "all";
  test.skipIf(!enabled)(`TRAE solves and scores a real CLI attempt in ${environment}`, () => smoke(environment), 930_000);
}

async function smoke(environment: "local" | "docker"): Promise<void> {
  const docker = environment === "docker";
  const root = await mkdtemp(join(tmpdir(), "ember-trae-test-"));
  // Vitest's mock home is in the temporary directory, where workspace-write permits writes.
  const { homedir } = await vi.importActual<typeof import("node:os")>("node:os");
  const outside = docker ? undefined : await mkdtemp(join(homedir(), ".ember-trae-sandbox-test-"));
  const outsideFile = outside === undefined ? undefined : join(outside, "outside.txt");
  const fixture = await responsesFixture(docker, outsideFile);
  try {
    const configPath = join(root, "experiment.yaml");
    await writeFixture(root, {
      "gpqa.csv": "Question,Correct Answer,Incorrect Answer 1,Incorrect Answer 2,Incorrect Answer 3\n计算 6 × 7,42,36,40,49\n",
      "dataset/tasks/trae/task.toml": `artifacts = []\n[environment]\ndocker_image = "${PINNED_NODE_IMAGE}"\nworkdir = "/workspace"\n[agent]\nnetwork_mode = "no-network"\n[verifier]\nenvironment_mode = "shared"\n`,
      "dataset/tasks/trae/instruction.md": "Write answer to /workspace/result.txt.",
      "dataset/tasks/trae/tests/test.sh": "set -eu\ntest \"$(cat /workspace/result.txt)\" = answer\nprintf '{\"reward\":1}' > /logs/verifier/reward.json\n",
    });
    await writeFile(configPath, JSON.stringify({
      services: { selected: { model, base_url: fixture.endpoint, api: "openai-responses", api_key: "${TRAE_FIXTURE_KEY}" } },
      benchmark: {
        name: docker ? "harbor" : "gpqa",
        config: docker ? { source: { kind: "local", path: "./dataset" } } : { localPath: "./gpqa.csv" },
        solver: { name: "trae", service: "selected" },
      },
      environment,
      run: { maxTasks: 1, preparation: { environmentTimeoutSeconds: 900, roundTimeoutSeconds: 900 } },
      output: { directory: "./results" },
    }));
    const networkConfigPath = process.env.EVALUATOR_TRAE_TEST_NETWORK;
    const result = await new Evaluator().run({ configPath, env: { TRAE_FIXTURE_KEY: secret }, signal: AbortSignal.timeout(900_000),
      ...(networkConfigPath === undefined ? {} : { networkConfigPath }) });
    if (result.kind !== "local") throw new Error("Expected evaluation on the local scheduler");
    const [attempt] = result.snapshot.records;
    if (!attempt) throw new Error("Missing attempt");
    expect(attempt, JSON.stringify(attempt.errors)).toMatchObject({
      executionStatus: "completed", scoreStatus: "valid", verdict: { score: 1 }, collection: { trajectory: "complete" },
      solve: { finalText: expect.stringContaining(docker ? "文件已写入" : "答案已算出"),
        usage: docker ? { inputTokens: 30, outputTokens: 14, totalTokens: 44 } : { inputTokens: 45, outputTokens: 21, totalTokens: 66 } },
    });
    expect(result.snapshot.run.solverProvenance).toMatchObject({ traeVersion: TRAE_VERSION });
    expect(fixture.requests).toHaveLength(docker ? 2 : 3);
    for (const request of fixture.requests) expect(request).toMatchObject({ model, authenticated: true });
    const commandOutput = JSON.parse(fixture.requests[1]?.input ?? "[]").find((item: { type: string }) => item.type === "function_call_output");
    expect(commandOutput?.output).toContain("answer KEY_ABSENT");
    if (outsideFile !== undefined) {
      expect(fixture.requests[0]?.input).toContain("计算");
      expect(fixture.requests[0]?.input).not.toMatch(/\.agents[/\\]+skills/u);
      await expect(stat(outsideFile)).rejects.toMatchObject({ code: "ENOENT" });
    }
    const agent = join(result.runDirectory, "tasks", safeTaskKey(attempt.key.taskId), "attempts", attempt.key.attemptId, "agent");
    for (const filename of ["session.jsonl", "trajectory.jsonl", "stderr.log"]) {
      expect(await readFile(join(agent, filename), "utf8")).not.toContain(secret);
    }
  } finally {
    await fixture.close();
    await rm(root, { recursive: true, force: true });
    if (outside !== undefined) await rm(outside, { recursive: true, force: true });
  }
}
