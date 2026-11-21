import { createInterface } from "node:readline";
import { once } from "node:events";

import { searchWeb, startSearchMcp } from "../../../infrastructure/network/web-search.mjs";
import { text } from "node:stream/consumers";

const [mode, api, baseUrl, model, keyVariable] = process.argv.slice(2);
const service = { api, baseUrl, model, apiKey: process.env[keyVariable] };
if (mode === "--query") {
  const result = await searchWeb(await text(process.stdin), service, AbortSignal.timeout(125_000));
  process.stdout.write(JSON.stringify(result));
} else {
  const backend = mode === "--serve" ? await startSearchMcp(service) : undefined;
  try {
    await forward(backend?.url ?? mode);
  } finally {
    backend?.close();
  }
}

async function forward(url) {
  for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
    if (!line.trim()) continue;
    const response = await fetch(url, { method: "POST", redirect: "error",
      headers: { "content-type": "application/json" }, body: line });
    if (!response.ok) throw Error("Local search server returned HTTP " + response.status);
    if (response.status === 202) continue;
    if (!process.stdout.write(JSON.stringify(await response.json()) + "\n")) await once(process.stdout, "drain");
  }
}
