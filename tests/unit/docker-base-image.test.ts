import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import type { ContainerPlatform } from "../../src/core/contracts/environment.js";
import type { DockerCommand } from "../../src/infrastructure/containers/runtime-contract.js";
import { acquireBaseImage } from "../../src/infrastructure/containers/base-image.js";
import { DockerImageInventory } from "../../src/infrastructure/containers/image-inventory.js";

const digest = `sha256:${"d".repeat(64)}`;
const id = `sha256:${"a".repeat(64)}`;
const reference = `registry.example.test/bench:task-v1@${digest}`;
const imported = "ember-evaluator/pull:fixture";
const external = "user/keep:latest";
let directory: string;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), "evaluator-base-image-test-")); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

function docker() {
  const calls: string[][] = [];
  const image = { id, digests: [reference], architecture: "amd64" };
  const images = new Map<string, typeof image>();
  const command: DockerCommand = async (args, options) => {
    options?.signal?.throwIfAborted();
    calls.push([...args]);
    if (args[0] === "info") return { stdout: "fixture", stderr: "" };
    if (args[0] === "pull") { images.set(args.at(-1)!, image); return { stdout: "", stderr: "" }; }
    if (args[0] === "image" && args[1] === "inspect") {
      const name = args[args.includes("--platform") ? 4 : 2]!;
      const found = images.get(name);
      if (!found) throw new Error(`No such image: ${name}`);
      const format = args.at(-1);
      const tags = [...images].filter(([ref, item]) => item === found && !ref.includes("@")).map(([ref]) => ref);
      const stdout = format?.includes("RepoTags") ? JSON.stringify([found.id, tags, found.digests]) :
        format?.includes("Architecture") ? JSON.stringify([found.id, "linux", found.architecture]) :
        format?.includes("RepoDigests") ? found.id + " " + JSON.stringify(found.digests) : found.id;
      return { stdout, stderr: "" };
    }
    if (args[0] === "image" && args[1] === "rm") { images.delete(args.at(-1)!); return { stdout: "", stderr: "" }; }
    throw new Error(`Unexpected Docker operation: ${args.join(" ")}`);
  };
  const inventory = new DockerImageInventory(command, directory);
  const signal = new AbortController().signal;
  const pull = async () => {
    images.set(imported, image);
    return { reference: imported, verifiedDigest: digest };
  };
  const acquire = (platform: ContainerPlatform = "linux/amd64", scope?: { phase: "solve" | "verify"; taskId: string }) =>
    inventory.use(undefined, signal, () => acquireBaseImage(inventory, reference, platform, platform, pull, signal, scope));
  return { image, images, calls, acquire, inventory, signal };
}

test("a preexisting pinned source reference is reused without retagging or removing user aliases", async () => {
  const fake = docker();
  fake.images.set(reference, fake.image);
  fake.images.set(external, fake.image);
  await expect(fake.acquire()).resolves.toMatchObject({ reference, id, digest: id });
  expect([...fake.images.keys()]).toEqual([reference, external]);
  expect(fake.calls.some(args => args[1] === "tag" || args[1] === "rm")).toBe(false);
});

test("an imported alias is released when the same image already has a user reference", async () => {
  const fake = docker();
  fake.images.set(external, fake.image);
  await expect(fake.acquire()).resolves.toMatchObject({ reference: external, digest: id });
  expect([...fake.images.keys()]).toEqual([external]);
  await expect(fake.acquire()).resolves.toMatchObject({ reference: external, digest: id });
});

test("verify-only imported input is released after use, and solve input stays retained", async () => {
  const fake = docker();
  await expect(fake.acquire("linux/amd64", { phase: "verify", taskId: "verify" })).resolves.toMatchObject({ reference: imported, id });
  await fake.inventory.releaseBuildInput(imported, id, fake.signal);
  expect(fake.images.has(imported)).toBe(false);
  await fake.acquire("linux/amd64", { phase: "solve", taskId: "solve" });
  await fake.acquire("linux/amd64", { phase: "verify", taskId: "verify" });
  await fake.inventory.releaseBuildInput(imported, id, fake.signal);
  expect(fake.images.has(imported)).toBe(true);
});

test("releasing a build-only registry digest preserves tags that could be removed with it", async () => {
  const fake = docker();
  await fake.inventory.use(undefined, fake.signal, () => fake.inventory.command(["pull", reference], { signal: fake.signal }));
  await fake.inventory.retain(reference, "linux/amd64", fake.signal, { buildInput: true, acquiredInput: true });
  fake.images.set(external, fake.image);
  await fake.inventory.releaseBuildInput(reference, id, fake.signal);
  expect([...fake.images.keys()]).toEqual([reference, external]);
  expect(fake.calls.some(args => args[1] === "rm")).toBe(false);
});

test("two acquired registry digest names for the same image reuse the first retained reference", async () => {
  const fake = docker();
  const alternative = `registry.example.test/another@${digest}`;
  fake.image.digests.push(alternative);
  const acquire = (name: string) => fake.inventory.use(undefined, fake.signal, () =>
    acquireBaseImage(fake.inventory, name, "linux/amd64", name, async (ref, _platform, signal) => {
      await fake.inventory.command(["pull", ref], { signal });
      return { reference: ref };
    }, fake.signal));
  await expect(acquire(reference)).resolves.toMatchObject({ reference, digest: id });
  await expect(acquire(alternative)).resolves.toMatchObject({ reference, digest: id });
  await expect(acquire(alternative)).resolves.toMatchObject({ reference, digest: id });
  expect([...fake.images.keys()]).toEqual([reference]);
  expect(fake.calls.filter(args => args[0] === "pull")).toHaveLength(2);
});

test("wrong source digests and platforms are rejected before references are removed", async () => {
  const fake = docker();
  fake.images.set(reference, fake.image);
  fake.image.digests = [];
  await expect(fake.acquire()).rejects.toMatchObject({ code: "ENV_IMAGE_REFERENCE_INVALID" });
  fake.image.digests = [reference];
  fake.image.architecture = "arm64";
  await expect(fake.acquire()).rejects.toMatchObject({ code: "ENV_ARCH_UNSUPPORTED" });
  expect(fake.calls.some(args => args[1] === "tag" || args[1] === "rm")).toBe(false);
});

test("an offline cached source is rejected when its retained reference changes identity", async () => {
  const fake = docker();
  await fake.acquire();
  fake.images.set(imported, { ...fake.image, id: "sha256:" + "f".repeat(64) });
  await expect(fake.acquire()).rejects.toMatchObject({ code: "ENV_IMAGE_REFERENCE_INVALID" });
});
