import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import type { ExitResult, ProcessHandle } from "../../src/core/contracts/environment.js";
import type { ServiceBinding } from "../../src/core/contracts/plugin.js";
import { parseZCodeConfig, ZCodeSolver } from "../../src/plugins/solvers/zcode.js";
import { consumeZCode } from "../../src/runtimes/zcode/protocol.js";

const secrets = ["fixture-service-secret", "fixture-relay-token"];
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function context(signal = new AbortController().signal) {
  const agent = await mkdtemp(join(tmpdir(), "zcode-protocol-"));
  roots.push(agent);
  return { key: { runId: "run", taskId: "task", attemptId: "attempt" },
    paths: { root: agent, agent, verifier: agent, artifacts: agent }, signal };
}

async function* chunks(...parts: string[]) {
  for (const part of parts) yield Buffer.from(part);
}

function processWith(output: string, code = 0): ProcessHandle {
  return { stdout: chunks(output), stderr: chunks(secrets.join(" ") + "\n"),
    done: Promise.resolve({ code, signal: null }), stop: vi.fn(async () => {}) };
}

const jsonl = (...events: object[]) => events.map(event => JSON.stringify(event) + "\n").join("");
const complete = { type: "turn.completed", payload: { resultType: "success" } };
const result = { type: "result", response: "答案 " + secrets.join(" "),
  usage: { inputTokens: 15, cacheReadTokens: 5, cacheWriteTokens: 2, outputTokens: 8, totalTokens: 23 } };

test("ZCode reads the final response and redacts both credentials without adding cache counts twice", async () => {
  const attempt = await context();
  await expect(consumeZCode(processWith(jsonl(complete, result)), attempt, secrets)).resolves.toEqual({
    finalText: "答案 [redacted] [redacted]", usage: { inputTokens: 15, outputTokens: 8, totalTokens: 23 },
  });
  for (const name of ["session.jsonl", "trajectory.jsonl", "stderr.log"]) {
    const evidence = await readFile(join(attempt.paths.agent, name), "utf8");
    for (const secret of secrets) expect(evidence).not.toContain(secret);
  }
  await expect(consumeZCode(processWith(jsonl(complete, { type: "result", response: "" })), await context(), secrets))
    .resolves.toEqual({ finalText: "", usage: { inputTokens: null, outputTokens: null, totalTokens: null } });
});

test.each([
  [jsonl(complete, result), 1, "SOLVER_PROCESS_CRASHED"],
  [jsonl({ type: "turn.failed" }, result), 0, "SOLVER_RESULT_INCOMPLETE"],
  [jsonl({ type: "turn.completed", payload: { resultType: "cancelled" } }, result), 0, "SOLVER_RESULT_INCOMPLETE"],
  [jsonl(complete), 0, "SOLVER_RESULT_INCOMPLETE"],
  [jsonl(result), 0, "SOLVER_RESULT_INCOMPLETE"],
  [jsonl(complete, result, result), 0, "SOLVER_PROTOCOL_INVALID"],
  [jsonl(complete) + '{"type":"result"', 0, "SOLVER_PROTOCOL_INVALID"],
] as const)("ZCode rejects incomplete and failed streams (%#)", async (output, code, expected) => {
  const attempt = await context();
  const handle = processWith(output, code);
  await expect(consumeZCode(handle, attempt, secrets)).rejects.toMatchObject({ code: expected });
  expect(handle.stop).toHaveBeenCalledOnce();
  expect(await readFile(join(attempt.paths.agent, "trajectory.jsonl"), "utf8")).toContain('"type":"error"');
});

test.each(["AbortError", "TimeoutError"])("ZCode stops the process and retains events on %s", async name => {
  const controller = new AbortController();
  const attempt = await context(controller.signal);
  const exit = Promise.withResolvers<ExitResult>();
  const handle = processWith(jsonl({ type: "turn.started" }));
  handle.done = exit.promise;
  handle.stop = vi.fn(async () => exit.resolve({ code: null, signal: "SIGTERM" }));
  const solved = consumeZCode(handle, attempt, secrets);
  const reason = new DOMException("stop attempt", name);
  controller.abort(reason);
  await expect(solved).rejects.toBe(reason);
  expect(handle.stop).toHaveBeenCalledOnce();
  expect(await readFile(join(attempt.paths.agent, "session.jsonl"), "utf8")).toContain("turn.started");
});

test("ZCode validates service settings without requiring credentials during preparation", async () => {
  const binding: ServiceBinding = {
    model: { name: "fixture", endpoint: "https://example.test/v1", api: "openai-completions", provider: null },
    auth: { value: "", reference: null },
  };
  expect(parseZCodeConfig({})).toEqual({});
  expect(() => parseZCodeConfig({ mode: "plan" })).toThrow(/unknown field/u);
  expect(() => new ZCodeSolver({ ...binding, model: { ...binding.model, api: "google-generative-ai" } })).toThrow(/requires api/u);
  expect(() => new ZCodeSolver({ ...binding, model: { ...binding.model, contextWindow: 10 } })).toThrow(/contextWindow/u);
  expect(await new ZCodeSolver(binding).runtimeInstallation(new AbortController().signal)).toMatchObject({ cacheName: "zcode-0.17.1" });
});
