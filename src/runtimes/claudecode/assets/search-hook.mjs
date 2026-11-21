import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { text } from "node:stream/consumers";
import { searchWeb } from "./infrastructure/network/web-search.mjs";

const event = JSON.parse(await text(process.stdin));
const output = process.argv[2];
const record = async entry => {
  if (!output) return;
  await mkdir(output, { recursive: true });
  await appendFile(join(output, "web-search.jsonl"), JSON.stringify({ tool: "WebSearch", ...entry }) + "\n", { mode: 0o600 });
};
if (event.tool_name === "WebSearch") {
  const args = event.tool_input;
  const results = event.tool_response?.results;
  const entries = Array.isArray(results) ? results.flatMap(item => item?.content ?? []) : [];
  const sources = entries.filter(item => typeof item?.url === "string" && /^https?:\/\//u.test(item.url));
  if (sources.length) {
    await record({ backend: "native", sources: sources.map(({ url, title }) => ({ url, title })) });
  } else if (args?.allowed_domains?.length || args?.blocked_domains?.length) {
    await record({ backend: "native", failure: "no sources; supplementary search cannot enforce these domain filters" });
  } else {
    let additionalContext;
    try {
      const result = await searchWeb(args?.query, { api: "anthropic-messages", baseUrl: process.env.ANTHROPIC_BASE_URL,
        apiKey: process.env.ANTHROPIC_API_KEY, model: process.env.ANTHROPIC_MODEL }, AbortSignal.timeout(125000));
      await record({ backend: result.backend, sources: result.results, failures: ["native: no sources", ...result.failures] });
      additionalContext = JSON.stringify({ backend: result.backend, sources: result.results });
    } catch (error) {
      await record({ failure: error.message });
      additionalContext = "Supplementary search failed: " + error.message;
    }
    console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: event.hook_event_name, additionalContext } }));
  }
}
