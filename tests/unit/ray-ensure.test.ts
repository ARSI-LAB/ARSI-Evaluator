import { mkdtemp, mkdir, rm, writeFile, symlink, lstat, readFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { deploymentFingerprint, deploymentPlan, stageDeploymentBuildContext, type ServiceState } from "../../scripts/ray-smoke/ensure.mjs";

const digest = `sha256:${"a".repeat(64)}`;
const appServices = ["head", "worker-a", "worker-b", "gateway", "coordinator"];
const dependencies = ["docker-a", "docker-b"];

function clusterStates(imageId: string): Record<string, ServiceState> {
  return Object.fromEntries([...appServices, ...dependencies].map(name => [name, {
    id: name,
    imageId: appServices.includes(name) ? imageId : "docker-image",
    running: true,
    health: ["head", ...dependencies].includes(name) ? "healthy" : null,
  }]));
}

describe("local Ray environment reuse", () => {
  test("Docker build staging copies the SDK behind a pnpm workspace link and removes only staging files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ray-pnpm-context-"));
    const workspace = join(directory, "evaluator"), sdk = join(directory, "linked-sdk");
    try {
      for (const path of ["dist", "scripts", "tests/fixtures/ray", "node_modules"]) await mkdir(join(workspace, path), { recursive: true });
      await mkdir(join(sdk, "dist"), { recursive: true });
      await writeFile(join(sdk, "package.json"), '{"name":"agent-bundle-core"}');
      await writeFile(join(sdk, "dist/index.js"), "export const sdk = true;\n");
      await writeFile(join(workspace, "dist/index.js"), "export {};\n");
      await writeFile(join(workspace, "tests/fixtures/ray/plugin.mjs"), "export {};\n");
      await symlink(sdk, join(workspace, "node_modules/agent-bundle-core"), process.platform === "win32" ? "junction" : "dir");
      const context = await stageDeploymentBuildContext(workspace);
      try {
        expect((await lstat(join(context.directory, "node_modules/agent-bundle-core"))).isSymbolicLink()).toBe(false);
        expect(await readFile(join(context.directory, "node_modules/agent-bundle-core/dist/index.js"), "utf8")).toContain("sdk = true");
      } finally { await context.dispose(); }
      await expect(access(context.directory)).rejects.toThrow();
      expect(await readFile(join(sdk, "dist/index.js"), "utf8")).toContain("sdk = true");
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  test("reuses a healthy cluster with the desired image", () => {
    expect(deploymentPlan("current", { id: "image-1", fingerprint: "current" }, clusterStates("image-1")))
      .toEqual({ build: false, ready: true, forceRecreate: false });
  });

  test("builds when source inputs change and recreates unhealthy containers", () => {
    const states = clusterStates("image-1");
    expect(deploymentPlan("new", { id: "image-1", fingerprint: "old" }, states))
      .toEqual({ build: true, ready: false, forceRecreate: false });
    states.head!.health = "unhealthy";
    expect(deploymentPlan("old", { id: "image-1", fingerprint: "old" }, states))
      .toEqual({ build: false, ready: false, forceRecreate: true });
    delete states["worker-b"];
    expect(deploymentPlan("old", { id: "image-1", fingerprint: "old" }, states).ready).toBe(false);
  });

  test("fingerprints contents rather than file timestamps", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "evaluator-ray-ensure-"));
    try {
      await mkdir(join(workspace, "scripts"), { recursive: true });
      await mkdir(join(workspace, "tests", "fixtures", "ray"), { recursive: true });
      await mkdir(join(workspace, "node_modules", "agent-bundle-core", "dist"), { recursive: true });
      const script = join(workspace, "scripts", "start.mjs");
      await writeFile(script, "old");
      await writeFile(join(workspace, "tests", "fixtures", "ray", "plugin.mjs"), "fixture");
      await writeFile(join(workspace, "node_modules", "agent-bundle-core", "package.json"), "{}");
      await writeFile(join(workspace, "node_modules", "agent-bundle-core", "dist", "index.mjs"), "export {};");
      const first = await deploymentFingerprint(digest, workspace);
      expect(await deploymentFingerprint(digest, workspace)).toBe(first);
      await writeFile(script, "new");
      expect(await deploymentFingerprint(digest, workspace)).not.toBe(first);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
