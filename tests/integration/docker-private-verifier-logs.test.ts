import { test, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DockerEnvironment } from "../../src/plugins/environments/docker/environment.js";
import { PINNED_NODE_IMAGE } from "../../src/infrastructure/containers/runtime-contract.js";
import { readProcess } from "../../src/infrastructure/process/output.js";

test.skipIf(process.env.EVALUATOR_TEST_DOCKER !== "1")("private verifier logs avoid host mounts and survive cleanup", async () => {
  const root = await mkdtemp(join(tmpdir(), "private-verifier-logs-"));
  const key = { runId: "fixture-" + randomUUID(), taskId: "private-logs", attemptId: randomUUID() };
  const attempt = join(root, key.attemptId);
  await mkdir(attempt);await writeFile(join(attempt, "allocation.json"), JSON.stringify({ key }));
  const paths = { root: attempt, agent: join(attempt, "agent"), verifier: join(attempt, "verifier"), artifacts: join(attempt, "artifacts") };
  const environment = new DockerEnvironment({ verifierLogStorage: "container", verifierLogStorageReason: "non-scoring filesystem regression" });
  const signal = AbortSignal.timeout(120_000);
  let session;
  try {
    const spec = await environment.materialize({ image: PINNED_NODE_IMAGE, workdir: "/workspace", initialFiles: [], runtime: [], network: "none", resources: { cpus: 1, memory: "512m" } }, signal);
    session = await environment.prepare(spec, paths, "verify", signal);
    expect(session.metadata).toMatchObject({ verifierLogs: { storage: "container" } });
    const process = await session.start({ executable: "node", args: ["-e", "require('node:fs').writeFileSync('/logs/verifier/pg.log','fixture evidence',{mode:0o600})"], cwd: "/workspace", env: {}, input: null }, signal);
    expect((await readProcess(process, signal)).code).toBe(0);
    await session.dispose(signal);session = undefined;
    expect(await readFile(join(paths.verifier, "pg.log"), "utf8")).toBe("fixture evidence");
  } finally { if (session) await session.dispose(AbortSignal.timeout(60_000));await rm(root, { recursive: true, force: true }); }
}, 150_000);
