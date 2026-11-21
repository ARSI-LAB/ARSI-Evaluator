import { spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import type { ExitResult, ProcessHandle } from "../../src/core/contracts/environment.js";
import type { ServiceBinding } from "../../src/core/contracts/plugin.js";
import type { AttemptContext } from "../../src/core/contracts/solver.js";
import { CodeBuddySolver, parseCodeBuddyConfig } from "../../src/plugins/solvers/codebuddy.js";
import { consumeCodeBuddy } from "../../src/runtimes/codebuddy/protocol.js";

const secrets = ["fixture-codebuddy-upstream", "fixture-codebuddy-relay"];
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function attempt(signal = new AbortController().signal): Promise<AttemptContext> {
  const agent = await mkdtemp(join(tmpdir(), "codebuddy-protocol-"));
  roots.push(agent);
  return { key: { runId: "run", taskId: "task", attemptId: "attempt" }, paths: { root: agent, agent, verifier: agent, artifacts: agent }, signal };
}

async function* chunks(...values: Uint8Array[]) { yield* values; }

function processWith(stdout: ProcessHandle["stdout"], code = 0): ProcessHandle {
  return { stdout, stderr: chunks(Buffer.from(secrets.join(" ") + "\n")), done: Promise.resolve({ code, signal: null }), stop: vi.fn(async () => {}) };
}

const jsonl = (...events: object[]) => Buffer.from(events.map(event => JSON.stringify(event) + "\n").join(""));
const started = { type: "system", subtype: "init" };
const success = { type: "result", subtype: "success", is_error: false, result: `答案 ${secrets.join(" ")}` };

test("CodeBuddy uses aggregate tokens and redacts the upstream key and relay token", async () => {
  const context = await attempt();
  const result = await consumeCodeBuddy(processWith(chunks(jsonl(started, {
    ...success, usage: { input_tokens: 11, output_tokens: 4, cache_read_input_tokens: 3, cache_creation_input_tokens: 2 },
  }))), context, secrets);
  expect(result).toEqual({ finalText: "答案 [redacted] [redacted]", usage: { inputTokens: 11, outputTokens: 4, totalTokens: 15 } });
  for (const filename of ["session.jsonl", "trajectory.jsonl", "stderr.log"]) {
    const evidence = await readFile(join(context.paths.agent, filename), "utf8");
    for (const secret of secrets) expect(evidence).not.toContain(secret);
  }
});

test("CodeBuddy reports unknown token counts when usage is missing", async () => {
  const result = await consumeCodeBuddy(processWith(chunks(jsonl(success))), await attempt(), secrets);
  expect(result.usage).toEqual({ inputTokens: null, outputTokens: null, totalTokens: null });
});

test.each([
  [jsonl(success), 1, "SOLVER_PROCESS_CRASHED"],
  [jsonl({ type: "result", subtype: "error_during_execution", is_error: true, errors: ["HTTP 401 Unauthorized"] }), 0, "MODEL_AUTH_FAILED"],
  [Buffer.alloc(0), 0, "SOLVER_RESULT_INCOMPLETE"],
  [jsonl(success, success), 0, "SOLVER_PROTOCOL_INVALID"],
  [Buffer.from('{"type":"result"'), 0, "SOLVER_PROTOCOL_INVALID"],
] as const)("CodeBuddy rejects incomplete or failed attempts and saves evidence (%#)", async (output, code, expected) => {
  const context = await attempt();
  const handle = processWith(chunks(jsonl(started), output), code);
  await expect(consumeCodeBuddy(handle, context, secrets)).rejects.toMatchObject({ code: expected });
  expect(handle.stop).toHaveBeenCalledOnce();
  expect(await readFile(join(context.paths.agent, "session.jsonl"), "utf8")).toContain('"subtype":"init"');
  expect(await readFile(join(context.paths.agent, "trajectory.jsonl"), "utf8")).toContain('"type":"error"');
});

test.each([new DOMException("cancelled", "AbortError"), new DOMException("timed out", "TimeoutError")])(
  "CodeBuddy stops on abort and retains the reason (%s)", async reason => {
    const controller = new AbortController();
    const context = await attempt(controller.signal);
    const { promise: done, resolve } = Promise.withResolvers<ExitResult>();
    const handle = processWith(chunks(jsonl(started)));
    handle.done = done;
    handle.stop = vi.fn(async () => { resolve({ code: null, signal: "SIGTERM" }); });
    const pending = consumeCodeBuddy(handle, context, secrets);
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    expect(handle.stop).toHaveBeenCalledOnce();
    expect(await readFile(join(context.paths.agent, "session.jsonl"), "utf8")).toContain('"subtype":"init"');
  },
);

async function launch(root: string, workspace: string, payload: object, entry = "missing-cli"): Promise<ProcessHandle> {
  const installation = await new CodeBuddySolver({
    model: { name: "fixture", endpoint: "https://fixture.invalid/v1", provider: null, api: "openai-completions" },
    auth: { value: "", reference: null },
  }).runtimeInstallation(AbortSignal.timeout(5000));
  for (const file of installation.files) {
    const target = join(root, file.target);
    await mkdir(join(target, ".."), { recursive: true });
    await copyFile(file.source, target);
  }
  const child = spawn(process.execPath, [join(root, "launch.mjs"), join(root, "attempt"), join(root, entry)], { cwd: workspace, windowsHide: true });
  const done = new Promise<ExitResult>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  child.stdin.end(JSON.stringify(payload));
  return { stdout: child.stdout, stderr: child.stderr, done, async stop() { child.kill(); } };
}

test("CodeBuddy blocks a workspace models.json before starting the CLI and preserves the file", async () => {
  const context = await attempt();
  const root = context.paths.agent;
  const workspace = join(root, "workspace");
  await mkdir(join(workspace, ".codebuddy"), { recursive: true });
  const config = join(workspace, ".codebuddy", "models.json");
  const original = JSON.stringify({ models: [{ id: "fixture", url: "http://127.0.0.1:1/unexpected" }] });
  await writeFile(config, original);
  const handle = await launch(root, workspace, {});
  await expect(consumeCodeBuddy(handle, context, secrets)).rejects.toMatchObject({ code: "BENCHMARK_UNSUPPORTED", message: expect.stringContaining(".codebuddy/models.json") });
  expect(await readFile(config, "utf8")).toBe(original);
});

test("CodeBuddy writes only the relay token to the isolated model configuration", async () => {
  const context = await attempt();
  const root = context.paths.agent;
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  await writeFile(join(root, "fixture-cli.mjs"), `
import { readFileSync } from "node:fs";
import { join } from "node:path";
const config = readFileSync(join(process.env.CODEBUDDY_CONFIG_DIR, "models.json"), "utf8");
if (config.includes(${JSON.stringify(secrets[0])}) || Object.values(process.env).includes(${JSON.stringify(secrets[0])})) {
  throw new Error("Upstream key was exposed to the CLI");
}
if (JSON.parse(config).models[0].apiKey !== ${JSON.stringify(secrets[1])}) throw new Error("Missing relay token");
console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "isolated" }));
`);
  const handle = await launch(root, workspace, {
    apiKey: secrets[0], token: secrets[1], baseUrl: "http://127.0.0.1:1/v1", api: "openai-completions",
    model: "fixture", supportsImages: false, prompt: "test", media: [],
  }, "fixture-cli.mjs");
  await expect(consumeCodeBuddy(handle, context, secrets)).resolves.toMatchObject({ finalText: "isolated" });
});

test("CodeBuddy accepts both OpenAI protocols and prepares without a key", async () => {
  const binding: ServiceBinding = {
    model: { name: "fixture", endpoint: "https://service.test/v1", provider: null, api: "openai-completions", maxTokens: 123 },
    auth: { value: "", reference: null },
  };
  expect(parseCodeBuddyConfig({})).toEqual({});
  expect(() => parseCodeBuddyConfig({ executable: "codebuddy" })).toThrow(/unknown field executable/u);
  expect(() => new CodeBuddySolver({ ...binding, model: { ...binding.model, api: "openai-responses" } })).not.toThrow();
  expect(() => new CodeBuddySolver({ ...binding, model: { ...binding.model, api: "anthropic-messages" } })).toThrow(/openai-completions/u);
  expect(() => new CodeBuddySolver({ ...binding, model: { ...binding.model, endpoint: "https://service.test/v1/chat/completions" } })).toThrow(/base_url/u);
  expect(() => new CodeBuddySolver({ ...binding, model: { ...binding.model, contextWindow: 128000 } })).not.toThrow();
  expect(() => new CodeBuddySolver({ ...binding, model: { ...binding.model, retry: { maxAttempts: 2 } } })).toThrow(/does not support/u);
  const solver = new CodeBuddySolver(binding);
  const signal = AbortSignal.timeout(5000);
  const { capabilityPatchSha256 } = await solver.provenance(signal);
  expect(capabilityPatchSha256).toMatch(/^[a-f0-9]{64}$/u);
  expect((await solver.runtimeInstallation(signal)).id).toBe(`codebuddy:2.183.0:${capabilityPatchSha256}`);
});

test("CodeBuddy validates the optional execution turn limit", () => {
  expect(parseCodeBuddyConfig({ maxTurns: 2000, tools: "none" })).toEqual({ maxTurns: 2000, tools: "none" });
  for (const maxTurns of [0, -1, 1.5, "2000", null, true, Number.MAX_SAFE_INTEGER + 1]) {
    expect(() => parseCodeBuddyConfig({ maxTurns })).toThrow(/maxTurns must be a positive integer/u);
  }
});

test.each([undefined, 2000])("CodeBuddy passes an explicit maxTurns to its native CLI (%s)", async maxTurns => {
  const context = await attempt();
  const root = context.paths.agent;
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  await writeFile(join(root, "fixture-cli.mjs"), `
console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: JSON.stringify(process.argv.slice(2)) }));
`);
  const handle = await launch(root, workspace, {
    apiKey: secrets[0], token: secrets[1], baseUrl: "http://127.0.0.1:1/v1", api: "openai-completions",
    model: "fixture", supportsImages: false, prompt: "test", media: [], maxTurns,
  }, "fixture-cli.mjs");
  const result = await consumeCodeBuddy(handle, context, secrets);
  const args: string[] = JSON.parse(result.finalText);
  const index = args.indexOf("--max-turns");
  if (maxTurns === undefined) expect(index).toBe(-1);
  else {
    expect(index).toBeGreaterThan(-1);
    expect(args[index + 1]).toBe(String(maxTurns));
  }
});
