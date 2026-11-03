import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
test("background monitor distinguishes valid zero, redacts failures and detects incomplete exit", () => {
  const result = spawnSync(process.platform === "win32" ? "python" : "python3",
    [fileURLToPath(new URL("../fixtures/monitor-run-tests.py", import.meta.url))], { encoding: "utf8" });
  expect(result.status, result.stderr || result.stdout).toBe(0);
});
