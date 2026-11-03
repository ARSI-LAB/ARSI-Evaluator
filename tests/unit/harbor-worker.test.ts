import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { expect, test } from "vitest";

const python = process.platform === "win32" ? "python" : "python3";
const available = spawnSync(python, ["-c", "import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)"],
  { timeout: 5000, windowsHide: true }).status === 0;

test.skipIf(!available)("WorkBuddy native CSV failures are zero candidates while infrastructure errors remain invalid", async () => {
  const output = await promisify(execFile)(python, [resolve("tests/fixtures/harbor-worker-tests.py"), resolve(".")],
    { timeout: 10000, windowsHide: true, env: { ...process.env, PYTHONIOENCODING: "utf-8" } });
  expect(output.stderr).toContain("Ran 5 tests");
  expect(output.stderr).toContain("OK");
});
