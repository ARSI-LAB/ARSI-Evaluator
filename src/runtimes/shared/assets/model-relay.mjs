import { createServer } from "node:http";
import { pipeline } from "node:stream/promises";

const routes = {
  "openai-completions": ["/chat/completions"],
  "openai-responses": ["/responses"],
  "anthropic-messages": ["/messages", "/messages/count_tokens"],
};
const requestHeaders = ["accept", "anthropic-beta", "anthropic-version", "content-type", "user-agent"];
const responseHeaders = ["content-type", "retry-after", "request-id"];

export async function startModelRelay({ api, baseUrl, apiKey, token }) {
  const anthropic = api === "anthropic-messages";
  const base = anthropic && !baseUrl.endsWith("/v1") ? baseUrl + "/v1" : baseUrl;
  const server = createServer(async (request, response) => {
    const authorized = anthropic ? request.headers["x-api-key"] === token
      : request.headers.authorization === "Bearer " + token;
    if (!authorized) return response.writeHead(401).end();
    const url = URL.parse(request.url, "http://localhost");
    const route = routes[api]?.find(path => url?.pathname === "/v1" + path);
    if (request.method !== "POST" || !route) return response.writeHead(404).end();
    const controller = new AbortController();
    response.once("close", () => controller.abort());
    try {
      const headers = new Headers(anthropic ? { "x-api-key": apiKey } : { authorization: "Bearer " + apiKey });
      for (const name of requestHeaders) {
        const value = request.headers[name];
        if (typeof value === "string") headers.set(name, value);
      }
      const upstream = await fetch(base + route + url.search, {
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
        .end(JSON.stringify({ error: { message: "Model relay could not reach its upstream" } }));
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    endpoint: "http://127.0.0.1:" + server.address().port + "/v1",
    close() {
      server.close();
      server.closeAllConnections();
    },
  };
}
