import "../fixtures/network-fetch.js";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, test, vi } from "vitest";
import { DatasetCache, GitLfsCache, parseGitLfsPointer } from "ember-evaluator";

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture(size?: number) {
  const root = await mkdtemp(join(tmpdir(), "git-lfs-"));
  roots.push(root);
  const bytes = Buffer.from("reusable binary dataset");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const pointer = Buffer.from(`version https://git-lfs.github.com/spec/v1\noid sha256:${sha256}\nsize ${size ?? bytes.length}\n`);
  const cache = new DatasetCache(root);
  const source = new GitLfsCache(cache);
  const response = { transfer: "basic", objects: [{ oid: sha256, size: size ?? bytes.length,
    actions: { download: { href: "https://binary.example/object", header: { Authorization: "Bearer fixture" } } } }] };
  return { root, bytes, sha256, pointer, cache, source, response };
}

test.each(["", "version invalid\n", `version https://git-lfs.github.com/spec/v1\noid sha256:${"a".repeat(64)}\nsize 9007199254740992\n`])(
  "rejects invalid LFS pointers before contacting a source: %j", pointer => {
    expect(() => parseGitLfsPointer(Buffer.from(pointer))).toThrow(/Git LFS/);
  });

test("verified LFS cache avoids batch negotiation, while corrupt bytes are downloaded again with action headers", async () => {
  const { root, bytes, pointer, sha256, source, cache, response } = await fixture();
  const fetcher = vi.fn().mockResolvedValueOnce(Response.json(response)).mockResolvedValueOnce(new Response(bytes));
  vi.stubGlobal("fetch", fetcher);
  await mkdir(join(root, "objects"));
  await writeFile(cache.objectPath(sha256), "corrupt bytes");
  const signal = new AbortController().signal;
  const path = await source.fetch("https://git.example/batch", pointer, signal);
  expect(await readFile(path)).toEqual(bytes);
  expect(fetcher).toHaveBeenCalledWith("https://binary.example/object", expect.objectContaining({ headers: { Authorization: "Bearer fixture" } }));
  expect(await source.fetch("https://git.example/batch", pointer, signal)).toBe(path);
  expect(fetcher).toHaveBeenCalledTimes(2);
});

test("mismatched LFS bytes never become a valid cache object", async () => {
  const { root, pointer, sha256, source, cache, response } = await fixture();
  vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(Response.json(response)).mockResolvedValueOnce(new Response("tampered")));
  await expect(source.fetch("https://git.example/batch", pointer, new AbortController().signal)).rejects.toThrow(/checksum mismatch/);
  expect(await cache.cached(sha256, new AbortController().signal)).toBeNull();
  expect((await readdir(root)).filter(name => name.endsWith(".tmp"))).toEqual([]);
});

test("LFS pointer size is checked on both downloaded and cached objects", async () => {
  const { bytes, pointer, source, response } = await fixture(123);
  const fetcher = vi.fn().mockResolvedValueOnce(Response.json(response)).mockResolvedValueOnce(new Response(bytes));
  vi.stubGlobal("fetch", fetcher);
  const signal = new AbortController().signal;
  await expect(source.fetch("https://git.example/batch", pointer, signal)).rejects.toThrow(/size differs/);
  await expect(source.fetch("https://git.example/batch", pointer, signal)).rejects.toThrow(/size differs/);
  expect(fetcher).toHaveBeenCalledTimes(2);
});

test("cancellation during LFS transfer removes partial files", async () => {
  const { root, source, pointer, response, sha256, cache } = await fixture();
  const controller = new AbortController();
  const fetcher = vi.fn().mockResolvedValueOnce(Response.json(response)).mockImplementationOnce(async (_url, options: RequestInit) => {
    const stream = new ReadableStream<Uint8Array>({
      start(target) {
        target.enqueue(Buffer.from("partial"));
        options.signal?.addEventListener("abort", () => target.error(options.signal?.reason), { once: true });
      },
    });
    return new Response(stream);
  });
  vi.stubGlobal("fetch", fetcher);
  const result = source.fetch("https://git.example/batch", pointer, controller.signal);
  const rejection = expect(result).rejects.toThrow("cancel transfer");
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
  controller.abort(new Error("cancel transfer"));
  await rejection;
  expect(await cache.cached(sha256, new AbortController().signal)).toBeNull();
  expect((await readdir(root)).filter(name => name.endsWith(".tmp"))).toEqual([]);
});
