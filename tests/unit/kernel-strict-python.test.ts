import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
const python = process.platform === "win32" ? "python" : "python3";
const available = spawnSync(python, ["--version"]).status === 0;
test.skipIf(!available)("fixed strict checker covers metadata, mutation, numerical and reference faults without NPU", () => {
  const output = execFileSync(python, [fileURLToPath(new URL("./test_kernel_strict.py", import.meta.url))],
    { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "pipe"] });
  expect(output).toBe("");
});
