import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import type { ExitResult, ProcessHandle } from "../../src/core/contracts/environment.js";
import type { AttemptContext } from "../../src/core/contracts/solver.js";
import type { ServiceBinding } from "../../src/core/contracts/plugin.js";
import { CodexSolver, parseCodexConfig } from "../../src/plugins/solvers/codex.js";
import { consumeCodex } from "../../src/runtimes/codex/protocol.js";

const secret = "fixture-api-key";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function attempt(signal = new AbortController().signal): Promise<AttemptContext> {
  const agent = await mkdtemp(join(tmpdir(), "codex-protocol-"));
  roots.push(agent);
  return { key: { runId: "run", taskId: "task", attemptId: "attempt" },
    paths: { root: agent, agent, verifier: agent, artifacts: agent }, signal };
}

async function* chunks(...values: Uint8Array[]) {
  yield* values;
}

function processWith(stdout: ProcessHandle["stdout"], code = 0): ProcessHandle {
  return {
    stdout,
    stderr: chunks(Buffer.from("request with fixture-"), Buffer.from("api-key\n")),
    done: Promise.resolve({ code, signal: null }),
    stop: vi.fn(async () => {}),
  };
}

const jsonl = (...events: object[]) => Buffer.from(events.map(event => JSON.stringify(event) + "\n").join(""));
const message = (text: string) => ({ type: "item.completed", item: { type: "agent_message", text } });
const complete = { type: "turn.completed", usage: { input_tokens: 13, cached_input_tokens: 5, output_tokens: 7, reasoning_output_tokens: 2 } };

test("Codex reads split UTF-8 events, selects the last answer and removes the key from all evidence", async () => {
  const context = await attempt();
  const output = jsonl({ type: "turn.started" }, message("working"), message(`答案\n${secret}`), complete);
  const split = output.indexOf(Buffer.from("答")) + 1;
  const result = await consumeCodex(processWith(chunks(output.subarray(0, split), output.subarray(split))), context, secret);
  expect(result).toEqual({ finalText: "答案\n[redacted]", usage: { inputTokens: 13, outputTokens: 7, totalTokens: 20 } });
  for (const filename of ["session.jsonl", "trajectory.jsonl", "stderr.log"]) {
    expect(await readFile(join(context.paths.agent, filename), "utf8")).not.toContain(secret);
  }
  const trajectory = (await readFile(join(context.paths.agent, "trajectory.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
  expect(trajectory.map(event => event.seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  expect(trajectory.at(-1)).toMatchObject({ type: "end", key: context.key });
});

test("Codex accepts an artifact-only turn and records missing usage as unknown", async () => {
  const result = await consumeCodex(processWith(chunks(jsonl({ type: "turn.completed" }))), await attempt(), secret);
  expect(result).toEqual({ finalText: "", usage: { inputTokens: null, outputTokens: null, totalTokens: null } });
});

test.each([
  [chunks(jsonl(complete)), 1, "SOLVER_PROCESS_CRASHED"],
  [chunks(jsonl({ type: "turn.failed", error: { message: "HTTP 401 Unauthorized" } })), 1, "MODEL_AUTH_FAILED"],
  [chunks(jsonl(message("partial"))), 0, "SOLVER_RESULT_INCOMPLETE"],
  [chunks(jsonl(message("partial")), Buffer.from('{"type":')), 0, "SOLVER_PROTOCOL_INVALID"],
] as const)("Codex retains partial evidence and rejects failed output (%#)", async (stdout, code, expected) => {
  const context = await attempt();
  const handle = processWith(stdout, code);
  await expect(consumeCodex(handle, context, secret)).rejects.toMatchObject({ code: expected });
  expect(handle.stop).toHaveBeenCalledOnce();
  const trajectory = await readFile(join(context.paths.agent, "trajectory.jsonl"), "utf8");
  expect(trajectory).toContain('"type":"error"');
  expect(trajectory).not.toContain('"type":"end"');
});

test.each([new DOMException("cancelled", "AbortError"), new DOMException("timed out", "TimeoutError")])(
  "Codex stops and preserves the abort reason (%s)", async reason => {
    const controller = new AbortController();
    const context = await attempt(controller.signal);
    const { promise: done, resolve } = Promise.withResolvers<ExitResult>();
    const handle = processWith(chunks(jsonl({ type: "turn.started" })));
    handle.done = done;
    handle.stop = vi.fn(async () => { resolve({ code: null, signal: "SIGTERM" }); });
    const result = consumeCodex(handle, context, secret);
    controller.abort(reason);
    await expect(result).rejects.toBe(reason);
    expect(handle.stop).toHaveBeenCalledOnce();
    expect(await readFile(join(context.paths.agent, "session.jsonl"), "utf8")).toContain('"type":"turn.started"');
  },
);

test("Codex validates service settings and supports preparation without credentials", () => {
  const binding: ServiceBinding = {
    model: { name: "fixture", endpoint: "http://127.0.0.1:1234/v1", provider: null, api: "openai-responses" },
    auth: { value: secret, reference: null },
  };
  expect(parseCodexConfig({})).toEqual({});
  expect(() => parseCodexConfig({ executable: "codex" })).toThrow(/unknown field executable/u);
  expect(() => new CodexSolver({ ...binding, model: { ...binding.model, api: "openai-completions" } })).toThrow(/openai-responses/u);
  expect(() => new CodexSolver({ ...binding, model: { ...binding.model, maxTokens: 50 } })).toThrow(/maxTokens/u);
  expect(() => new CodexSolver({ ...binding, auth: { value: "", reference: null } }).requirements()).not.toThrow();
});
