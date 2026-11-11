import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { pipeline } from "node:stream/promises";

const requestHeaders = ["accept", "anthropic-beta", "anthropic-version", "content-type", "user-agent"];
const responseHeaders = ["content-type", "retry-after", "request-id"];

// The real service key stays in this process. The CLI only receives a
// disposable key for a relay scoped to this attempt's Messages endpoint.
export async function startMessagesRelay(baseUrl, apiKey) {
  const key = randomUUID();
  const server = createServer(async (request, response) => {
    if (request.headers["x-api-key"] !== key) return response.writeHead(401).end();
    const url = URL.parse(request.url, "http://localhost");
    if (request.method !== "POST" || !url || !["/v1/messages", "/v1/messages/count_tokens"].includes(url.pathname)) {
      return response.writeHead(404).end();
    }
    const controller = new AbortController();
    response.once("close", () => controller.abort());
    try {
      const headers = new Headers({ "x-api-key": apiKey });
      for (const name of requestHeaders) {
        const value = request.headers[name];
        if (typeof value === "string") headers.set(name, value);
      }
      const upstream = await fetch(baseUrl + url.pathname + url.search, {
        method: "POST", headers, body: request, duplex: "half", redirect: "error", signal: controller.signal,
      });
      for (const name of responseHeaders) {
        const value = upstream.headers.get(name);
        if (value !== null) response.setHeader(name, value);
      }
      response.writeHead(upstream.status);
      if (upstream.body) await pipeline(upstream.body, response, { signal: controller.signal });
      else response.end();
    } catch {
      if (response.destroyed) return;
      if (response.headersSent) response.destroy();
      else response.writeHead(502, { "content-type": "application/json" })
        .end(JSON.stringify({ type: "error", error: { type: "api_error", message: "Claude Code model relay could not reach its upstream" } }));
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    endpoint: `http://127.0.0.1:${server.address().port}`,
    key,
    close() {
      server.close();
      server.closeAllConnections();
    },
  };
}
