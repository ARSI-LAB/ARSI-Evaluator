import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runDockerCommand } from "../../../plugins/environments/docker.js";
import { DockerBuildCache } from "../../../plugins/environments/docker-build-cache.js";
import { verifierBuildNetwork } from "../../containers/build-network.js";

const assets = fileURLToPath(new URL("./", import.meta.url));
type ImageCommand = (args: string[], signal: AbortSignal) => Promise<unknown>;

export function createPythonVerifierImage(
  docker: string,
  command: ImageCommand = (args, active) => runDockerCommand(docker, args, { signal: active, maxBuffer: 8 * 1024 * 1024 }),
): (signal: AbortSignal) => Promise<string> {
  // Recheck Docker after completion: a previously built image may have been removed.
  const builds = new DockerBuildCache<string>(false);
  return async signal => {
    signal.throwIfAborted();
    const network = verifierBuildNetwork();
    const hash = createHash("sha256").update(JSON.stringify(network.identity));
    for (const file of ["Dockerfile", "worker.py", "workbuddy.py", "build-runtime.py"]) hash.update(await readFile(join(assets, file)));
    const tag = "ember-harbor-verifier:" + hash.digest("hex").slice(0, 24);
    return builds.getImage(docker, tag, signal, async active => {
      // Another instance or process may have built the image while this caller waited.
      try { await command(["image", "inspect", tag], active); return tag; }
      catch (error) {
        active.throwIfAborted();
        if (!(error instanceof Error) || !/no such (?:image|object)/iu.test(error.message)) throw error;
      }
      await command(["build", ...network.buildArgs, "--tag", tag, assets], active);
      return tag;
    });
  };
}
