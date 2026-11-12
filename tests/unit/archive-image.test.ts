import { createHash } from "node:crypto";
import { create, list } from "tar";
import { DockerImageInventory } from "../../src/infrastructure/containers/image-inventory.js";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { taskArchiveUrl, downloadArchiveImage } from "../../src/infrastructure/containers/archive-image.js";
import { networkDocument } from "../../src/config/network-schema.js";
import { NetworkRuntime } from "../../src/infrastructure/network/runtime.js";
import { DockerTaskArchive } from "../../src/infrastructure/containers/task-archive.js";
import type { DockerCommand } from "../../src/infrastructure/containers/runtime-contract.js";
import type { ArchiveImageAcquisition } from "../../src/core/contracts/network.js";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { vi.unstubAllEnvs(); for (const fn of cleanup.splice(0).reverse()) await fn(); });

async function fixture(status = 200) {
  const root = await mkdtemp(join(tmpdir(), "task-archive-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  vi.stubEnv("EVALUATOR_CACHE_DIR", root);
  const requests: string[] = [];
  const config = JSON.stringify({ architecture: "arm64", os: "linux", rootfs: { type: "layers", diff_ids: [] } });
  const id = "sha256:" + createHash("sha256").update(config).digest("hex");
  await writeFile(join(root, "config.json"), config);
  await writeFile(join(root, "manifest.json"), JSON.stringify([
    { Config: "config.json", Layers: [], RepoTags: ["publisher/task:arm64", "user/preexisting:latest"] },
  ]));
  const path = join(root, "source.tar.gz");
  await create({ cwd: root, file: path, gzip: true }, ["manifest.json", "config.json"]);
  const bytes = await readFile(path);
  const server = createServer((request, response) => {
    requests.push(request.url ?? "");
    response.writeHead(status); response.end(bytes);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing fixture port");
  const settings: ArchiveImageAcquisition = { method: "archive", provider: "modelscope", baseUrl: `http://127.0.0.1:${address.port}/terminalbench4.0` };
  const network = new NetworkRuntime(networkDocument({}, {})); cleanup.push(() => network.dispose());
  return { root, requests, bytes, settings, network, id };
}
const context = { taskId: "terminal-bench/task-a", phase: "solve" as const };

test("fixed URLs select task, platform, phase and service without a catalog", () => {
  const settings: ArchiveImageAcquisition = { method: "archive", provider: "huggingface", baseUrl: "https://huggingface.co/datasets/team/images/resolve/v1/terminalbench4.0/" };
  expect(taskArchiveUrl(settings, context, "linux/amd64")).toBe(settings.baseUrl + "task-a/linux/amd64/solve.tar.gz");
  expect(taskArchiveUrl(settings, { ...context, phase: "verify" }, "linux/arm64")).toBe(settings.baseUrl + "task-a/linux/arm64/verify.tar.gz");
  expect(taskArchiveUrl(settings, { ...context, service: "api one" }, "linux/arm64")).toBe(settings.baseUrl + "task-a/linux/arm64/solve/services/api%20one.tar.gz");
  expect(taskArchiveUrl(settings, { ...context, taskId: "task-a" }, "linux/amd64")).toBe(settings.baseUrl + "task-a/linux/amd64/solve.tar.gz");
  expect(taskArchiveUrl(settings, { ...context, taskId: "benchmark/group/task a" }, "linux/amd64")).toBe(settings.baseUrl + "group/task%20a/linux/amd64/solve.tar.gz");
  for (const taskId of ["../escape", "task/../escape", "/task", "task//empty"])
    expect(() => taskArchiveUrl(settings, { ...context, taskId }, "linux/amd64")).toThrow("path segment");
});

test("only the requested archive is downloaded, with no checksum or format requirement", async () => {
  const f = await fixture();
  const url = taskArchiveUrl(f.settings, context, "linux/arm64");
  const path = await downloadArchiveImage(url, f.settings, f.network, f.root, AbortSignal.timeout(5000));
  expect(await readFile(path)).toEqual(f.bytes);
  expect(f.requests).toEqual(["/terminalbench4.0/task-a/linux/arm64/solve.tar.gz"]);
});


function fakeDocker(id: string) {
  const images = new Set<string>();
  let loads = 0;
  let fail = false;
  let abort: AbortController | undefined;
  const command: DockerCommand = async args => {
    if (args[0] === "info") return { stdout: "archive-fixture", stderr: "" };
    if (args[0] === "load") {
      loads++;
      if (fail) throw new Error("load failed");
      const chunks: Buffer[] = [];
      await list({ file: args[2]!, onReadEntry(entry) {
        if (entry.path === "manifest.json") entry.on("data", chunk => chunks.push(Buffer.from(chunk)));
        entry.resume();
      } });
      const [{ RepoTags: tags }] = JSON.parse(Buffer.concat(chunks).toString()) as [{ RepoTags: string[] }];
      expect(tags).toHaveLength(1);
      expect(tags[0]).toMatch(/^ember-evaluator\/staging:/u);
      images.add(tags[0]!);
      abort?.abort(new Error("cancelled after load"));
    } else if (args[1] === "tag") {
      expect(args[2]).toBe(id);
      images.add(args[3]!);
    } else if (args[1] === "rm") {
      images.delete(args.at(-1)!);
    } else if (args[1] === "inspect") {
      const ref = args.includes("--platform") ? args[4]! : args[2]!;
      if (!images.has(ref)) throw new Error("No such image");
      const format = args.at(-1);
      const stdout = format?.includes("RepoTags") ? JSON.stringify([id, [...images], []])
        : format?.includes("Architecture") ? JSON.stringify([id, "linux", "arm64"]) : id;
      return { stdout, stderr: "" };
    } else throw new Error("Unexpected Docker operation");
    return { stdout: "", stderr: "" };
  };
  return { command, images, get loads() { return loads; }, setFail(value: boolean) { fail = value; },
    abortAfterLoad(controller?: AbortController) { abort = controller; } };
}

test("different task URLs load once per path and share a single retained reference", async () => {
  const f = await fixture();
  const docker = fakeDocker(f.id);
  const inventory = new DockerImageInventory(docker.command);
  const loader = new DockerTaskArchive(docker.command, inventory, f.settings, f.network);
  const signal = AbortSignal.timeout(10000);
  const [first, same, other] = await Promise.all([
    loader.load(context, "linux/arm64", signal),
    loader.load(context, "linux/arm64", signal),
    loader.load({ ...context, taskId: "terminal-bench/task-b" }, "linux/arm64", signal),
  ]);
  expect(first).toEqual(same);
  expect(first).toEqual(other);
  expect(first.id).toBe(f.id);
  expect([...docker.images]).toEqual([first.pinnedReference]);
  expect(docker.loads).toBe(2);
  expect(await new DockerTaskArchive(docker.command, inventory, f.settings, f.network).load(context, "linux/arm64", signal)).toEqual(first);
  expect(f.requests).toHaveLength(2);
});

test("rejects a wrong platform before Docker load and retries failed loads", async () => {
  const f = await fixture();
  const docker = fakeDocker(f.id);
  const loader = new DockerTaskArchive(docker.command, new DockerImageInventory(docker.command), f.settings, f.network);
  const signal = AbortSignal.timeout(10000);
  await expect(loader.load(context, "linux/amd64", signal)).rejects.toMatchObject({ cause: { message: expect.stringContaining("linux/amd64") } });
  expect(docker.loads).toBe(0);
  docker.setFail(true);
  await expect(loader.load(context, "linux/arm64", signal)).rejects.toMatchObject({ cause: { message: "load failed" } });
  expect(docker.images.size).toBe(0);
  docker.setFail(false);
  await expect(loader.load(context, "linux/arm64", signal)).resolves.toMatchObject({ id: f.id });
  expect(docker.loads).toBe(2);
  expect(f.requests).toHaveLength(2);
});

test("a cancellation after Docker load removes staging and can reuse the downloaded archive", async () => {
  const f = await fixture();
  const docker = fakeDocker(f.id);
  const loader = new DockerTaskArchive(docker.command, new DockerImageInventory(docker.command), f.settings, f.network);
  const controller = new AbortController();
  docker.abortAfterLoad(controller);
  await expect(loader.load(context, "linux/arm64", controller.signal)).rejects.toThrow("cancelled after load");
  expect(docker.images.size).toBe(0);
  docker.abortAfterLoad();
  await expect(loader.load(context, "linux/arm64", AbortSignal.timeout(5000))).resolves.toMatchObject({ id: f.id });
  expect(f.requests).toHaveLength(1);
});

test("HTTP 404 does not fall back to another platform or registry", async () => {
  const f = await fixture(404);
  const docker = fakeDocker(f.id);
  const loader = new DockerTaskArchive(docker.command, new DockerImageInventory(docker.command), f.settings, f.network);
  await expect(loader.load(context, "linux/arm64", AbortSignal.timeout(5000)))
    .rejects.toMatchObject({ code: "ENV_IMAGE_PULL_FAILED", cause: { message: expect.stringContaining("404") } });
  expect(f.requests).toEqual(["/terminalbench4.0/task-a/linux/arm64/solve.tar.gz"]);
  expect(docker.loads).toBe(0);
});

test("a cancelled acquisition does not download or run Docker", async () => {
  const f = await fixture();
  const command = vi.fn<DockerCommand>();
  await expect(new DockerTaskArchive(command, new DockerImageInventory(command), f.settings, f.network).load(context, "linux/amd64", AbortSignal.abort()))
    .rejects.toMatchObject({ name: "AbortError" });
  expect(f.requests).toEqual([]);
  expect(command).not.toHaveBeenCalled();
});
