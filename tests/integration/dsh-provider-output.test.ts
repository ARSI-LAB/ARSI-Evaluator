import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const image = process.env.EVALUATOR_TEST_DSH_OUTPUT_IMAGE;
const docker = process.env.EVALUATOR_TEST_DOCKER ?? "docker";
const run = promisify(execFile);

test.skipIf(!image)("real DSH rejects an invented ceiling, accepts provider output, and preserves explicit limits", async () => {
  const name = `evaluator-output-fixture-${randomUUID()}`;
  const hook = fileURLToPath(new URL("../../src/runtimes/dsh/assets/output-hook.mjs", import.meta.url));
  const probe = fileURLToPath(new URL("../fixtures/dsh-provider-output-probe.mjs", import.meta.url));
  try {
    const { stdout } = await run(docker, ["run", "--rm", "--name", name, "--pull", "never", "--network", "none", "--no-healthcheck",
      "--entrypoint", "/usr/local/bin/node",
      "--mount", `type=bind,source=${probe},target=/diagnosis/probe.mjs,readonly`,
      // Without the selected binding, the hook leaves the original adapter unmodified.
      "--mount", `type=bind,source=${hook},target=/diagnosis/original-hook.mjs,readonly`,
      "--mount", `type=bind,source=${hook},target=/diagnosis/fixed-hook.mjs,readonly`, image!, "/diagnosis/probe.mjs"],
    { timeout: 90_000, windowsHide: true });
    const result = JSON.parse(stdout);
    expect(result.realProviderCalled).toBe(false);
    expect(result.scoringPerformed).toBe(false);
    expect(result.rows.map((row: { exitCode: number }) => row.exitCode)).toEqual([1, 0, 0]);
    expect(result.rows.map((row: { requests: { limit: number | null }[] }) => row.requests.map(request => request.limit)))
      .toEqual([[32768], [null], [1024]]);
  } finally {
    await run(docker, ["rm", "--force", name], { timeout: 15_000, windowsHide: true }).catch(() => {});
  }
}, 120_000);
