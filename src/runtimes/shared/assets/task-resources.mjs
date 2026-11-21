import { appendFile, cp, mkdir, readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { startSearchMcp } from "../../../infrastructure/network/web-search.mjs";

async function hasSkill(directory) {
  try { return (await stat(join(directory, "SKILL.md"))).isFile(); }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
}

// Task paths are inside the solve environment. Each CLI receives its own
// attempt-local skill tree; installing a task never mutates the source bundle.
export async function stageSkills(directories, destination) {
  for (const directory of directories ?? []) {
    const candidates = await hasSkill(directory) ? [directory] : (await readdir(directory, { withFileTypes: true }))
      .filter(entry => entry.isDirectory()).map(entry => join(directory, entry.name));
    for (const candidate of candidates) {
      if (!await hasSkill(candidate)) continue;
      await mkdir(destination, { recursive: true });
      await cp(candidate, join(destination, basename(candidate)), { recursive: true, force: false, errorOnExist: true });
    }
  }
}

export async function taskServers(input, skipExa = false, fetchPage) {
  const policy = input.toolPolicy ?? {};
  if (policy.mcp === "disabled") return { servers: [] };
  const servers = [...(input.mcpServers ?? [])];
  if (policy.tools === "none" || policy.webSearch === "disabled" && !fetchPage) return { servers };
  let name = "evaluator-search";
  while (servers.some(server => server.name === name)) name += "-fallback";
  const record = input.outputDir ? async event => {
    await mkdir(input.outputDir, { recursive: true });
    const fetch = event.backend === "http-fetch";
    await appendFile(join(input.outputDir, fetch ? "web-fetch.jsonl" : "web-search.jsonl"),
      JSON.stringify({ tool: name + (fetch ? "/web_fetch" : "/web_search"), ...event }) + "\n", { mode: 0o600 });
  } : undefined;
  const search = await startSearchMcp(input, skipExa, record, fetchPage);
  servers.push({ name, transport: "http", url: search.url });
  return { servers, close: search.close, completeSearch: policy.webSearch === "disabled" ? undefined
    : nativeSearchFallback(search.url, name, record, skipExa ? "exa" : "native") };
}

// A few CLIs expose WebSearch as a model function but have no post-tool hook.
// Complete the actual tool result on the next model turn, also for child agents.
// Keep the original result in the native transcript and reuse results on retries.
export function nativeSearchFallback(url, serverName, record, nativeBackend = "native") {
  const nativeTool = /^(?:web_?search|search_web)$/iu;
  const supplementary = new Set(["mcp__" + serverName + "__web_search", serverName + "_web_search"]);
  const completed = new Map();
  const recorded = new Set();
  return async (payload, signal) => {
    const nameOf = tool => tool?.function?.name ?? tool?.name;
    if (!payload.previous_response_id && Array.isArray(payload.tools) && payload.tools.some(tool => nativeTool.test(nameOf(tool)))) {
      payload.tools = payload.tools.filter(tool => !supplementary.has(nameOf(tool)));
    }
    const calls = new Map();
    const remember = (id, name, args) => {
      if (!id || !nativeTool.test(name)) return;
      if (typeof args === "string") {
        try { args = JSON.parse(args); } catch { return; }
      }
      const query = args?.query ?? args?.search_query;
      if (typeof query !== "string" || !query.trim()) return;
      if (Object.keys(args).some(key => /domain|site|filter/iu.test(key) && args[key]?.length)) return;
      calls.set(id, { name, query });
    };
    const complete = async (block, field, id, failed) => {
      const call = calls.get(id);
      if (!call) return;
      const { name, query } = call;
      const content = block[field];
      const original = Array.isArray(content) ? content.map(part => part?.text ?? JSON.stringify(part)).join("\n")
        : typeof content === "string" ? content : JSON.stringify(content ?? "");
      // Only use addresses present in the native tool output. An error can
      // itself contain a help URL, so HTTP/tool errors still need a fallback.
      const nativeError = failed || /^(?:error|failed)|tool_auth|unauthorized|no (?:search )?results/iu.test(original);
      const urls = nativeError ? [] : [...original.matchAll(/(?:\bURL:\s*|"(?:url|link)"\s*:\s*"|\]\()(https?:\/\/[^\s<>"\\)]+)/giu)]
        .map(match => URL.parse(match[1])).filter(link => link && !link.username && !link.password);
      const key = JSON.stringify([id, query]);
      if (record && !recorded.has(key)) {
        recorded.add(key);
        await record({ tool: name, origin: "native", backend: nativeBackend, ...(urls.length
          ? { sources: [...new Set(urls.map(link => link.href))].map(url => ({ url })) }
          : { failure: nativeError ? "native tool returned an error" : "native tool returned no source URLs" }) });
      }
      if (urls.length) return;
      let pending = completed.get(key);
      if (!pending) {
        pending = (async () => {
          const response = await fetch(url, { method: "POST", signal, redirect: "error",
            headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1,
              method: "tools/call", params: { name: "web_search", arguments: { query } } }) });
          if (!response.ok) throw Error("Supplementary search returned HTTP " + response.status);
          const reply = await response.json();
          const content = reply.result?.content?.[0]?.text;
          if (typeof content !== "string") throw Error("Supplementary search returned no tool result");
          if (reply.result.isError) return "Supplementary search failed: " + content;
          const found = JSON.parse(content);
          return JSON.stringify({ backend: found.backend, sources: found.results });
        })();
        completed.set(key, pending);
      }
      try {
        const extra = "\nSupplementary web search: " + await pending;
        if (typeof block[field] === "string") block[field] += extra;
        else if (Array.isArray(block[field])) block[field].push({ type: field === "output" ? "input_text" : "text", text: extra });
      } catch (error) {
        completed.delete(key);
        signal.throwIfAborted();
        throw error;
      }
    };
    for (const message of Array.isArray(payload.messages) ? payload.messages : []) {
      if (message.role === "assistant") {
        for (const call of message.tool_calls ?? []) remember(call.id, call.function?.name, call.function?.arguments);
        for (const block of Array.isArray(message.content) ? message.content : []) {
          if (block.type === "tool_use") remember(block.id, block.name, block.input);
        }
      } else if (message.role === "tool") await complete(message, "content", message.tool_call_id, false);
      else if (message.role === "user" && Array.isArray(message.content)) {
        for (const block of message.content) {
          if (block.type === "tool_result") await complete(block, "content", block.tool_use_id, block.is_error);
        }
      }
    }
    for (const item of Array.isArray(payload.input) ? payload.input : []) {
      if (item.type === "function_call") remember(item.call_id, item.name, item.arguments);
      else if (item.type === "function_call_output") await complete(item, "output", item.call_id, false);
    }
  };
}

export function nativeMcpConfig(servers) {
  return { mcpServers: Object.fromEntries(servers.map(({ name, transport, url }) => [name, { type: transport, url }])) };
}
