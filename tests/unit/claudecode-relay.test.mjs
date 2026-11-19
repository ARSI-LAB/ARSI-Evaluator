import { createServer } from "node:http";
import { expect, test } from "vitest";
import { startModelRelay } from "../../src/runtimes/shared/assets/model-relay.mjs";

test("Claude Code relay scopes temporary credentials to Anthropic Messages requests", async () => {
  const received = [];
  const upstream = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk.toString("utf8");
    received.push({ path: request.url, key: request.headers["x-api-key"],
      authorization: request.headers.authorization, beta: request.headers["anthropic-beta"], body });
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write('event: message_start\ndata: {}\n\n');
    response.end('event: message_stop\ndata: {}\n\n');
  });
  await new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve));
  const key = "temporary-fixture-key";
  const relay = await startModelRelay({ api: "anthropic-messages",
    baseUrl: `http://127.0.0.1:${upstream.address().port}/anthropic/v1`, apiKey: "real-fixture-key", token: key });
  try {
    const send = (route, key) => fetch(new URL(relay.endpoint).origin + route, { method: "POST",
      headers: { "x-api-key": key, authorization: "Bearer do-not-forward", "anthropic-beta": "test", "content-type": "application/json" },
      body: '{"model":"fixture"}' });
    expect(key).not.toBe("real-fixture-key");
    expect((await send("/v1/messages", "wrong")).status).toBe(401);
    expect((await send("/outside", key)).status).toBe(404);
    const result = await send("/v1/messages?beta=true", key);
    expect(result.status).toBe(200);
    expect(result.headers.get("content-type")).toBe("text/event-stream");
    expect(await result.text()).toContain("event: message_stop");
    expect(received).toEqual([{ path: "/anthropic/v1/messages?beta=true", key: "real-fixture-key",
      authorization: undefined, beta: "test", body: '{"model":"fixture"}' }]);
  } finally {
    relay.close();
    upstream.closeAllConnections();
    await new Promise(resolve => upstream.close(resolve));
  }
});
