import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { startLocalProcess } from "../../src/infrastructure/process/local.js";

test.skipIf(process.platform === "win32")("a missing executable rejects with ENOENT without an unhandled process error", async () => {
  const executable = join(tmpdir(), "ember-missing-" + randomUUID());
  await expect(startLocalProcess({
    executable,
    args: [],
    cwd: tmpdir(),
    env: {},
    input: null,
  }, new AbortController().signal)).rejects.toMatchObject({ code: "ENOENT", path: executable });
});

test.skipIf(process.platform === "win32")("a missing working directory rejects through the same spawn error boundary", async () => {
  await expect(startLocalProcess({
    executable: process.execPath,
    args: ["-e", "process.exit(0)"],
    cwd: join(tmpdir(), "ember-missing-cwd-" + randomUUID()),
    env: {},
    input: null,
  }, new AbortController().signal)).rejects.toMatchObject({ code: "ENOENT" });
});
