import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { DockerRuntime, PINNED_NODE_IMAGE, type DockerCommand } from "../../src/plugins/environments/docker-runtime.js";

afterEach(() => vi.unstubAllEnvs());
const origin = "https://fixture.mirror.swr.myhuaweicloud.com";
const mirrored = `${new URL(origin).host}/library/${PINNED_NODE_IMAGE}`;
const digest = "sha256:" + "a".repeat(64);

test.each(["linux/amd64", "linux/arm64"] as const)("shares a Huawei Node pull and builds with its pinned reference on %s", async platform => {
  vi.stubEnv("EVALUATOR_NODE_IMAGE_MIRROR", "");
  const calls: string[][] = [];
  let pulled = false;
  const command: DockerCommand = async args => {
    if (args.at(-1) === "{{json .Config.User}}") return { stdout: JSON.stringify(""), stderr: "" };
    calls.push(args);
    if (args[0] === "info") return { stdout: JSON.stringify(["https://other.test", origin + "/"]), stderr: "" };
    if (args[0] === "pull") { pulled = true; return { stdout: "", stderr: "" }; }
    if (args[0] === "build") {
      expect(args).toContain(`NODE_IMAGE=${mirrored}`);
      expect(await readFile(join(args.at(-1)!, "Dockerfile"), "utf8")).toContain("FROM ${NODE_IMAGE}");
      return { stdout: "", stderr: "" };
    }
    const ref = args[4];
    if (ref === PINNED_NODE_IMAGE || (ref === mirrored && !pulled)) throw new Error("No such image");
    if (ref?.includes(":solve-runtime-") && !calls.some(call => call[0] === "build")) throw new Error("No such image");
    return { stdout: args.at(-1)?.includes("RepoDigests") ? `${digest} ${JSON.stringify([mirrored])}` : digest, stderr: "" };
  };
  const runtime = new DockerRuntime(command, PINNED_NODE_IMAGE, platform);
  await Promise.all([runtime.prepare("base", [], AbortSignal.timeout(5000)), runtime.prepare("base", [], AbortSignal.timeout(5000))]);
  expect(runtime.nodeImage).toBe(mirrored);
  expect(calls.filter(args => args[0] === "pull")).toEqual([["pull", "--platform", platform, mirrored]]);
  expect(calls.filter(args => args[0] === "info")).toHaveLength(1);
  expect(calls.filter(args => args[0] === "build")).toHaveLength(1);
});

test("keeps a locally cached official Node image without contacting a registry", async () => {
  const command = vi.fn<DockerCommand>().mockResolvedValue({ stdout: `${digest} ${JSON.stringify([PINNED_NODE_IMAGE])}`, stderr: "" });
  const runtime = new DockerRuntime(command);
  expect(await runtime.nodeImageDigest(AbortSignal.timeout(5000))).toBe(digest);
  expect(runtime.nodeImage).toBe(PINNED_NODE_IMAGE);
  expect(command).toHaveBeenCalledTimes(1);
});

test("an explicit mirror still rejects the wrong digest without falling back", async () => {
  vi.stubEnv("EVALUATOR_NODE_IMAGE_MIRROR", origin);
  const calls: string[][] = [];
  const command: DockerCommand = async args => {
    if (args.at(-1) === "{{json .Config.User}}") return { stdout: JSON.stringify(""), stderr: "" };
    calls.push(args);
    if (args[4] === PINNED_NODE_IMAGE) throw new Error("No such image");
    return { stdout: `${digest} ["registry.test/node@sha256:${"b".repeat(64)}"]`, stderr: "" };
  };
  await expect(new DockerRuntime(command).nodeImageDigest(AbortSignal.timeout(5000))).rejects.toThrow("expected sha256:");
  expect(calls).toHaveLength(2);
});

test("fails immediately on a Huawei pull error without retrying Docker Hub", async () => {
  vi.stubEnv("EVALUATOR_NODE_IMAGE_MIRROR", "");
  const pulls: string[] = [];
  const command: DockerCommand = async args => {
    if (args.at(-1) === "{{json .Config.User}}") return { stdout: JSON.stringify(""), stderr: "" };
    if (args[0] === "info") return { stdout: JSON.stringify([origin]), stderr: "" };
    if (args[0] === "pull") { pulls.push(args.at(-1)!); throw new Error("registry timeout"); }
    throw new Error("No such image");
  };
  await expect(new DockerRuntime(command).nodeImageDigest(AbortSignal.timeout(5000))).rejects.toThrow("registry timeout");
  expect(pulls).toEqual([mirrored]);
});
