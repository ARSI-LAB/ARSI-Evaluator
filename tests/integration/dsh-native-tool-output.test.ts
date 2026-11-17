import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, test } from "vitest";

const image = process.env.EVALUATOR_TEST_DSH_OUTPUT_IMAGE;
const docker = process.env.EVALUATOR_TEST_DOCKER ?? "docker";
const run = promisify(execFile);

test.skipIf(!image)("native DSH exports real tool results and exposes a failed export instead of silently dropping it", async () => {
  const name = `evaluator-export-fixture-${randomUUID()}`;
  const directory = await mkdtemp(join(tmpdir(), "dsh-native-export-"));
  const output = join(directory, "output");
  const probe = fileURLToPath(new URL("../fixtures/dsh-native-tool-output-probe.mjs", import.meta.url));
  const hook = fileURLToPath(new URL("../../src/runtimes/dsh/assets/output-hook.mjs", import.meta.url));
  try {
    await mkdir(output, { mode: 0o777 });
    const { stdout } = await run(docker, ["run", "--rm", "--name", name, "--pull", "never", "--network", "none",
      "--entrypoint", "/usr/local/bin/node", "--mount", `type=bind,source=${probe},target=/diagnosis/probe.mjs,readonly`,
      "--mount", `type=bind,source=${hook},target=/diagnosis/output-hook.mjs,readonly`,
      "--mount", `type=bind,source=${output},target=/logs/agent`, image!, "/diagnosis/probe.mjs"],
    { timeout: 90_000, windowsHide: true });
    const result = JSON.parse(stdout);
    expect(result.realProviderCalled).toBe(false);
    expect(result.scoringPerformed).toBe(false);
    expect(result.requests).toBe(6);
    for (const row of result.rows.slice(0, 2)) {
      expect(row.toolResults).toEqual([expect.objectContaining({ status: "completed", truncated: true, hasResultRef: true })]);
      expect(row.exportErrors).toEqual([]);
    }
    const blocked = result.rows[2];
    // DSH continues after observer failures. The exporter must publish an error
    // for its coordinator to fail closed, even if the CLI exits successfully.
    expect(blocked.exitCode).toBe(0);
    expect(blocked.toolResults).toEqual([]);
    expect(blocked.exportErrors).toEqual([expect.objectContaining({ message: expect.stringContaining("tool output export failed (ENOTDIR)") })]);
  } finally {
    await run(docker, ["rm", "--force", name], { timeout: 15_000, windowsHide: true }).catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
}, 120_000);
