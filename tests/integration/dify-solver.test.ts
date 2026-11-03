import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";

import type { AttemptContext, AttemptKey, AttemptPaths, CommandSpec, EnvironmentSession, ProcessHandle } from "../../src/index.js";
import { DifySolver, DifySolverError, parseDifyConfig, resolveDifyAuth, type DifyBundleInstaller } from "../../src/plugins/solvers/dify.js";
import { classifyError } from "../../src/core/errors/classify.js";

const API_KEY = "app-dify-service-key";
const REPO_ROOT = resolve(import.meta.dirname ?? ".").includes("tests")
  ? resolve(join(import.meta.dirname ?? ".", "..", ".."))
  : process.cwd();
const HARNESS_ROOT = resolve(join(REPO_ROOT, "src", "adapters", "harness"));
let root: string;
let runtimeRoot: string;
let server: Server;
let baseUrl: string;
let requests: { method: string; path: string; authorization: string | null; body: string }[] = [];

function sse(res: ServerResponse, events: unknown[]): void {
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  for (const event of events) res.write(`data: ${JSON.stringify(event)}\n\n`);
  res.end();
}

function workflowEvents(status: string, report: string, totalTokens: number): unknown[] {
  return [
    { event: "workflow_started", data: { id: "dify-run-1" } },
    { event: "node_finished", data: { id: "n1", index: 1, node_id: "solve", node_type: "llm", title: "solve", status: "succeeded", elapsed_time: 1.5, execution_metadata: { total_tokens: totalTokens } } },
    { event: "workflow_finished", data: { id: "dify-run-1", status, outputs: { report }, error: status === "succeeded" ? "" : `boom ${API_KEY}` } },
  ];
}

async function startServer(): Promise<void> {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = "";
    req.on("data", chunk => { body += String(chunk); });
    req.on("end", () => {
      requests.push({ method: req.method ?? "", path: req.url ?? "", authorization: req.headers.authorization ?? null, body });
      if (req.url === "/v1/info") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ id: "3842c7d7-4d24-4a12-a4a4-f10460afcdd6", name: "office-agent", mode: "workflow" }));
        return;
      }
      if (req.url === "/v1/workflows/run" && req.method === "POST") {
        if (body.includes("transport-failure")) { res.destroy(); return; }
        const httpStatus = /http-status-(\d{3})/u.exec(body)?.[1];
        if (httpStatus) {
          res.writeHead(Number(httpStatus), { "Content-Type": "application/json" });
          res.end(JSON.stringify({ code: "upstream-private-code", message: "request rejected" }));
          return;
        }
        if (body.includes("fail-me")) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ code: "bad", message: `endpoint exploded ${API_KEY}` }));
          return;
        }
        const status = body.includes("fail-status") ? "failed" : "succeeded";
        sse(res, workflowEvents(status, "report body", 123));
        return;
      }
      if (req.url === "/v1/hang") return; // never responds; the caller aborts
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    });
  });
  await new Promise<void>(resolveListen => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("unexpected server address");
  baseUrl = `http://127.0.0.1:${address.port}`;
}

async function paths(name: string): Promise<AttemptPaths> {
  const base = join(root, name);
  const result = {
    root: base,
    agent: join(base, "agent"),
    verifier: join(base, "verifier"),
    artifacts: join(base, "artifacts"),
  };
  await Promise.all(Object.values(result).map(path => mkdir(path, { recursive: true })));
  return result;
}

/** Session that really spawns the requested command (the dify runner) — same seam as LocalEnvironment. */
function fakeSession(agentDir: string): EnvironmentSession {
  const start = async (command: CommandSpec, signal: AbortSignal): Promise<ProcessHandle> => {
    const child: ChildProcess = spawn(command.executable, command.args, { cwd: command.cwd, env: { ...process.env } });
    const runnerStdin = child.stdin;
    if (runnerStdin === null) throw new Error("spawned runner stdin unavailable");
    if (command.input !== null) runnerStdin.write(command.input);
    runnerStdin.end();
    const done = new Promise<{ code: number | null; signal: string | null }>(resolveDone => {
      child.on("close", (code, signal) => resolveDone({ code, signal: signal ?? null }));
    });
    signal.addEventListener("abort", () => child.kill("SIGTERM"), { once: true });
    const runnerStdout = child.stdout;
    const runnerStderr = child.stderr;
    if (runnerStdout === null || runnerStderr === null) throw new Error("spawned runner stdio unavailable");
    return {
      stdout: runnerStdout,
      stderr: runnerStderr,
      done,
      async stop(graceMs: number) {
        child.kill("SIGTERM");
        await Promise.race([done, new Promise(resolveWait => setTimeout(resolveWait, graceMs))]);
      },
    };
  };
  return {
    id: "fake",
    workdir: root,
    agentOutputDir: agentDir,
    verifierOutputDir: root,
    metadata: { kind: "local" },
    runtime: { root: runtimeRoot, persistent: true, identity: "fixture-runtime" },
    start,
    async upload() {},
    async download() {},
    async exportState() { throw new Error("unused"); },
    async restoreState() {},
    async dispose() {},
  };
}

async function attemptContext(name: string): Promise<AttemptContext> {
  const key: AttemptKey = { runId: "eval-run-1", taskId: "task-1", attemptId: "attempt-1" };
  return { key, paths: await paths(name), signal: new AbortController().signal };
}

function makeSolver(baseUrlOverride?: string): DifySolver {
  const config = parseDifyConfig({ baseUrl: baseUrlOverride ?? baseUrl, apiKeyEnv: "DIFY_TEST_API_KEY", appId: "app-1" });
  return new DifySolver(config, resolveDifyAuth(config));
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "evaluator-dify-solver-"));
  process.env["DIFY_TEST_API_KEY"] = API_KEY;
  await startServer();
  // materialize the runner the same way the generic runtime installation does
  runtimeRoot = join(root, "runtime");
  await mkdir(join(runtimeRoot, "dify"), { recursive: true });
  const { copyFile } = await import("node:fs/promises");
  const source = resolve(join(REPO_ROOT, "src", "adapters", "harness", "dify", "assets", "runner.mjs"));
  await copyFile(source, join(runtimeRoot, "dify", "runner.mjs"));
});

afterEach(() => {
  requests = [];
});

afterAll(async () => {
  await new Promise<void>((resolveClose, rejectClose) => server.close(error => error ? rejectClose(error) : resolveClose()));
  delete process.env["DIFY_TEST_API_KEY"];
  await rm(root, { recursive: true, force: true });
});

describe("parseDifyConfig", () => {
  test("accepts the documented fields and strips trailing slashes", () => {
    const config = parseDifyConfig({ baseUrl: "http://localhost///", apiKeyEnv: "KEY" });
    expect(config).toEqual({ baseUrl: "http://localhost", apiKeyEnv: "KEY" });
  });

  test("keeps an optional appId", () => {
    const config = parseDifyConfig({ baseUrl: "http://localhost", apiKeyEnv: "KEY", appId: "app-9" });
    expect(config.appId).toBe("app-9");
  });

  test("rejects unknown fields and empty values", () => {
    expect(() => parseDifyConfig({ baseUrl: "http://localhost", apiKeyEnv: "KEY", extra: true })).toThrow();
    expect(() => parseDifyConfig({ baseUrl: "", apiKeyEnv: "KEY" })).toThrow();
    expect(() => parseDifyConfig(null)).toThrow();
  });
});

describe("resolveDifyAuth", () => {
  test("resolves the key from the configured environment variable", () => {
    const config = parseDifyConfig({ baseUrl: "http://localhost", apiKeyEnv: "DIFY_TEST_API_KEY" });
    expect(resolveDifyAuth(config)).toEqual({ value: API_KEY, reference: "DIFY_TEST_API_KEY" });
  });

  test("rejects a missing environment variable", () => {
    const config = parseDifyConfig({ baseUrl: "http://localhost", apiKeyEnv: "DIFY_TEST_MISSING_KEY" });
    expect(() => resolveDifyAuth(config)).toThrow(/DIFY_TEST_MISSING_KEY/);
  });
});

describe("DifySolver", () => {
  test("provenance reports the app identity from /v1/info", async () => {
    const provenance = await makeSolver().provenance(new AbortController().signal);
    expect(provenance).toEqual({
      solver: "dify",
      appId: "app-1",
      appName: "office-agent",
      appMode: "workflow",
    });
  });

  test("solve maps the task prompt to inputs.task, runs the in-session runner, and collects evidence", async () => {
    const solver = makeSolver();
    const context = await attemptContext("success");
    const result = await solver.solve({ id: "task-1", prompt: "整理纪要" }, fakeSession(context.paths.agent), context);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.path).toBe("/v1/workflows/run");
    expect(requests[0]?.authorization).toBe(`Bearer ${API_KEY}`);
    const payload = JSON.parse(requests[0]?.body ?? "{}") as { inputs: { task: string }; response_mode: string };
    expect(payload.inputs.task).toBe("整理纪要");
    expect(payload.response_mode).toBe("streaming");
    expect(result.finalText).toBe("report body");
    expect(result.usage).toEqual({ inputTokens: null, outputTokens: null, totalTokens: 123 });
    const trace = await readFile(join(context.paths.agent, "dify-run-trace.jsonl"), "utf8");
    const lines = trace.trim().split("\n").map(line => JSON.parse(line) as Record<string, unknown>);
    expect(lines[0]).toMatchObject({ kind: "dify-run-header", difyRunId: "dify-run-1", attempt: { runId: "eval-run-1", taskId: "task-1", attemptId: "attempt-1" } });
    expect(lines.at(-1)).toMatchObject({ kind: "dify-run-summary", difyRunId: "dify-run-1", status: "succeeded", totalTokens: 123 });
    expect(lines.filter(line => line["kind"] === "dify-node")).toHaveLength(1);

    const trajectory = await readFile(join(context.paths.agent, "trajectory.jsonl"), "utf8");
    const events = trajectory.trim().split("\n").map(line => JSON.parse(line) as Record<string, unknown>);
    expect(events[0]).toMatchObject({ seq: 1, type: "start", key: { runId: "eval-run-1", taskId: "task-1", attemptId: "attempt-1" } });
    expect(events.at(-1)).toMatchObject({ type: "end", data: { status: "succeeded", totalTokens: 123 } });
    expect(events.map(event => event["seq"])).toEqual(events.map((_, index) => index + 1));
    const session = JSON.parse(await readFile(join(context.paths.agent, "session.jsonl"), "utf8")) as Record<string, unknown>;
    expect(session).toMatchObject({ kind: "dify", difyRunId: "dify-run-1", appId: "app-1" });
  });

  test("a failed workflow raises SOLVER_PROCESS_CRASHED with the key redacted and still writes evidence", async () => {
    const solver = makeSolver();
    const context = await attemptContext("failed-status");
    const error = await solver.solve({ id: "task-1", prompt: "fail-status" }, fakeSession(context.paths.agent), context).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(DifySolverError);
    expect((error as DifySolverError).code).toBe("SOLVER_PROCESS_CRASHED");
    expect((error as Error).message).not.toContain(API_KEY);
    expect((error as Error).message).toContain("[redacted]");
    const trajectory = await readFile(join(context.paths.agent, "trajectory.jsonl"), "utf8");
    const events = trajectory.trim().split("\n").map(line => JSON.parse(line) as Record<string, unknown>);
    expect(events.at(-1)).toMatchObject({ type: "end", data: { status: "failed" } });
  });

  test("an HTTP failure raises MODEL_UNAVAILABLE with the key redacted", async () => {
    const solver = makeSolver();
    const context = await attemptContext("http-failure");
    const error = await solver.solve({ id: "task-1", prompt: "fail-me" }, fakeSession(context.paths.agent), context).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(DifySolverError);
    expect((error as DifySolverError).code).toBe("MODEL_UNAVAILABLE");
    expect((error as Error).message).not.toContain(API_KEY);
  });

  test.each([[401, "MODEL_AUTH_FAILED"], [429, "MODEL_RATE_LIMIT"], [400, "MODEL_REQUEST_INVALID"]])(
    "HTTP %s is sent as registered code %s", async (status, code) => {
      const context = await attemptContext(`http-${status}`);
      const error: unknown = await makeSolver().solve({ id: "task-1", prompt: `http-status-${status}` }, fakeSession(context.paths.agent), context).catch((value: unknown) => value);
      expect(error).toMatchObject({ code, details: { httpStatus: status } });
      expect(JSON.stringify(error)).not.toContain("upstream-private-code");
    },
  );

  test("transport errno is retained as evidence without becoming the runner error code", async () => {
    const context = await attemptContext("transport");
    const error: unknown = await makeSolver().solve({ id: "task-1", prompt: "transport-failure" }, fakeSession(context.paths.agent), context).catch((value: unknown) => value);
    expect(error).toMatchObject({ code: "INTERNAL_ERROR" });
    expect(classifyError(error, { phase: "solve" }).details).toMatchObject({
      originalCode: expect.stringMatching(/^(?:UND_ERR_SOCKET|ECONNRESET)$/u), networkStage: "model-api",
    });
  });

  test("prepare returns a solver bound to the same execution", async () => {
    const solver = makeSolver();
    const context = await attemptContext("prepared");
    const prepared = await solver.prepare(fakeSession(context.paths.agent), context);
    const result = await prepared.solve({ id: "task-1", prompt: "整理纪要" }, context);
    expect(result.finalText).toBe("report body");
  });
});

describe("DifySolver bundle mode", () => {
  function bundleConfig(baseUrlOverride?: string) {
    return parseDifyConfig({
      baseUrl: baseUrlOverride ?? baseUrl,
      apiKeyEnv: "DIFY_TEST_API_KEY",
      bundlePath: "/bundles/math-solver",
      registryPath: "/tmp/dify-registry.json",
    });
  }

  function fakeInstaller(options?: { digest?: string; harnessName?: string; apiKey?: string; withKey?: boolean }) {
    const digest = options?.digest ?? "sha256:dd86bf9c8882";
    const withKey = options?.withKey ?? true;
    let installs = 0;
    let verifies = 0;
    return {
      installer: {
        async verify() {
          verifies += 1;
          return { digest, harnessName: options?.harnessName ?? "dify", versionRange: ">=1.17 <2" };
        },
        async install() {
          installs += 1;
          return {
            digest,
            installationId: "math-solver-dd86bf9c",
            appId: "app-installed-1",
            ...(withKey ? { apiKey: options?.apiKey ?? "app-install-key" } : {}),
            reused: installs > 1,
          };
        },
      },
      state: { get installs() { return installs; }, get verifies() { return verifies; } },
    };
  }

  function makeBundleSolver(installer: DifyBundleInstaller, baseUrlOverride?: string): DifySolver {
    return new DifySolver(bundleConfig(baseUrlOverride), { value: "", reference: null }, installer);
  }

  test("parseDifyConfig accepts bundlePath and registryPath", () => {
    const config = bundleConfig();
    expect(config.bundlePath).toBe("/bundles/math-solver");
    expect(config.registryPath).toBe("/tmp/dify-registry.json");
    expect(resolveDifyAuth(config)).toEqual({ value: "", reference: null });
  });

  test("provenance in bundle mode verifies the candidate and skips the info probe", async () => {
    const { installer, state } = fakeInstaller();
    const provenance = await makeBundleSolver(installer).provenance(new AbortController().signal);
    expect(state.verifies).toBe(1);
    expect(requests).toHaveLength(0);
    expect(provenance).toMatchObject({ solver: "dify", bundleDigest: "sha256:dd86bf9c8882" });
  });

  test("prepare installs once and solve uses the installed Service API key", async () => {
    const { installer, state } = fakeInstaller();
    const solver = makeBundleSolver(installer);
    const context = await attemptContext("bundle-solve");
    const prepared = await solver.prepare(fakeSession(context.paths.agent), context);
    const result = await prepared.solve({ id: "task-1", prompt: "1+1 等于几？" }, context);
    expect(state.installs).toBe(1);
    expect(result.finalText).toBe("report body");
    expect(requests[0]?.authorization).toBe("Bearer app-install-key");
    const trace = JSON.parse(
      (await readFile(join(context.paths.agent, "dify-run-trace.jsonl"), "utf8")).split("\n")[0] ?? "{}",
    ) as Record<string, unknown>;
    expect(trace).toMatchObject({
      appId: "app-installed-1",
      bundleDigest: "sha256:dd86bf9c8882",
      installationId: "math-solver-dd86bf9c",
    });
  });

  test("an installation without a key raises MODEL_AUTH_FAILED", async () => {
    const { installer } = fakeInstaller({ withKey: false });
    const solver = makeBundleSolver(installer);
    const context = await attemptContext("bundle-no-key");
    const error = await solver.prepare(fakeSession(context.paths.agent), context).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(DifySolverError);
    expect((error as DifySolverError).code).toBe("MODEL_AUTH_FAILED");
  });

  test("a digest change after locking raises SOURCE_CHANGED", async () => {
    const { installer } = fakeInstaller();
    const solver = makeBundleSolver(installer);
    const context = await attemptContext("bundle-identity");
    await solver.provenance(new AbortController().signal);
    (installer as unknown as { verify(): Promise<unknown> }).verify = async () =>
      ({ digest: "sha256:changed000", harnessName: "dify", versionRange: ">=1.17 <2" });
    const error = await solver.prepare(fakeSession(context.paths.agent), context).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(DifySolverError);
    expect((error as DifySolverError).code).toBe("SOURCE_CHANGED");
  });

  test("a non-dify harness raises ENV_RUNTIME_INSTALL_FAILED", async () => {
    const { installer } = fakeInstaller({ harnessName: "dsh" });
    const solver = makeBundleSolver(installer);
    const context = await attemptContext("bundle-harness");
    const error = await solver.prepare(fakeSession(context.paths.agent), context).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(DifySolverError);
    expect((error as DifySolverError).code).toBe("ENV_RUNTIME_INSTALL_FAILED");
  });
});
