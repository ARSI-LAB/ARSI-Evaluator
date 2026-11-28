import { expect, test, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AisbenchSshSolver } from "../../solver.js";
import { AisbenchRemoteClient } from "../../ssh/client.js";
import { parseAisbenchSshConfig, parseWorkload } from "../../config.js";
import { bundleDigest } from "../../ssh/bundle.js";
import type { EnvironmentSession } from "arsi-evaluator";

const unused = async (): Promise<never> => { throw new Error("Unexpected local environment call"); };
const session: EnvironmentSession = { id: "local", workdir: "/unused", agentOutputDir: "/unused", verifierOutputDir: "/unused", metadata: {}, start: unused, upload: unused, download: unused, exportState: unused, restoreState: unused, dispose: unused };

test.each([true, false])("transport failure reconciles remote ownership; terminal=%s", async terminal => {
  const directory = await mkdtemp(join(tmpdir(), "aisbench-cleanup-"));
  const config = parseAisbenchSshConfig({ remote: { ssh: { host: "fixture", user: "bench" }, pythonExecutable: "/env/python", aisbenchWorkPath: "/bench", aisbenchVersion: "1", workRoot: "/jobs" }, tokenizerPath: "/model" });
  const solver = new AisbenchSshSolver(config, { services: { default: { model: { name: "fixture", endpoint: "http://127.0.0.1:8000/v1", provider: null, api: null }, auth: { value: "fixture-secret", reference: null } } }, solverService: "default", configDirectory: directory, resolvePath: path => path });
  vi.spyOn(AisbenchRemoteClient.prototype, "deploy").mockResolvedValue();
  const call = vi.spyOn(AisbenchRemoteClient.prototype, "call").mockResolvedValue({});
  vi.spyOn(AisbenchRemoteClient.prototype, "download").mockResolvedValue();
  const status = (state: string) => ({ state, phase: "solve", heartbeat: null, exitCode: null, log: "", offset: 0 });
  vi.spyOn(AisbenchRemoteClient.prototype, "status")
    .mockResolvedValueOnce(status("missing"))
    .mockRejectedValueOnce(new Error("transport disconnected"))
    .mockResolvedValueOnce(status(terminal ? "cancelled" : "running"));
  try {
    await expect(solver.solve({ id: "task", prompt: "fixture", payload: { kind: "aisbench", schemaVersion: 1, workload: parseWorkload({}), bundleDigest: await bundleDigest() } }, session, { key: { runId: "run", taskId: "task", attemptId: "attempt" }, paths: { root: directory, agent: join(directory, "agent"), artifacts: join(directory, "artifacts"), verifier: join(directory, "verifier") }, signal: new AbortController().signal })).rejects.toThrow("transport disconnected");
    expect(call.mock.calls.map(args => args[0])).toEqual(["start", "cancel"]);
    const marker = readFile(join(directory, "artifacts/aisbench/cleanup-unconfirmed.json"), "utf8");
    if (terminal) await expect(marker).rejects.toMatchObject({ code: "ENOENT" });
    else expect(JSON.parse(await marker).jobDir).toContain("/jobs/");
  } finally { vi.restoreAllMocks(); await rm(directory, { recursive: true, force: true }); }
});

test("completed measurement records a standard trajectory and session", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aisbench-trajectory-"));
  const config = parseAisbenchSshConfig({ remote: { ssh: { host: "fixture", user: "bench" }, pythonExecutable: "/env/python", aisbenchWorkPath: "/bench", aisbenchVersion: "1", workRoot: "/jobs" }, tokenizerPath: "/model" });
  const solver = new AisbenchSshSolver(config, { services: { default: { model: { name: "fixture", endpoint: "http://127.0.0.1:8000/v1", provider: null, api: null }, auth: { value: "fixture-secret", reference: null } } }, solverService: "default", configDirectory: directory, resolvePath: path => path });
  vi.spyOn(AisbenchRemoteClient.prototype, "deploy").mockResolvedValue();
  vi.spyOn(AisbenchRemoteClient.prototype, "status").mockResolvedValue({ state: "completed", phase: "solve", heartbeat: null, exitCode: 0, log: "", offset: 0 });
  vi.spyOn(AisbenchRemoteClient.prototype, "download").mockImplementation(async (_jobDir, _fingerprint, target) => {
    await writeFile(join(target, "aisbench_result.csv"), "total_req,qps\n160,2\n");
  });
  const agent = join(directory, "agent");
  try {
    await solver.solve({ id: "task", prompt: "fixture", payload: { kind: "aisbench", schemaVersion: 1, workload: parseWorkload({}), bundleDigest: await bundleDigest() } }, session, { key: { runId: "run", taskId: "task", attemptId: "attempt" }, paths: { root: directory, agent, artifacts: join(directory, "artifacts"), verifier: join(directory, "verifier") }, signal: new AbortController().signal });
    const events = (await readFile(join(agent, "trajectory.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(events.map(event => event.type)).toEqual(["start", "end"]);
    expect(events.every((event, index) => event.seq === index + 1)).toBe(true);
    expect(JSON.parse((await readFile(join(agent, "session.jsonl"), "utf8")).trim().split("\n").at(-1)!)).toMatchObject({ state: "completed", rowCount: 1 });
  } finally { vi.restoreAllMocks(); await rm(directory, { recursive: true, force: true }); }
});
