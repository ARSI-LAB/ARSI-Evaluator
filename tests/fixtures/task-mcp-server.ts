import { createServer, type ServerResponse } from "node:http";
export async function taskMcpServer() {
  const streams = new Set<ServerResponse>();
  let active: ServerResponse | undefined;
  const server = createServer(async (request, response) => {
    if (request.url === "/sse") {
      active = response; streams.add(response); response.on("close", () => streams.delete(response));
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.write("event: endpoint\ndata: /messages\n\n"); return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const message = JSON.parse(Buffer.concat(chunks).toString());
    response.writeHead(202); response.end();
    if (message.id === undefined) return;
    const result = message.method === "initialize"
      ? { protocolVersion: message.params.protocolVersion, serverInfo: { name: "fixture", version: "1" }, capabilities: { tools: {} } }
      : message.method === "tools/list"
        ? { tools: [{ name: "echo", description: "echo", inputSchema: { type: "object", properties: { value: { type: "string" } } } }] }
        : { content: [{ type: "text", text: message.params.arguments.value }] };
    active?.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n\n`);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No MCP fixture address");
  return { url: `http://127.0.0.1:${address.port}/sse`, activeConnections: () => streams.size,
    close: async () => { for (const stream of streams) stream.end(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); } };
}
