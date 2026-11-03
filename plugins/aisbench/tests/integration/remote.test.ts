import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, test } from "vitest";

const python = process.env.AISBENCH_TEST_PYTHON;
test.skipIf(!python)("remote supervisor preserves idempotency, failure, cancellation and redacted artifacts", async () => {
  const result = await promisify(execFile)(python ?? "python3", [
    fileURLToPath(new URL("../fixtures/check-remote.py", import.meta.url)),
    fileURLToPath(new URL("../../dist/runtime/remote.py", import.meta.url)),
  ], { timeout: 30000, encoding: "utf8" });
  expect(JSON.parse(result.stdout)).toMatchObject({ passed: true });
}, 35000);
