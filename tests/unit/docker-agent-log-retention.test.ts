import { expect, test, vi } from "vitest";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DockerSession, type DockerMetadata } from "../../src/plugins/environments/docker/session.js";
import { recoverContainerVerifierLogs } from "../../src/infrastructure/containers/verifier-logs.js";
import type { DockerCommand } from "../../src/infrastructure/containers/runtime-contract.js";

test("failed agent export retains the exact container for native recovery", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-log-retention-"));
  const command = vi.fn<DockerCommand>(async args => {
    if (args[0] === "cp") throw new Error("copy denied");
    return { stdout: "", stderr: "" };
  });
  const session = new DockerSession("fixture", "/workspace", "/logs/agent", "/logs/verifier", "docker", command,
    { kind: "docker", phase: "solve" } as DockerMetadata, [], async () => {}, undefined, undefined, undefined, join(root, "agent"));
  try {
    await expect(session.dispose(AbortSignal.timeout(5000))).rejects.toMatchObject({ code: "CLEANUP_FAILED", message: expect.stringContaining("remain in container fixture") });
    expect(command.mock.calls.some(([args]) => args[0] === "rm")).toBe(false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("native agent recovery checks allocations and leaves committed result bytes untouched", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agent-log-recovery-")));
  const key = { runId: "run", taskId: "task", attemptId: "attempt" };
  const target = join(root, key.attemptId, "agent");
  const command = vi.fn<DockerCommand>(async args => {
    if (args[0] === "inspect") return { stdout: JSON.stringify([{ State: { Status: "exited", StartedAt: "2026-01-01T00:00:00Z" } }]), stderr: "" };
    if (args[0] === "cp") { await mkdir(args[2]!); await writeFile(join(args[2]!, "native.log"), "original bytes"); }
    return { stdout: "", stderr: "" };
  });
  try {
    await mkdir(target, { recursive: true });
    const allocation = join(root, key.attemptId, "allocation.json");
    await writeFile(allocation, JSON.stringify({ key: { ...key, taskId: "foreign" } }));
    await expect(recoverContainerVerifierLogs(command, "fixture", target, key, AbortSignal.timeout(5000), "agent")).rejects.toThrow("allocation differs");
    await writeFile(allocation, JSON.stringify({ key }));
    await recoverContainerVerifierLogs(command, "fixture", target, key, AbortSignal.timeout(5000), "agent");
    expect(await readFile(join(target, "native.log"), "utf8")).toBe("original bytes");
    command.mockClear();
    await writeFile(join(root, key.attemptId, "result.json"), "saved result");
    await recoverContainerVerifierLogs(command, "fixture", target, key, AbortSignal.timeout(5000), "agent");
    expect(await readFile(join(root, key.attemptId, "result.json"), "utf8")).toBe("saved result");
    expect(await readFile(join(target, "native.log"), "utf8")).toBe("original bytes");
  } finally { await rm(root, { recursive: true, force: true }); }
});
