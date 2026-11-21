import { afterEach, expect, test, vi } from "vitest";
import { searchWeb } from "../../src/infrastructure/network/web-search.mjs";
import { nativeSearchFallback, taskServers } from "../../src/runtimes/shared/assets/task-resources.mjs";
import { fetchWebPage } from "../../src/runtimes/codex/assets/web-fetch.mjs";

const service = { baseUrl: "https://gateway.example/v1", model: "selected", apiKey: "fixture" };
const signal = new AbortController().signal;
const source = { title: "Source", url: "https://docs.example.org/page" };
afterEach(() => vi.unstubAllGlobals());

test.each([
  [{ webSearch: "disabled", webFetch: "enabled" }, ["web_fetch"], "web_search"],
  [{ webSearch: "enabled", webFetch: "disabled" }, ["web_search"], "web_fetch"],
])("the MCP rejects calls to the missing tool as well as omitting it from discovery", async (toolPolicy, expected, missing) => {
  const fetchPage = vi.fn();
  const resources = await taskServers({ toolPolicy }, false, toolPolicy.webFetch === "enabled" ? fetchPage : undefined);
  const call = async (method, params) => (await fetch(resources.servers[0].url, { method: "POST",
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json();
  try {
    const listing = await call("tools/list", {});
    expect(listing.result.tools.map(tool => tool.name)).toEqual(expected);
    expect((await call("tools/call", { name: missing, arguments: {} })).error.code).toBe(-32601);
    expect(fetchPage).not.toHaveBeenCalled();
  } finally {
    resources.close();
  }
});

test("Codex fetch rejects private URLs and out-of-scope domains before connecting", async () => {
  for (const url of ["file:///a", "https://u:p@example.com", "http://127.0.0.1", "http://[::1]", "http://localhost"]) {
    await expect(fetchWebPage(url, undefined, signal)).rejects.toThrow(/public HTTP/u);
  }
  await expect(fetchWebPage("https://example.org", ["*.example.org"], signal)).rejects.toThrow(/allowlist/u);
});

test("search-only Codex never tries the provider when Exa fails", async () => {
  const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 503 }));
  vi.stubGlobal("fetch", fetch);
  await expect(searchWeb("query", { ...service, exaOnly: true }, signal)).rejects.toThrow(/exa: HTTP 503/u);
  expect(fetch).toHaveBeenCalledTimes(1);
});

test("Exa returns source URLs without sending the model credential to Exa", async () => {
  const fetch = vi.fn(async () => Response.json({ result: { content: [{ text: "Title: Source\nURL: " + source.url }] } }));
  vi.stubGlobal("fetch", fetch);
  expect(await searchWeb("query", service, signal)).toMatchObject({ backend: "exa", results: [source], failures: [] });
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch.mock.calls[0][1].headers).not.toHaveProperty("authorization");
});

test.each([
  ["openai-completions", "/chat/completions", { choices: [{ message: { annotations: [{ type: "url_citation", url_citation: source }] } }] }],
  ["openai-responses", "/responses", { output: [{ type: "web_search_call", action: { sources: [source] } }] }],
  ["anthropic-messages", "/messages", { content: [{ type: "web_search_tool_result", content: [{ type: "web_search_result", ...source }] }] }],
])("failed Exa searches use the current %s model route", async (api, path, payload) => {
  const fetch = vi.fn().mockResolvedValueOnce(new Response(null, { status: 429 })).mockResolvedValueOnce(Response.json(payload));
  vi.stubGlobal("fetch", fetch);
  expect(await searchWeb("query", { ...service, api }, signal)).toMatchObject({
    backend: "model-service", results: [source], failures: ["exa: HTTP 429"],
  });
  expect(fetch.mock.calls[1][0]).toBe(service.baseUrl + path);
  expect(JSON.parse(fetch.mock.calls[1][1].body).model).toBe(service.model);
});

test("Ark Responses requests accept citations without an unsupported sources include", async () => {
  const fetch = vi.fn(async (_url, options) => {
    const body = JSON.parse(options.body);
    expect(body.tools).toEqual([{ type: "web_search", sources: ["doubao"] }]);
    expect(body).not.toHaveProperty("include");
    return Response.json({ output: [
      { type: "web_search_call", action: { type: "search" } },
      { type: "message", content: [{ type: "output_text", annotations: [{ type: "url_citation", ...source }] }] },
    ] });
  });
  vi.stubGlobal("fetch", fetch);
  expect(await searchWeb("query", { ...service, api: "openai-responses" }, signal, true))
    .toMatchObject({ backend: "model-service", results: [source] });
});

test("OpenCode skips a second Exa attempt and rejects model text without citations", async () => {
  const fetch = vi.fn(async () => Response.json({ choices: [{ message: { content: source.url } }] }));
  vi.stubGlobal("fetch", fetch);
  await expect(searchWeb("query", { ...service, api: "openai-completions" }, signal, true)).rejects.toThrow(/no search sources/u);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch.mock.calls[0][0]).toContain(service.baseUrl);
});

test.each([
  [404, "ToolNotOpen", "provider web search is not activated or authorized"],
  [403, "Access denied for web search", "provider web search is not activated or authorized"],
  [400, "There are no healthy deployments for this model", "the selected model has no available search route"],
])("reports the LiteLLM reason without exposing upstream diagnostics", async (status, message, reason) => {
  vi.stubGlobal("fetch", async () => Response.json({
    error: { message: "LiteLLM: " + JSON.stringify({ error: { message, credential: "private-value" } }) },
  }, { status }));
  await expect(searchWeb("query", { ...service, api: "openai-responses" }, signal, true))
    .rejects.toEqual(Error("model-service: HTTP " + status + ": " + reason));
});

test("restricted attempts never start the supplementary MCP search server", async () => {
  const server = { name: "task", url: "http://localhost/task", transport: "http" };
  for (const toolPolicy of [{ mcp: "disabled" }, { tools: "none", mcp: "disabled" }]) {
    expect(await taskServers({ mcpServers: [server], toolPolicy })).toEqual({ servers: [] });
  }
  expect(await taskServers({ mcpServers: [server], toolPolicy: { tools: "none" } })).toEqual({ servers: [server] });
  expect(await taskServers({ mcpServers: [server], toolPolicy: { webSearch: "disabled" } })).toEqual({ servers: [server] });
});

test("native search runs first and its empty result receives one supplementary result across retries", async () => {
  const complete = nativeSearchFallback("http://localhost/fixture", "evaluator-search");
  const fetch = vi.fn(async () => Response.json({ result: { content: [{ text: JSON.stringify({ backend: "exa", results: [source] }) }] } }));
  vi.stubGlobal("fetch", fetch);
  const request = { tools: ["websearch", "evaluator-search_web_search", "read"].map(name => ({ function: { name } })),
    messages: [{ role: "assistant", tool_calls: [{ id: "call-1", function: { name: "websearch", arguments: '{"query":"example"}' } }] },
      { role: "tool", tool_call_id: "call-1", content: "Error: missing native credentials" }] };
  for (let retry = 0; retry < 2; retry++) {
    const payload = structuredClone(request);
    await complete(payload, signal);
    expect(payload.tools.map(tool => tool.function.name)).toEqual(["websearch", "read"]);
    expect(payload.messages[1].content).toContain(source.url);
  }
  expect(fetch).toHaveBeenCalledTimes(1);
  const success = structuredClone(request);
  success.messages[1].content = "Title: Source\nURL: " + source.url;
  await complete(success, signal);
  expect(success.messages[1].content).not.toContain("Supplementary");
  expect(fetch).toHaveBeenCalledTimes(1);
});

test.each([
  { input: [{ type: "function_call", call_id: "a", name: "web_search", arguments: '{"query":"official docs"}' },
    { type: "function_call_output", call_id: "a", output: "No search results" }] },
  { messages: [{ role: "assistant", content: [{ type: "tool_use", id: "a", name: "WebSearch", input: { query: "official docs" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "a", is_error: true, content: [{ type: "text", text: "HTTP 403" }] }] }] },
])("supplements paired tool results across API protocols", async request => {
  const fetch = vi.fn(async () => Response.json({ result: { content: [{ text: JSON.stringify({ backend: "exa", results: [source] }) }] } }));
  vi.stubGlobal("fetch", fetch);
  await nativeSearchFallback("http://localhost/fixture", "evaluator-search")(request, signal);
  expect(JSON.stringify(request)).toContain(source.url);
  expect(fetch).toHaveBeenCalledTimes(1);
});

test("per-query domain restrictions never reach an unrestricted fallback", async () => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  const payload = { messages: [{ role: "assistant", tool_calls: [{ id: "a", function: { name: "WebSearch",
    arguments: JSON.stringify({ query: "docs", allowed_domains: ["docs.example.org"] }) } }] },
    { role: "tool", tool_call_id: "a", content: "No results" }] };
  await nativeSearchFallback("http://localhost/fixture", "evaluator-search")(payload, signal);
  expect(fetch).not.toHaveBeenCalled();
});
