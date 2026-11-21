import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { text } from "node:stream/consumers";

// Use only URLs returned by the backend's search result or citation fields.
function sources(entries) {
  const unique = new Map();
  for (const entry of entries) {
    const url = URL.parse(entry?.url);
    if (url && !url.username && !url.password && ["http:", "https:"].includes(url.protocol)) {
      unique.set(url.href, { url: url.href, title: entry.title || url.hostname });
    }
  }
  return [...unique.values()];
}

async function post(url, headers, body, signal) {
  const response = await fetch(url, {
    method: "POST", headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body), signal, redirect: "error",
  });
  if (!response.ok) {
    // LiteLLM may wrap the provider's structured error inside its message.
    // Report actionable codes without copying upstream diagnostics or credentials into the trajectory.
    const detail = await response.json().catch(() => null);
    const error = detail?.error;
    const providerError = [error?.code, error?.message].filter(value => typeof value === "string").join(" ");
    if (/\bToolNotOpen\b|access denied for web search/iu.test(providerError)) {
      throw Error(`HTTP ${response.status}: provider web search is not activated or authorized`);
    }
    if (/\bmodel_not_found\b|no healthy deployments for this model/iu.test(providerError)) {
      throw Error(`HTTP ${response.status}: the selected model has no available search route`);
    }
    throw Error("HTTP " + response.status);
  }
  if (response.headers.get("content-type")?.includes("text/event-stream")) {
    for (const line of (await response.text()).split(/\r?\n/u)) {
      if (line.startsWith("data:")) {
        const message = JSON.parse(line.slice(5));
        if (message.result || message.error) return message;
      }
    }
    throw Error("search service returned no result event");
  }
  return response.json();
}

async function exaSearch(query, signal) {
  const reply = await post("https://mcp.exa.ai/mcp?tools=web_search_exa", { accept: "application/json, text/event-stream" }, {
    jsonrpc: "2.0", id: 1, method: "tools/call",
    params: { name: "web_search_exa", arguments: { query, numResults: 5 } },
  }, signal);
  if (reply.error || reply.result?.isError) throw Error("Exa tool call failed");
  const content = (reply.result?.content ?? []).map(block => block.text ?? "").join("\n");
  const results = sources([...content.matchAll(/^Title: (.+)\r?\nURL: (https?:\/\/\S+)/gmu)]
    .map(match => ({ title: match[1], url: match[2] })));
  if (!results.length) throw Error("Exa returned no sources");
  return { backend: "exa", results, content };
}

async function providerSearch(query, { api, baseUrl, apiKey, model }, signal) {
  if (!baseUrl || !apiKey) throw Error("selected model service has no endpoint or credential");
  const base = baseUrl.replace(/\/+$/u, "");
  const bearer = { authorization: "Bearer " + apiKey };
  let entries;
  if (api === "openai-responses") {
    const reply = await post(base + "/responses", bearer, {
      model, input: query, tools: [{ type: "web_search", sources: ["doubao"] }],
      // Ark returns URL citations on the message and rejects OpenAI's optional sources include.
      tool_choice: { type: "web_search" },
    }, signal);
    entries = (reply.output ?? []).flatMap(item => item.type === "web_search_call" ? item.action?.sources ?? []
      : (item.content ?? []).flatMap(part => (part.annotations ?? []).filter(a => a.type === "url_citation")));
  } else if (api === "openai-completions") {
    const reply = await post(base + "/chat/completions", bearer, {
      model, messages: [{ role: "user", content: query }], web_search_options: {},
    }, signal);
    entries = (reply.choices?.[0]?.message?.annotations ?? []).filter(a => a.type === "url_citation").map(a => a.url_citation ?? a);
  } else if (api === "anthropic-messages") {
    const reply = await post(base + (base.endsWith("/v1") ? "/messages" : "/v1/messages"),
      { "x-api-key": apiKey, "anthropic-version": "2023-06-01" }, {
        model, max_tokens: 1024, messages: [{ role: "user", content: query }],
        tools: [{ type: "web_search_20250305", name: "web_search" }], tool_choice: { type: "tool", name: "web_search" },
      }, signal);
    entries = (reply.content ?? []).flatMap(block => block.type === "web_search_tool_result" && Array.isArray(block.content)
      ? block.content.filter(item => item.type === "web_search_result") : block.citations ?? []);
  } else throw Error("selected model API does not expose hosted search");
  const results = sources(entries);
  if (!results.length) throw Error("selected model route returned no search sources");
  return { backend: "model-service", results };
}

export async function searchWeb(query, service, signal, skipExa = false) {
  if (typeof query !== "string" || !query.trim()) throw Error("web search requires a query");
  const failures = [];
  const backends = skipExa ? ["model-service"] : ["exa"];
  if (!skipExa && !service.exaOnly) backends.push("model-service");
  for (const backend of backends) {
    signal.throwIfAborted();
    const timeout = AbortSignal.any([signal, AbortSignal.timeout(backend === "exa" ? 30_000 : 90_000)]);
    try {
      const result = backend === "exa" ? await exaSearch(query, timeout) : await providerSearch(query, service, timeout);
      return { ...result, failures };
    } catch (error) {
      signal.throwIfAborted();
      failures.push(backend + ": " + error.message);
    }
  }
  throw Error(failures.join("; "));
}

// Stateless Streamable HTTP server inside the solve environment. The CLI sees
// a local capability URL. Only this process receives the upstream credential.
export async function startSearchMcp(service, skipExa = false, record, fetchPage) {
  const path = "/" + randomUUID();
  const lifetime = new AbortController();
  const tool = { name: "web_search", description: "Search public web sources. If your tool list has no native WebSearch, or native search returned no sources, call this tool directly. Its result includes source titles and URLs you can cite.",
    inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } };
  const tools = service.toolPolicy?.webSearch === "disabled" ? [] : [tool];
  if (fetchPage) tools.push({ name: "web_fetch", description: "Read the actual body of a public HTTP or HTTPS webpage by URL.",
    inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } });
  const server = createServer(async (req, res) => {
    if (req.url !== path) return res.writeHead(404).end();
    if (req.method !== "POST") return res.writeHead(405).end();
    const controller = new AbortController();
    res.once("close", () => controller.abort());
    let id = null;
    const send = data => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id, ...data }));
    try {
      const message = JSON.parse(await text(req));
      id = message.id;
      if (id === undefined) return res.writeHead(202).end();
      let result;
      if (message.method === "initialize") result = { protocolVersion: message.params.protocolVersion,
        capabilities: { tools: {} }, serverInfo: { name: "evaluator-search", version: "1" } };
      else if (message.method === "tools/list") result = { tools };
      else if (message.method === "ping") result = {};
      else if (message.method === "tools/call" && tools.some(entry => entry.name === message.params.name)) {
        const isFetch = message.params.name === "web_fetch";
        try {
          const signal = AbortSignal.any([lifetime.signal, controller.signal]);
          const found = isFetch ? await fetchPage(message.params.arguments?.url, signal)
            : await searchWeb(message.params.arguments?.query, service, signal, skipExa);
          await record?.(isFetch ? { backend: "http-fetch", status: found.status, truncated: found.truncated }
            : { backend: found.backend, sources: found.results, failures: found.failures });
          result = { content: [{ type: "text", text: JSON.stringify(found) }] };
        } catch (error) {
          await record?.({ ...(isFetch ? { backend: "http-fetch" } : {}), failure: error.message });
          result = { isError: true, content: [{ type: "text", text: error.message }] };
        }
      } else return send({ error: { code: -32601, message: "Method not found" } });
      send({ result });
    } catch { if (!res.destroyed) send({ error: { code: -32600, message: "Invalid request" } }); }
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return { url: "http://127.0.0.1:" + server.address().port + path, close() { lifetime.abort(); server.close(); server.closeAllConnections(); } };
}
