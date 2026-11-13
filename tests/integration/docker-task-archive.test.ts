import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { expect, test, vi } from "vitest";
import { runDockerCommand } from "../../src/infrastructure/containers/command.js";
import { DockerImageInventory } from "../../src/infrastructure/containers/image-inventory.js";
import { DockerTaskArchive } from "../../src/infrastructure/containers/task-archive.js";
import { NetworkRuntime } from "../../src/infrastructure/network/runtime.js";

test.skipIf(process.env.EVALUATOR_RETAINED_IMAGES_TEST !== "1")("Docker save archives share one retained reference without restoring publisher tags", async () => {
  const root = await mkdtemp(join(tmpdir(), "evaluator-docker-archive-"));
  const name = `evaluator-archive-fixture:${randomUUID()}`;
  const repository = `ember-evaluator/fixture-${randomUUID()}`;
  const second = name + "-second";
  const active = AbortSignal.timeout(120_000);
  const raw: typeof runDockerCommand = runDockerCommand;
  const command = (args: string[], options?: Parameters<typeof raw>[2]) => raw("docker", args, options);
  const docker = (args: string[]) => command(args, { signal: active });
  const inventory = new DockerImageInventory(command, join(root, "inventory"));
  const network = new NetworkRuntime();
  let archive: Buffer | undefined;
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(request.url ?? "");
    response.end(archive);
  });
  const owner = { configFingerprint: randomUUID(), taskId: "fixture/first", phase: "solve" };
  const images = [name, second];
  const preferred = (task: string) => `${repository}/${task}:linux-amd64-base`;
  vi.stubEnv("EVALUATOR_CACHE_DIR", root);
  try {
    await writeFile(join(root, "Dockerfile"), "FROM scratch\nCOPY payload /payload\nLABEL evaluator.fixture=" + name + "\n");
    await writeFile(join(root, "payload"), "archive fixture");
    await docker(["build", "--platform", "linux/amd64", "--tag", name, root]);
    await docker(["image", "tag", name, second]);
    const tar = join(root, "saved.tar");
    await docker(["image", "save", "--output", tar, name, second]);
    archive = gzipSync(await readFile(tar));
    await docker(["image", "rm", name, second]);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Cannot start archive server");
    const loader = new DockerTaskArchive(inventory.command, inventory,
      { method: "archive", provider: "modelscope", baseUrl: `http://127.0.0.1:${address.port}/terminalbench4.0` }, network);
    const load = (taskId: string) => inventory.use(owner, active, () => loader.load({ taskId, phase: "solve" }, "linux/amd64", active,
      undefined, preferred(taskId.split("/").at(-1)!)));
    const [first, duplicate] = await Promise.all([load("fixture/first"), load("fixture/second")]);
    images.push(first.reference);
    expect(first).toEqual(duplicate);
    expect([preferred("first"), preferred("second")]).toContain(first.reference);
    const tags = await docker(["image", "inspect", first.reference, "--format", "{{json .RepoTags}}"]);
    expect(JSON.parse(tags.stdout)).toEqual([first.reference]);
    expect(requests.sort()).toEqual(["/terminalbench4.0/first/linux/amd64/solve.tar.gz", "/terminalbench4.0/second/linux/amd64/solve.tar.gz"]);
    const removed = await inventory.cleanup({ all: false, execute: true, configFingerprint: owner.configFingerprint }, active);
    expect(removed.items).toContainEqual(expect.objectContaining({ reference: first.reference, status: "deleted" }));
    const restored = await load("fixture/first");
    images.push(restored.reference);
    expect(restored).toMatchObject({ id: first.id, reference: preferred("first") });
    expect(requests).toHaveLength(2);
  } finally {
    vi.unstubAllEnvs();
    server.closeAllConnections();
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    await network.dispose();
    for (const image of images) await command(["image", "rm", "--no-prune", image], { signal: AbortSignal.timeout(10_000) }).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
}, 150_000);
