import type { ContainerPlatform } from "../../core/contracts/environment.js";
import type { ImageRequestContext } from "../../core/contracts/network.js";
import { DockerEnvironmentError } from "./error.js";
import type { DockerImageInventory } from "./image-inventory.js";
import type { DockerImagePull } from "./image-pull.js";

export async function acquireBaseImage(inventory: DockerImageInventory, reference: string, platform: ContainerPlatform,
  key: string, pull: DockerImagePull, signal: AbortSignal, scope?: ImageRequestContext, preferred?: string) {
  const command = inventory.command;
  const buildInput = scope?.phase === "verify" && !scope.service;
  let available = reference;
  let acquired = false;
  let verifiedDigest: string | undefined;
  try {
    await command(["image", "inspect", "--platform", platform, reference, "--format", "{{.Id}}"], { signal });
  } catch (inspectError) {
    signal.throwIfAborted();
    if (inspectError instanceof DockerEnvironmentError && inspectError.code === "ENV_IMAGE_REFERENCE_INVALID") throw inspectError;
    const cached = await inventory.cached(key, platform, signal, buildInput ? undefined : preferred);
    if (cached) {
      if (!buildInput) await inventory.markRetained(cached.reference, cached.id, signal);
      return cached;
    }
    try {
      const pulled = await pull(reference, platform, signal, scope);
      available = pulled.reference;
      verifiedDigest = pulled.verifiedDigest;
      await command(["image", "inspect", "--platform", platform, available, "--format", "{{.Id}}"], { signal });
      acquired = true;
    } catch (pullError) {
      signal.throwIfAborted();
      throw new DockerEnvironmentError("ENV_IMAGE_PULL_FAILED", `cannot inspect or pull Docker image ${reference}`,
        new AggregateError([inspectError, pullError]));
    }
  }
  const expected = /@(sha256:[a-f0-9]{64})$/u.exec(reference)?.[1];
  if (expected && verifiedDigest !== expected) {
    const { stdout } = await command(["image", "inspect", "--platform", platform, available, "--format", "{{.Id}} {{json .RepoDigests}}"], { signal });
    const match = /^(\S+) (\[[^\]]*\]|null)$/u.exec(stdout.trim());
    const digests: unknown = match ? JSON.parse(match[2]!) : null;
    if (verifiedDigest || !match || match[1] !== expected &&
      !(Array.isArray(digests) && digests.some(value => typeof value === "string" && value.endsWith(`@${expected}`))))
      throw new DockerEnvironmentError("ENV_IMAGE_REFERENCE_INVALID", `Task image does not match pinned digest ${expected}`);
  }
  return inventory.retain(available, platform, signal, { key, removeAlias: acquired, buildInput, acquiredInput: acquired && buildInput,
    ...(preferred ? { preferred } : {}) });
}
