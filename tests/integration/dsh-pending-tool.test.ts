import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { consumeDsh } from "../../src/runtimes/dsh/protocol.js";

const image = process.env.EVALUATOR_TEST_DSH_OUTPUT_IMAGE;
const docker = process.env.EVALUATOR_TEST_DOCKER ?? "docker";
const run = promisify(execFile);
async function* bytes(text: string) { yield Buffer.from(text); }

test.skipIf(!image)("native DSH preserves the terminal driver error after a pending tool's step boundary", async () => {
  const name = `evaluator-pending-fixture-${randomUUID()}`;
  const root = await mkdtemp(join(tmpdir(), "dsh-pending-fixture-"));
  const paths = { root, agent: join(root, "agent"), verifier: join(root, "verifier"), artifacts: join(root, "artifacts") };
  const probe = fileURLToPath(new URL("../fixtures/dsh-pending-tool-probe.mjs", import.meta.url));
  try {
    await Promise.all(Object.values(paths).map(path => mkdir(path, { recursive: true })));
    const { stdout } = await run(docker, ["run", "--rm", "--name", name, "--pull", "never", "--network", "none",
      "--entrypoint", "/usr/local/bin/node", "--mount", `type=bind,source=${probe},target=/diagnosis/probe.mjs,readonly`,
      image!, "/diagnosis/probe.mjs"], { timeout: 90_000, windowsHide: true });
    const result = JSON.parse(stdout);
    expect(result.realProviderCalled).toBe(false);
    expect(result.scoringPerformed).toBe(false);
    expect(result.requests).toBe(1);
    await expect(consumeDsh({ stdout: bytes(result.stream), stderr: bytes(result.stderr),
      done: Promise.resolve({ code: result.exitCode, signal: null }), async stop() {} },
    { key: { runId: "run", taskId: "fixture", attemptId: "one" }, paths, signal: AbortSignal.timeout(5_000) }, "fixture-secret"))
      .rejects.toMatchObject({ code: "SOLVER_RESULT_INCOMPLETE", cause: { message: expect.stringContaining("fixture scheduler failure") } });
    expect(await readFile(join(paths.agent, "session.jsonl"), "utf8")).toContain('"phase":"turn_end"');
  } finally {
    await run(docker, ["rm", "--force", name], { timeout: 15_000, windowsHide: true }).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);
