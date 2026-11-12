import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { loadNetworkConfig } from "../../src/config/network.js";
import type { ServiceBinding } from "../../src/core/contracts/plugin.js";
import type { TaskAttachment } from "../../src/core/contracts/task.js";
import { PINNED_NODE_IMAGE } from "../../src/infrastructure/containers/runtime-contract.js";
import { NetworkRuntime } from "../../src/infrastructure/network/runtime.js";
import { DockerEnvironment } from "../../src/plugins/environments/docker/environment.js";
import { LocalEnvironment } from "../../src/plugins/environments/local/environment.js";
import { ClaudeCodeSolver } from "../../src/plugins/solvers/claudecode.js";
import { CodexSolver } from "../../src/plugins/solvers/codex.js";
import { ZCodeSolver } from "../../src/plugins/solvers/zcode.js";
import { fixturePNG } from "../fixtures/multimodal.js";

const secret = "fixture-cli-attachments-key";
const model = "fixture-cli-attachments";
const answer = "已收到附件";
const cases = [
  { name: "codex", Solver: CodexSolver, api: "openai-responses", nativePdf: false },
  { name: "claudecode", Solver: ClaudeCodeSolver, api: "anthropic-messages", nativePdf: true },
  { name: "zcode", Solver: ZCodeSolver, api: "openai-completions", nativePdf: true },
  { name: "zcode", Solver: ZCodeSolver, api: "openai-responses", nativePdf: true },
  { name: "zcode", Solver: ZCodeSolver, api: "anthropic-messages", nativePdf: true },
] as const;
type Api = (typeof cases)[number]["api"];

function countImages(value: unknown): number {
  if (Array.isArray(value)) return value.reduce<number>((count, item) => count + countImages(item), 0);
  if (!value || typeof value !== "object") return 0;
  if (["image", "input_image", "image_url"].includes(Reflect.get(value, "type"))) return 1;
  return Object.values(value).reduce<number>((count, item) => count + countImages(item), 0);
}

function sendEvents(res: ServerResponse, events: readonly { type: string }[]) {
  for (const event of events) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  res.end();
}

async function modelFixture(api: Api, docker: boolean) {
  const requests: Array<{ model: unknown; authenticated: boolean; input: string }> = [];
  const server = createServer(async (req, res) => {
    const route = api === "openai-responses" ? "responses" : api === "anthropic-messages" ? "messages" : "chat/completions";
    if (req.method !== "POST" || req.url?.split("?")[0] !== `/v1/${route}`) return res.writeHead(404).end();
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    requests.push({ model: body.model, authenticated: api === "anthropic-messages" ? req.headers["x-api-key"] === secret :
      req.headers.authorization === `Bearer ${secret}`, input: JSON.stringify(body.input ?? body.messages) });
    res.writeHead(200, { "content-type": "text/event-stream" });
    if (api === "openai-completions") {
      const meta = { id: "chatcmpl_1", model, created: 1, object: "chat.completion.chunk" };
      for (const item of [
        { choices: [{ index: 0, finish_reason: null, delta: { role: "assistant", content: answer } }] },
        { choices: [{ index: 0, finish_reason: "stop", delta: {} }], usage: { prompt_tokens: 15, completion_tokens: 7, total_tokens: 22 } },
      ]) res.write(`data: ${JSON.stringify({ ...meta, ...item })}\n\n`);
      return res.end("data: [DONE]\n\n");
    }
    if (api === "anthropic-messages") {
      const usage = { input_tokens: 15, output_tokens: 0 };
      const message = { id: "msg_1", type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage };
      const events = [
        { type: "message_start", message },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: answer } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 7 } },
        { type: "message_stop" },
      ];
      return sendEvents(res, events);
    }
    const part = { type: "output_text", text: answer, annotations: [], logprobs: [] };
    const item = { id: "msg_1", type: "message", role: "assistant", status: "completed", content: [part] };
    const response = { id: "resp_1", object: "response", created_at: 1, model, status: "in_progress", output: [] };
    const usage = { input_tokens: 15, output_tokens: 7, total_tokens: 22 };
    const events = [
      { type: "response.created", response },
      { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } },
      { type: "response.content_part.added", output_index: 0, content_index: 0, item_id: item.id, part: { ...part, text: "" } },
      { type: "response.output_text.delta", output_index: 0, content_index: 0, item_id: item.id, delta: answer, logprobs: [] },
      { type: "response.output_item.done", output_index: 0, item },
      { type: "response.completed", response: { ...response, status: "completed", output: [item], usage } },
    ];
    return sendEvents(res, events);
  });
  await new Promise<void>(resolve => server.listen(0, docker ? "0.0.0.0" : "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Model fixture failed to bind");
  return {
    requests, endpoint: `http://${docker ? "host.docker.internal" : "127.0.0.1"}:${address.port}${api === "anthropic-messages" ? "" : "/v1"}`,
    close: () => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

function popplerVersion(): string {
  const result = spawnSync("pdftoppm", ["-v"], { encoding: "utf8" });
  if (result.error) throw result.error;
  const version = /pdftoppm version (\d+\.\d+\.\d+)/u.exec(result.stderr + result.stdout)?.[1];
  if (!version) throw new Error("Unable to read the test node's Poppler version");
  return version;
}

const enabled = process.env.EVALUATOR_CLI_ATTACHMENTS_TEST;
for (const kind of ["local", "docker"] as const) {
  const docker = kind === "docker";
  const selected = docker ? cases.filter(item => item.name !== "zcode" || item.api === "anthropic-messages") : cases;
  test.skipIf(enabled !== "all" && enabled !== kind).each(selected)(
    `$name forwards image and PDF input to $api in ${kind}`, async ({ name, Solver, api, nativePdf }) => {
      const root = await mkdtemp(join(tmpdir(), "ember-cli-attachments-"));
      const mock = await modelFixture(api, docker);
      const networkPath = process.env.EVALUATOR_CLI_ATTACHMENTS_NETWORK;
      const network = new NetworkRuntime(networkPath === undefined ? undefined : await loadNetworkConfig(networkPath));
      const signal = AbortSignal.timeout(1_800_000);
      const paths = { root, agent: join(root, "agent"), verifier: join(root, "verifier"), artifacts: join(root, "artifacts") };
      const key = { runId: "attachment-fixture", taskId: name, attemptId: "first" };
      const binding: ServiceBinding = {
        model: { name: model, api, endpoint: mock.endpoint, provider: null, inputModalities: nativePdf ? ["text", "image", "pdf"] : ["text", "image"] },
        auth: { value: secret, reference: null },
      };
      const solver = new Solver(binding);
      try {
        const png = fixturePNG();
        const pdf = await readFile(new URL("../fixtures/multimodal/document.pdf", import.meta.url));
        const attachment = (path: string, bytes: Buffer) => ({ path, sha256: createHash("sha256").update(bytes).digest("hex") });
        const imageMetadata = attachment("docs/figure.png", png);
        const pdfMetadata = attachment("docs/public.pdf", pdf);
        const attachments: TaskAttachment[] = [
          { ...imageMetadata, kind: "image", mediaType: "image/png" },
          nativePdf ? { ...pdfMetadata, kind: "pdf", mode: "native" }
            : { ...pdfMetadata, kind: "pdf", mode: "pages", pages: [1], dpi: 144, rendererVersion: popplerVersion() },
        ];
        const initialFiles = await Promise.all([{ target: imageMetadata.path, bytes: png }, { target: pdfMetadata.path, bytes: pdf }].map(async ({ target, bytes }) => {
          const source = join(root, target.split("/").at(-1)!);
          await writeFile(source, bytes);
          return { source, target };
        }));
        const environment = docker ? new DockerEnvironment({ modelEndpoint: mock.endpoint, network })
          : new LocalEnvironment(undefined, undefined, network);
        const session = await environment.prepare({
          image: docker ? PINNED_NODE_IMAGE : null, workdir: docker ? "/workspace" : ".", initialFiles,
          runtime: solver.requirements(), installation: await solver.runtimeInstallation(signal),
          ...(docker ? { network: "model-api" } : {}),
        }, paths, "solve", signal);
        try {
          const task = { id: name, prompt: "查看两份附件", attachments };
          const textOnly = new Solver({ ...binding, model: { ...binding.model, inputModalities: ["text"] } });
          await expect(textOnly.solve(task, session, { key, paths, signal })).rejects.toMatchObject({ code: "BENCHMARK_UNSUPPORTED" });
          expect(mock.requests).toHaveLength(0);
          const result = await solver.solve(task, session, { key, paths, signal });
          expect(result.finalText).toBe(answer);
          expect(mock.requests).toHaveLength(1);
          expect(mock.requests[0]).toMatchObject({ model, authenticated: true });
          const input = mock.requests[0]!.input;
          expect(input).toContain("查看两份附件");
          expect(countImages(JSON.parse(input))).toBe(nativePdf ? 1 : 2);
          if (nativePdf) expect(input).toContain(pdf.toString("base64"));
          const media = await readFile(join(paths.agent, "session.jsonl"), "utf8");
          expect(media).not.toContain(secret);
          expect(media).not.toContain(pdf.toString("base64"));
        } finally {
          await session.dispose(AbortSignal.timeout(30_000));
        }
      } finally {
        await network.dispose();
        await mock.close();
        await rm(root, { recursive: true, force: true });
      }
    }, 1_830_000,
  );
}
