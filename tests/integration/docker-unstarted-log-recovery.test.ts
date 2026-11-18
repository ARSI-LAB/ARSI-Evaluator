import { expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recoverContainerVerifierLogs } from "../../src/infrastructure/containers/verifier-logs.js";
import { runDockerCommand } from "../../src/infrastructure/containers/command.js";
import { PINNED_NODE_IMAGE, type DockerCommand } from "../../src/infrastructure/containers/runtime-contract.js";

test.skipIf(process.env.EVALUATOR_TEST_DOCKER !== "1")("private-log recovery does not start an allocated container whose logs were never initialized", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "docker-unstarted-logs-")));
  const key = { runId: "fixture-" + randomUUID(), taskId: "unstarted", attemptId: randomUUID() };
  const target = join(root, key.attemptId, "agent");
  const command: DockerCommand = (args, options) => runDockerCommand("docker", args, options);
  const signal = AbortSignal.timeout(60_000);
  let id: string | undefined;
  try {
    await mkdir(target, { recursive: true });
    await writeFile(join(root, key.attemptId, "allocation.json"), JSON.stringify({ key }));
    id = (await command(["create", "--network", "none", "--entrypoint", "/usr/local/bin/node", PINNED_NODE_IMAGE,
      "-e", "require('node:fs').writeFileSync('/task-entrypoint-ran','unexpected');setInterval(()=>{},1000)"], { signal })).stdout.trim();
    expect(id).toMatch(/^[a-f0-9]{64}$/u);
    await recoverContainerVerifierLogs(command, id, target, key, signal, "agent");
    const state = JSON.parse((await command(["inspect", id, "--format", "{{json .State}}"], { signal })).stdout) as { Status: string; StartedAt: string };
    expect(state).toMatchObject({ Status: "created", StartedAt: "0001-01-01T00:00:00Z" });
  } finally {
    if (id) await command(["rm", "--force", id], { signal: AbortSignal.timeout(30_000) });
    await rm(root, { recursive: true, force: true });
  }
}, 90_000);
