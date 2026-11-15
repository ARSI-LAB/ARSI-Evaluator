import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, expect, test, vi } from "vitest";
import { startLocalProcess } from "../../src/infrastructure/process/local.js";

vi.mock("node:child_process", async importOriginal => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  spawn: vi.fn(),
}));
afterEach(() => vi.restoreAllMocks());

test.each(["stdin", "stdout", "stderr"] as const)(
  "captures an early %s ENOTCONN without escaping the process boundary",
  async channel => {
    const failure = Object.assign(new Error("read ENOTCONN"), { code: "ENOTCONN" });
    const escaped: unknown[] = [];
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
      pid: 2_000_000_000, exitCode: null, signalCode: null,
      kill: vi.fn(() => {
        queueMicrotask(() => child.emit("close", null, "SIGKILL"));
        return true;
      }),
    });
    const groupKill = vi.spyOn(process, "kill").mockImplementation(() => {
      queueMicrotask(() => child.emit("close", null, "SIGKILL"));
      return true;
    });
    vi.mocked(spawn).mockImplementation(() => {
      // Node may emit a pipe error before the caller resumes from an async
      // Windows spawn helper. Catch the throw here only to keep the test runner
      // alive; production has no such outer boundary.
      queueMicrotask(() => {
        try { child[channel].emit("error", failure); } catch (error) { escaped.push(error); }
      });
      setImmediate(() => child.emit("spawn"));
      return child as unknown as ChildProcessWithoutNullStreams;
    });
    await expect(startLocalProcess({ executable: process.execPath, args: [],
      cwd: process.cwd(), env: {}, input: null }, new AbortController().signal)).rejects.toBe(failure);
    expect(escaped).toEqual([]);
    if (process.platform === "win32") expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    else expect(groupKill).toHaveBeenCalledWith(-child.pid, "SIGKILL");
  },
);
