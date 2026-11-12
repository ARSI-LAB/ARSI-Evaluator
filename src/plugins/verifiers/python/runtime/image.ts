import { tmpdir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { readFile, mkdtemp, cp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runDockerCommand } from "../../../../infrastructure/containers/command.js";
import { DockerBuildCache } from "../../../../infrastructure/containers/build-cache.js";
import { dockerBuildNetwork } from "../../../../infrastructure/containers/build-network.js";
import { PlatformCapabilityDetector } from "../../../../infrastructure/containers/platform.js";
import type { DockerImageInventory } from "../../../../infrastructure/containers/image-inventory.js";
import type { EnvironmentSpec } from "../../../../core/contracts/environment.js";
import { dockerImageReference } from "../../../../infrastructure/containers/image-name.js";

const assets = fileURLToPath(new URL("./", import.meta.url));
type ImageCommand = (args: string[], signal: AbortSignal, env?: NodeJS.ProcessEnv) => Promise<unknown>;

export function createPythonVerifierImage(
  docker: string,
  command: ImageCommand = (args, active, env) => runDockerCommand(docker, args, { ...(env ? { env } : {}), signal: active, maxBuffer: 8 * 1024 * 1024 }),
  access?: import("../../../../core/contracts/network.js").NetworkAccess,
  inventory?: DockerImageInventory,
): (signal: AbortSignal, scope?: EnvironmentSpec["imageScope"]) => Promise<string> {
  // Recheck Docker after completion: a previously built image may have been removed.
  const builds = new DockerBuildCache<string>(false);
  return async (signal, scope) => {
    signal.throwIfAborted();
    const network = dockerBuildNetwork(access);
    const hash = createHash("sha256").update(JSON.stringify(network.identity));
    for (const file of ["Dockerfile", "worker.py", "workbuddy.py", "build-runtime.py"]) hash.update(await readFile(join(assets, file)));
    const tag = "ember-harbor-verifier:" + hash.digest("hex").slice(0, 24);
    return builds.getImage(docker, tag, signal, async active => {
      const platform = inventory ? await new PlatformCapabilityDetector(inventory.command).nativePlatform(active) : undefined;
      const preferred = platform ? dockerImageReference(platform, "verify", scope) : undefined;
      const key = `verifier:${platform}:${tag}`;
      if (inventory && platform) {
        const cached = await inventory.cached(key, platform, active, preferred);
        if (cached) return cached.reference;
      }
      // Another instance or process may have built the image while this caller waited.
      let existing = false;
      try { await command(["image", "inspect", tag], active); existing = true; }
      catch (error) {
        active.throwIfAborted();
        if (!(error instanceof Error) || !/no such (?:image|object)/iu.test(error.message)) throw error;
      }
      const retain = (reference: string, temporary: boolean) => inventory && platform && preferred
        ? inventory.retain(reference, platform, active, { key, preferred, temporary }).then(result => result.reference)
        : Promise.resolve(reference);
      if (existing) return retain(tag, false);
      const context = await mkdtemp(join(tmpdir(), "evaluator-verifier-build-"));
      const output = inventory ? `ember-evaluator/staging:${randomUUID()}` : tag;
      try {
        await cp(assets, context, { recursive: true });
        await writeFile(join(context, "Dockerfile"), network.recipe(await readFile(join(assets, "Dockerfile"), "utf8")));
        await command(["build", ...network.buildArgs, "--tag", output, context], active, network.environment);
        return await retain(output, output !== tag);
      } finally {
        try { if (output !== tag) await inventory?.discardStaging(output, AbortSignal.timeout(30_000)); }
        finally { await rm(context, { recursive: true, force: true }); }
      }
    });
  };
}
