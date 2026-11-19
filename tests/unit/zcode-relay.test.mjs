import { createServer } from "node:http";
import { expect, test } from "vitest";
import { startModelRelay } from "../../src/runtimes/shared/assets/model-relay.mjs";
import { applyReasoningEffort } from "../../src/infrastructure/models/reasoning-effort.mjs";

test.each([
  ["openai-completions", "/chat/completions", { reasoning_effort: "low", thinking: { type: "disabled" }, enable_thinking: false },
    { reasoning_effort: "max", thinking: { type: "enabled" }, enable_thinking: true }],
  ["openai-responses", "/responses", { reasoning: { effort: "low", summary: "auto" } },
    { reasoning: { effort: "max", summary: "auto" } }],
  ["anthropic-messages", "/messages", { thinking: { type: "enabled", budget_tokens: 1024 }, output_config: { effort: "high", format: { type: "json_schema" } } },
    { thinking: { type: "adaptive" }, output_config: { effort: "max", format: { type: "json_schema" } } }],
])("model relay overrides %s defaults in every request and retains model errors", async (api, route, defaults, expected) => {
  const received = [];
  const upstream = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    received.push(JSON.parse(body));
    res.writeHead(400, { "content-type": "application/json" }).end('{"error":{"message":"unsupported effort"}}');
  });
  await new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve));
  const relay = await startModelRelay({ api, baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`,
    apiKey: "upstream-fixture", token: "local-fixture", reasoningEffort: "max" });
  try {
    const headers = api === "anthropic-messages" ? { "x-api-key": "local-fixture" } : { authorization: "Bearer local-fixture" };
    for (let round = 0; round < 2; round++) {
      const auth = api === "anthropic-messages" && round === 1 ? { authorization: "Bearer local-fixture" } : headers;
      const result = await fetch(relay.endpoint + route, { method: "POST", headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({ model: "fixture", ...defaults }) });
      expect(result.status).toBe(400);
      expect(await result.json()).toEqual({ error: { message: "unsupported effort" } });
    }
    expect(received).toEqual([{ model: "fixture", ...expected }, { model: "fixture", ...expected }]);
  } finally {
    relay.close();
    upstream.closeAllConnections();
    await new Promise(resolve => upstream.close(resolve));
  }
});

test("reasoning overrides preserve other fields and leave the original payload untouched", () => {
  const source = { reasoning_effort: "low", chat_template_kwargs: { reasoning_effort: "low", enable_thinking: false, other: 1 } };
  expect(applyReasoningEffort(source, "openai-completions", "max")).toEqual({
    reasoning_effort: "max", chat_template_kwargs: { reasoning_effort: "max", enable_thinking: true, other: 1 },
  });
  expect(source.chat_template_kwargs.enable_thinking).toBe(false);
  expect(() => applyReasoningEffort(null, "openai-completions", "max")).toThrow(/JSON object/);
});

test.each([
  ["openai-completions", "/v1", "/chat/completions", "authorization", "Bearer "],
  ["openai-responses", "/v1", "/responses", "authorization", "Bearer "],
  ["anthropic-messages", "", "/messages", "x-api-key", ""],
])("ZCode relay isolates the key and forwards only the configured %s route", async (api, base, method, header, prefix) => {
  const upstream = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    upstream.push({ url: req.url, authorization: req.headers[header], body });
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end("data: fixture\n\n");
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const relay = await startModelRelay({
    api, baseUrl: "http://127.0.0.1:" + server.address().port + "/gateway" + base, apiKey: "private-upstream-key", token: "local-key",
  });
  try {
    const headers = { [header]: prefix + "local-key", "content-type": "application/json" };
    const request = { method: "POST", headers, body: '{"model":"fixture"}' };
    expect((await fetch(relay.endpoint + "/unrelated", request)).status).toBe(404);
    expect((await fetch(relay.endpoint + method, { ...request, headers: { [header]: "invalid" } })).status).toBe(401);
    const response = await fetch(relay.endpoint + method, request);
    expect(await response.text()).toBe("data: fixture\n\n");
    expect(upstream).toEqual([{ url: "/gateway/v1" + method, authorization: prefix + "private-upstream-key", body: request.body }]);
  } finally {
    relay.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
