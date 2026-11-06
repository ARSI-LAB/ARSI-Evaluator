import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
const python = process.platform === "win32" ? "python" : "python3";
const available = spawnSync(python, ["--version"]).status === 0;
test.skipIf(!available)("diagnostic replay uses frozen seed and reference input construction without NPU", () => {
  const output = execFileSync(python, [fileURLToPath(new URL("./test_kernel_profile_replay.py", import.meta.url))],
    { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "pipe"] });
  expect(output).toBe("");
});
