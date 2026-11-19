import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { expect, test } from "vitest";
import { parse as parseYaml } from "yaml";
import type { ModelConfig } from "../../src/core/contracts/config.js";
import type { RunnerInput } from "../../src/runtimes/pi/protocol.js";
import { parseRunnerInput, projectRunnerInput } from "../../src/runtimes/pi/protocol.js";
import { modelFor } from "../../src/runtimes/pi/runner.js";
import { dshModelPatch } from "../../src/runtimes/dsh/model.js";
import { mergeJiuwenswarmModelConfig } from "../../src/runtimes/jiuwenswarm/prepare.js";

test("DeepAgents, Hermes and AgentX override Python request defaults without changing source requests", () => {
  const script = fileURLToPath(new URL("../fixtures/reasoning-python.py", import.meta.url));
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const output = execFileSync(process.env.PYTHON_BIN ?? (process.platform === "win32" ? "python" : "python3"),
    [script, root], { encoding: "utf8", windowsHide: true });
  expect(output).toContain("Python reasoning overrides passed");
});

test.each([
  ["openai-completions", { reasoning_effort: "max" }],
  ["openai-responses", { reasoning: { effort: "max" } }],
  ["anthropic-messages", { output_config: { effort: "max" }, thinking: { type: "adaptive" } }],
])("Pi and SimpleAgent preserve explicit max in repeated %s model requests", async (api, expected) => {
  const requests: unknown[] = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push(JSON.parse(body));
    res.writeHead(400, { "content-type": "application/json" })
      .end('{"error":{"type":"invalid_request_error","message":"local capture complete"}}');
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture did not bind");
  try {
    const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
    const source: RunnerInput = {
      schemaVersion: 1, key: { runId: "r", taskId: "t", attemptId: "a" },
      input: { id: "t", prompt: "hello" }, model: {
        name: "private-reasoning-model", endpoint: `http://127.0.0.1:${address.port}/v1`,
        provider: null, api, reasoningEffort: "max",
      }, auth: { value: "fixture", reference: null }, workdir: "/workspace", outputDir: "/output",
    };
    const input = parseRunnerInput(projectRunnerInput(source));
    expect(input.model.reasoningEffort).toBe("max");
    const model = await modelFor(input, runtime);
    for (let round = 0; round < 2; round++) await runtime.completeSimple(model,
      { messages: [{ role: "user", content: "hello", timestamp: 1 }] },
      { apiKey: "fixture", maxRetries: 0, reasoning: "low" });
    expect(requests).toHaveLength(2);
    for (const request of requests) expect(request).toMatchObject(expected);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test.each(["openai-completions", "openai-responses", "anthropic-messages"])("DSH declares and selects the exact service effort for %s", api => {
  const model: ModelConfig = { name: "fixture", endpoint: "https://fixture.invalid/v1", provider: null, api, reasoningEffort: "max" };
  const rows = parseYaml(dshModelPatch(model));
  expect(rows.find((row: { id: string }) => row.id === "agent-default-model").config).toMatchObject({ reasoningEffort: "max" });
  const provider = rows.find((row: { id: string }) => row.id === "llm-pi-ai").config.providers["arsi-evaluator"];
  expect(provider.reasoning).toBe("max");
  expect(provider.models[0].reasoningEfforts).toEqual({ max: "max" });
});

test("JiuwenSwarm service effort replaces installed defaults while retaining other model options", () => {
  const existing = "models:\n  defaults:\n    - model_config_obj:\n        reasoning_effort: low\n        max_tokens: 8192\n";
  const retained = parseYaml(mergeJiuwenswarmModelConfig(existing));
  const overridden = parseYaml(mergeJiuwenswarmModelConfig(existing, false, "max"));
  expect(retained.models.defaults[0].model_config_obj).toEqual({ reasoning_effort: "low", max_tokens: 8192 });
  expect(overridden.models.defaults[0].model_config_obj).toEqual({ reasoning_effort: "max", max_tokens: 8192 });
});
