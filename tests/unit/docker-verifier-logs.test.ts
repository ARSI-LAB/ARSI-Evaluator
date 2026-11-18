import { expect, test, vi } from "vitest";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportContainerVerifierLogs, parseVerifierLogStorage, recoverContainerVerifierLogs } from "../../src/infrastructure/containers/verifier-logs.js";
import type { DockerCommand } from "../../src/infrastructure/containers/runtime-contract.js";

test("private verifier storage requires an explicit audit reason", () => {
  expect(parseVerifierLogStorage(undefined, undefined)).toBeUndefined();
  expect(parseVerifierLogStorage("bind", undefined)).toBeUndefined();
  expect(parseVerifierLogStorage("container", " recovery ")).toEqual({ storage: "container", reason: "recovery" });
  for (const [storage, reason] of [["container", ""], ["container", "a\nb"], ["volume", "reason"], [true, "reason"]])
    expect(() => parseVerifierLogStorage(storage, reason)).toThrow();
});

test("exports private evidence byte-identically and removes the temporary snapshot", async () => {
  const root = await mkdtemp(join(tmpdir(), "verifier-export-test-"));
  const command = vi.fn<DockerCommand>(async args => {
    if (args[0] === "cp") {
      const target = args[2]!;
      await mkdir(target);await writeFile(join(target, "pg.log"), "fixture log\n", { mode: 0o600 });
    }
    return { stdout: "", stderr: "" };
  });
  try {
    await exportContainerVerifierLogs(command, "fixture", join(root, "verifier"), AbortSignal.timeout(5000));
    expect(await readFile(join(root, "verifier/pg.log"), "utf8")).toBe("fixture log\n");
    expect(command.mock.calls.some(([args]) => args.includes("remove-snapshot"))).toBe(true);
    expect(command.mock.calls.some(([args]) => args[0] === "rm")).toBe(false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("export failure is reported and does not delete the only container evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "verifier-export-failure-"));
  const command = vi.fn<DockerCommand>(async args => {
    if (args[0] === "cp") throw new Error("copy denied");
    return { stdout: "", stderr: "" };
  });
  try {
    await expect(exportContainerVerifierLogs(command, "fixture", join(root, "verifier"), AbortSignal.timeout(5000))).rejects.toThrow("copy denied");
    expect(command.mock.calls.some(([args]) => args.includes("remove-snapshot"))).toBe(true);
    expect(command.mock.calls.some(([args]) => args[0] === "rm")).toBe(false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("recovery rejects foreign allocations and never rewrites committed evidence", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "verifier-recovery-test-")));
  const key = { runId: "run", taskId: "task", attemptId: "attempt" };
  const target = join(root, key.attemptId, "verifier");
  const command = vi.fn<DockerCommand>();
  try {
    await mkdir(target, { recursive: true });
    await writeFile(join(root, key.attemptId, "allocation.json"), JSON.stringify({ key: { ...key, taskId: "foreign" } }));
    await expect(recoverContainerVerifierLogs(command, "fixture", target, key, AbortSignal.timeout(5000))).rejects.toThrow("allocation differs");
    await writeFile(join(root, key.attemptId, "allocation.json"), JSON.stringify({ key }));
    await writeFile(join(root, key.attemptId, "result.json"), "immutable");
    await recoverContainerVerifierLogs(command, "fixture", target, key, AbortSignal.timeout(5000));
    expect(command).not.toHaveBeenCalled();
    expect(await readFile(join(root, key.attemptId, "result.json"), "utf8")).toBe("immutable");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("agent log export uses its own private root and preserves host trajectory", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-export-test-"));
  const target = join(root, "agent");
  await mkdir(target); await writeFile(join(target, "trajectory.jsonl"), "host trajectory");
  const command = vi.fn<DockerCommand>(async args => {
    if (args[0] === "cp") { await mkdir(args[2]!); await writeFile(join(args[2]!, "native.log"), "native evidence"); }
    return { stdout: "", stderr: "" };
  });
  try {
    await exportContainerVerifierLogs(command, "fixture", target, AbortSignal.timeout(5000), "agent");
    expect(command.mock.calls.some(([args]) => args.slice(-2).every(value => value === "/logs/agent"))).toBe(true);
    expect(await readFile(join(target, "trajectory.jsonl"), "utf8")).toBe("host trajectory");
    expect(await readFile(join(target, "native.log"), "utf8")).toBe("native evidence");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("agent export refuses to overwrite saved coordinator evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-export-conflict-"));
  const target = join(root, "agent");
  await mkdir(target); await writeFile(join(target, "trajectory.jsonl"), "saved trajectory");
  const command = vi.fn<DockerCommand>(async args => {
    if (args[0] === "cp") { await mkdir(args[2]!); await writeFile(join(args[2]!, "trajectory.jsonl"), "different bytes"); }
    return { stdout: "", stderr: "" };
  });
  try {
    await expect(exportContainerVerifierLogs(command, "fixture", target, AbortSignal.timeout(5000), "agent")).rejects.toThrow("conflict");
    expect(await readFile(join(target, "trajectory.jsonl"), "utf8")).toBe("saved trajectory");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test.each(["agent", "verifier"] as const)("recovery leaves a never-started %s container for cleanup without running its task entrypoint", async kind => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "unstarted-log-recovery-")));
  const key = { runId: "run", taskId: "task", attemptId: "attempt" };
  const target = join(root, key.attemptId, kind);
  const command = vi.fn<DockerCommand>(async args => {
    if (args[0] !== "inspect") throw new Error("A never-started task must not run for log recovery");
    return { stdout: JSON.stringify([{ State: { Status: "created", StartedAt: "0001-01-01T00:00:00Z" } }]), stderr: "" };
  });
  try {
    await mkdir(target, { recursive: true });
    const allocation = JSON.stringify({ key });
    await writeFile(join(root, key.attemptId, "allocation.json"), allocation);
    await recoverContainerVerifierLogs(command, "fixture", target, key, AbortSignal.timeout(5000), kind);
    expect(command.mock.calls.map(([args]) => args)).toEqual([["inspect", "fixture"]]);
    expect(await readdir(target)).toEqual([]);
    expect(await readFile(join(root, key.attemptId, "allocation.json"), "utf8")).toBe(allocation);
  } finally { await rm(root, { recursive: true, force: true }); }
});
