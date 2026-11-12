import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { runDockerCommand } from "../../src/infrastructure/containers/command.js";
import { createDockerImagePuller } from "../../src/infrastructure/containers/image-pull.js";
import type { DockerCommand } from "../../src/infrastructure/containers/runtime-contract.js";
import { acquireBaseImage } from "../../src/infrastructure/containers/base-image.js";
import { DockerImageInventory } from "../../src/infrastructure/containers/image-inventory.js";

test.skipIf(process.env.EVALUATOR_TEST_DOCKER !== "1")(
  "a native pinned source keeps its reference and remains usable with the registry offline",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "evaluator-base-image-smoke-"));
    const name = `evaluator-base-source-${randomUUID()}`;
    const hash = (data: Buffer) => `sha256:${createHash("sha256").update(data).digest("hex")}`;
    const config = Buffer.from(JSON.stringify({ architecture: "amd64", os: "linux",
      config: { Labels: { "evaluator.base-test": name } }, rootfs: { type: "layers", diff_ids: [] } }));
    const manifest = Buffer.from(JSON.stringify({ schemaVersion: 2,
      mediaType: "application/vnd.docker.distribution.manifest.v2+json",
      config: { mediaType: "application/vnd.docker.container.image.v1+json", digest: hash(config), size: config.length }, layers: [] }));
    const digest = hash(manifest);
    const calls: string[][] = [];
    const command: DockerCommand = async (args, options) => {
      calls.push([...args]);
      return runDockerCommand("docker", args, options);
    };
    // The opt-in test runs beside a local daemon (toolbox uses host networking).
    const registry = createServer((request, response) => {
      response.setHeader("Docker-Distribution-Api-Version", "registry/2.0");
      let data: Buffer;
      if (request.url === "/v2/") data = Buffer.from("{}");
      else if (request.url?.includes("/manifests/")) {
        data = manifest;
        response.setHeader("Content-Type", "application/vnd.docker.distribution.manifest.v2+json");
        response.setHeader("Docker-Content-Digest", digest);
      } else if (request.url?.endsWith(`/blobs/${hash(config)}`)) data = config;
      else { response.writeHead(404); response.end(); return; }
      response.setHeader("Content-Length", data.length);
      response.end(request.method === "HEAD" ? undefined : data);
    });
    const images = new Set<string>();
    vi.stubEnv("EVALUATOR_CACHE_DIR", root);
    try {
      await new Promise<void>(resolve => registry.listen(0, "0.0.0.0", resolve));
      const address = registry.address();
      if (!address || typeof address === "string") throw new Error("Registry did not bind a TCP port");
      const repository = `127.0.0.1:${address.port}/${name}`;
      const source = `${repository}@${digest}`;
      images.add(source);
      const signal = AbortSignal.timeout(45_000);
      const inventory = new DockerImageInventory(command);
      const pull = createDockerImagePuller(inventory.command);
      const acquire = (phase: "solve" | "verify") => inventory.use(undefined, signal, () =>
        acquireBaseImage(inventory, source, "linux/amd64", source, pull, signal, { taskId: name, phase }));
      const first = await acquire("solve");
      images.add(first.reference);
      expect(first.reference).toBe(source);
      registry.closeAllConnections();
      await new Promise<void>((resolve, reject) => registry.close(error => error ? reject(error) : resolve()));
      expect(await acquire("solve")).toEqual(first);
      expect(await acquire("verify")).toEqual(first);
      expect(calls.filter(args => args[0] === "pull")).toHaveLength(1);
    } finally {
      vi.unstubAllEnvs();
      registry.closeAllConnections();
      if (registry.listening) await new Promise<void>(resolve => registry.close(() => resolve()));
      for (const image of images) {
        try { await runDockerCommand("docker", ["image", "inspect", image], { signal: AbortSignal.timeout(5000) }); }
        catch { continue; }
        await runDockerCommand("docker", ["image", "rm", "--no-prune", image], { signal: AbortSignal.timeout(30_000) });
      }
      await rm(root, { recursive: true, force: true });
    }
  }, 75_000,
);
