import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, test } from "vitest";

import { gitBlobHash } from "ember-evaluator";
import type { EnvironmentSpec } from "../../src/core/contracts/environment.js";
import {
  DocOpsImageProvider,
  parseDocOpsDockerConfig,
  type DocOpsImageTransport,
} from "../../plugins/docops/index.js";
import type { DockerCommand } from "ember-evaluator";

const commit = "1234567890abcdef1234567890abcdef12345678";
const roots: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((accept, reject) => server.close(error => error ? reject(error) : accept()))));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<{ root: string; spec: EnvironmentSpec }> {
  const root = await mkdtemp(join(tmpdir(), "docops-images-"));
  roots.push(root);
  const environment = join(root, "environment");
  await mkdir(environment);
  await writeFile(join(environment, "Dockerfile"), "FROM harbor-codex-base:2.1.114\n", "utf8");
  return {
    root,
    spec: {
      workdir: "/root/submission",
      image: null,
      initialFiles: [],
      runtime: [],
      build: { context: environment, dockerfile: "Dockerfile", sourceHash: "0".repeat(64) },
    },
  };
}

async function remote(options: {
  archivePath?: string;
  corruptPointer?: boolean;
  batchMode?: "valid" | "mismatched" | "rejected";
} = {}): Promise<{ batchRequests: unknown[]; requests: string[]; transport: DocOpsImageTransport }> {
  const archivePath = options.archivePath ?? "docker/images/amd/harbor-codex-base_2.1.114_linux-amd64.tar.gz";
  const batchMode = options.batchMode ?? "valid";
  const archive = Buffer.from("controlled docker archive", "utf8");
  const digest = createHash("sha256").update(archive).digest("hex");
  const pointer = Buffer.from(`version https://git-lfs.github.com/spec/v1\noid sha256:${digest}\nsize ${archive.byteLength}\n`, "utf8");
  const gitSha = gitBlobHash(pointer);
  const requests: string[] = [];
  const batchRequests: unknown[] = [];
  let base = "";
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://fixture.invalid");
      requests.push(`${request.method ?? "GET"} ${url.pathname}${url.search}`);
      if (url.pathname === "/repos/fixture/docops/commits/main") response.end(JSON.stringify({ sha: commit }));
      else if (url.pathname === `/repos/fixture/docops/git/trees/${commit}`) response.end(JSON.stringify({
        truncated: false,
        tree: [{ path: archivePath, sha: gitSha, type: "blob", mode: "100644" }],
      }));
      else if (url.pathname === `/repos/fixture/docops/git/blobs/${gitSha}`) response.end(JSON.stringify({ encoding: "base64", content: (options.corruptPointer ? Buffer.from("tampered pointer") : pointer).toString("base64") }));
      else if (url.pathname === "/fixture/docops.git/info/lfs/objects/batch") {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        batchRequests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        response.setHeader("content-type", "application/vnd.git-lfs+json");
        if (batchMode === "rejected") {
          response.end(JSON.stringify({ objects: [{ oid: digest, size: archive.byteLength, error: { code: 404, message: "missing fixture object" } }] }));
        } else {
          response.end(JSON.stringify({
            transfer: "basic",
            hash_algo: "sha256",
            objects: [{
              oid: batchMode === "mismatched" ? "0".repeat(64) : digest,
              size: archive.byteLength,
              actions: { download: { href: `${base}/lfs/objects/${digest}`, header: { "X-DocOps-Token": "fixture-token" } } },
            }],
          }));
        }
      } else if (url.pathname === `/lfs/objects/${digest}`) {
        if (request.headers["x-docops-token"] !== "fixture-token") {
          response.statusCode = 401;
          response.end("missing action header");
        } else {
          response.setHeader("content-length", String(archive.byteLength));
          response.end(archive);
        }
      } else {
        response.statusCode = 404;
        response.end("not found");
      }
    })().catch(error => {
      response.statusCode = 500;
      response.end(error instanceof Error ? error.message : String(error));
    });
  });
  await new Promise<void>((accept, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", accept);
  });
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture server failed to bind");
  base = `http://127.0.0.1:${address.port}`;
  return { batchRequests, requests, transport: { apiBase: base, lfsBase: base } };
}

test("validates DocOps Docker configuration", () => {
  expect(parseDocOpsDockerConfig({})).toEqual({
    profile: "amd",
    repository: "icip-cas/DocOps",
    revision: "main",
    cacheDir: ".cache/docops-images",
  });
  expect(() => parseDocOpsDockerConfig({ profile: "arm" })).toThrow(/amd or x86/i);
  expect(() => parseDocOpsDockerConfig({ cacheDir: "./cache", extra: true })).toThrow(/unknown field/i);
});

test("downloads, verifies, loads and retags a missing DocOps image once", async () => {
  const { root, spec } = await fixture();
  const source = await remote();
  const images = new Set<string>();
  const calls: string[][] = [];
  const command: DockerCommand = async args => {
    calls.push([...args]);
    if (args[0] === "image" && args[1] === "inspect") {
      if (!images.has(args[2]!)) throw new Error("missing image");
      return { stdout: `${"a".repeat(64)}\n`, stderr: "" };
    }
    if (args[0] === "load") {
      images.add("harbor-codex-base:2.1.114-amd64");
      return { stdout: "loaded", stderr: "" };
    }
    if (args[0] === "tag") {
      images.add(args[2]!);
      return { stdout: "", stderr: "" };
    }
    throw new Error(`unexpected docker command: ${args.join(" ")}`);
  };
  const provider = new DocOpsImageProvider({
    profile: "amd",
    repository: "fixture/docops",
    revision: "main",
    cacheDir: join(root, "cache"),
  }, command, source.transport);
  const signal = new AbortController().signal;
  await provider.ensureForSpec(spec, signal);
  expect(images.has("harbor-codex-base:2.1.114")).toBe(true);
  expect(calls.some(args => args[0] === "load" && args[1] === "--input")).toBe(true);
  expect(calls).toContainEqual(["tag", "harbor-codex-base:2.1.114-amd64", "harbor-codex-base:2.1.114"]);
  expect(source.requests).toHaveLength(5);
  expect(source.batchRequests).toEqual([{
    operation: "download",
    transfers: ["basic"],
    objects: [{ oid: createHash("sha256").update("controlled docker archive").digest("hex"), size: 25 }],
    hash_algo: "sha256",
  }]);
  const requests = source.requests.length;
  await provider.ensureForSpec(spec, signal);
  expect(source.requests).toHaveLength(requests);
  expect(calls.filter(args => args[0] === "load")).toHaveLength(1);
});

test("does not access the image source when the required image already exists", async () => {
  const { root, spec } = await fixture();
  const command: DockerCommand = async args => {
    if (args[0] === "image" && args[1] === "inspect") return { stdout: `${"b".repeat(64)}\n`, stderr: "" };
    throw new Error("unexpected Docker mutation");
  };
  const provider = new DocOpsImageProvider({
    profile: "amd",
    repository: "fixture/docops",
    revision: "main",
    cacheDir: join(root, "cache"),
  }, command, { apiBase: "http://127.0.0.1:1", lfsBase: "http://127.0.0.1:1" });
  await provider.ensureForSpec(spec, new AbortController().signal);
});

test("rejects a GitHub pointer that does not match the locked tree before LFS negotiation", async () => {
  const { root, spec } = await fixture();
  const source = await remote({ corruptPointer: true });
  const command: DockerCommand = async args => {
    if (args[0] === "image") throw new Error("missing image");
    throw new Error("unexpected image mutation");
  };
  const provider = new DocOpsImageProvider({ profile: "amd", repository: "fixture/docops", revision: "main", cacheDir: join(root, "cache") }, command, source.transport);
  await expect(provider.ensureForSpec(spec, new AbortController().signal)).rejects.toThrow(/pointer checksum mismatch/);
  expect(source.batchRequests).toEqual([]);
});

test("reuses the verified DocOps archive without repeating Git LFS negotiation", async () => {
  const { root, spec } = await fixture();
  const source = await remote();
  const images = new Set<string>();
  let loads = 0;
  const command: DockerCommand = async args => {
    if (args[0] === "image" && args[1] === "inspect") {
      if (!images.has(args[2]!)) throw new Error("missing image");
      return { stdout: `${"d".repeat(64)}\n`, stderr: "" };
    }
    if (args[0] === "load") {
      loads += 1;
      images.add("harbor-codex-base:2.1.114-amd64");
      return { stdout: "loaded", stderr: "" };
    }
    if (args[0] === "tag") {
      images.add(args[2]!);
      return { stdout: "", stderr: "" };
    }
    throw new Error(`unexpected docker command: ${args.join(" ")}`);
  };
  const config = {
    profile: "amd" as const,
    repository: "fixture/docops",
    revision: "main",
    cacheDir: join(root, "cache"),
  };
  await new DocOpsImageProvider(config, command, source.transport).ensureForSpec(spec, new AbortController().signal);
  images.clear();
  await new DocOpsImageProvider(config, command, source.transport).ensureForSpec(spec, new AbortController().signal);

  expect(loads).toBe(2);
  expect(source.requests.filter(request => request.includes("/info/lfs/objects/batch"))).toHaveLength(1);
  expect(source.requests.filter(request => request.startsWith("GET /lfs/objects/"))).toHaveLength(1);
});

test("retags the x86 Codex 0.80 archive with the task image name", async () => {
  const { root, spec } = await fixture();
  const source = await remote({ archivePath: "docker/images/x86/harbor-codex080-chat-base_0.80.0_linux-amd64.tar.gz" });
  const images = new Set<string>();
  const tags: string[][] = [];
  const command: DockerCommand = async args => {
    if (args[0] === "image" && args[1] === "inspect") {
      if (!images.has(args[2]!)) throw new Error("missing image");
      return { stdout: `${"c".repeat(64)}\n`, stderr: "" };
    }
    if (args[0] === "load") {
      images.add("harbor-codex080-chat-base:0.80.0-amd64");
      return { stdout: "loaded", stderr: "" };
    }
    if (args[0] === "tag") {
      tags.push([...args]);
      images.add(args[2]!);
      return { stdout: "", stderr: "" };
    }
    throw new Error(`unexpected docker command: ${args.join(" ")}`);
  };
  const provider = new DocOpsImageProvider({
    profile: "x86",
    repository: "fixture/docops",
    revision: "main",
    cacheDir: join(root, "cache"),
  }, command, source.transport);
  await provider.ensureForSpec(spec, new AbortController().signal);
  expect(tags).toEqual([["tag", "harbor-codex080-chat-base:0.80.0-amd64", "harbor-codex-base:2.1.114"]]);
});

test.each([
  ["mismatched", /differs from its pointer/i],
  ["rejected", /rejected 404.*missing fixture object/i],
] as const)("rejects %s Git LFS batch responses", async (batchMode, message) => {
  const { root, spec } = await fixture();
  const source = await remote({ batchMode });
  const command: DockerCommand = async args => {
    if (args[0] === "image" && args[1] === "inspect") throw new Error("missing image");
    throw new Error(`unexpected Docker mutation: ${args.join(" ")}`);
  };
  const provider = new DocOpsImageProvider({
    profile: "amd",
    repository: "fixture/docops",
    revision: "main",
    cacheDir: join(root, "cache"),
  }, command, source.transport);
  await expect(provider.ensureForSpec(spec, new AbortController().signal)).rejects.toThrow(message);
});
