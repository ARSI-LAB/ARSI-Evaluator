// Minimal keyless OpenAI-compatible mock server for the Hermes adapter smoke.
// Returns a single-shot final answer (no tool calls) so the smoke exercises
// install -> model_aliases/-m binding -> finalText -> usage -> trajectory
// without touching office-agent network providers.
import { createServer } from "node:http";

const port = process.argv[2] ? Number(process.argv[2]) : 0;
const model = "office-mock-model";

function chunk(delta, finishReason) {
  return { id: "hermes-mock", object: "chat.completion.chunk", created: 1, model,
    choices: delta === null ? [] : [{ index: 0, delta, finish_reason: finishReason }] };
}

const server = createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/v1/models") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ object: "list", data: [{ id: model, object: "model" }] }));
    return;
  }
  if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
    response.writeHead(404).end();
    return;
  }
  const parts = [];
  for await (const part of request) parts.push(part);
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  response.write(`data: ${JSON.stringify(chunk({ role: "assistant", content: "Answer: 42" }, null))}\n\n`);
  response.write(`data: ${JSON.stringify(chunk({}, "stop"))}\n\n`);
  response.write(`data: ${JSON.stringify({ ...chunk(null, "stop"), usage: { prompt_tokens: 11, completion_tokens: 5, total_tokens: 16 } })}\n\n`);
  response.end("data: [DONE]\n\n");
});

server.listen(port, "127.0.0.1", () => {
  const address = server.address();
  process.stdout.write(`${JSON.stringify({ port: address.port })}\n`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
