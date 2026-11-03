import { retryNetworkOperation } from "../../adapters/network/retry.js";
import type { DockerCommand } from "./docker-runtime.js";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ContainerPlatform } from "../../core/contracts/environment.js";
import { downloadRegistryImage, parseDockerPullProxy } from "../../adapters/containers/registry-image.js";
import { EvaluatorError } from "../../core/errors/evaluator-error.js";
import { DockerBuildCache } from "./docker-build-cache.js";
import { dockerActivity } from "./docker-progress.js";
import { applicationCacheRoot } from "./runtime-installation.js";
import { acquireRuntimeLock } from "./runtime-lock.js";

export { parseDockerPullProxy } from "../../adapters/containers/registry-image.js";
export type DockerImagePull = (reference: string, platform: ContainerPlatform, signal: AbortSignal) => Promise<{
  reference: string;
  /** Present only after registry content and imported image identity have both been verified. */
  verifiedDigest?: string;
}>;

/** Retry only the pull; never replay image construction or task preparation. */
export async function pullDockerImage(
  command: DockerCommand,
  reference: string,
  platform: string,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  await retryNetworkOperation(() => command(["pull", "--platform", platform, reference], { signal, maxBuffer: 8 * 1024 * 1024 }),
    { signal, context: { phase: "environment", component: "docker", operation: "pull" } });
}

type PullReceipt = { schemaVersion: 1; reference: string; platform: ContainerPlatform; tag: string; id: string;
  sourceDigest: string; manifestDigest: string; configDigest: string };
const digestPattern = /^sha256:[a-f0-9]{64}$/u;

async function readReceipt(path: string, reference: string, platform: ContainerPlatform, tag: string): Promise<PullReceipt | undefined> {
  let raw: string;
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Unsafe image pull receipt");
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
  const data: unknown = JSON.parse(raw);
  if (typeof data !== "object" || data === null || !("schemaVersion" in data) || data.schemaVersion !== 1 ||
      !("reference" in data) || data.reference !== reference || !("platform" in data) || data.platform !== platform ||
      !("tag" in data) || data.tag !== tag) throw new Error("Invalid image pull receipt");
  const readDigest = (key: "id" | "sourceDigest" | "manifestDigest" | "configDigest"): string => {
    if (!(key in data)) throw new Error("Invalid image pull receipt digest");
    const value: unknown = data[key as keyof typeof data];
    if (typeof value !== "string" || !digestPattern.test(value)) throw new Error("Invalid image pull receipt digest");
    return value;
  };
  const receipt: PullReceipt = { schemaVersion: 1, reference, platform, tag, id: readDigest("id"),
    sourceDigest: readDigest("sourceDigest"), manifestDigest: readDigest("manifestDigest"), configDigest: readDigest("configDigest") };
  if (![receipt.manifestDigest, receipt.configDigest].includes(receipt.id) ||
      reference.includes("@") && reference.split("@")[1] !== receipt.sourceDigest)
    throw new Error("Image pull receipt does not match its verified source");
  return receipt;
}

async function importedImage(command: DockerCommand, tag: string, platform: ContainerPlatform, signal: AbortSignal): Promise<string | undefined> {
  let output;
  try {
    output = await command(["image", "inspect", "--platform", platform, tag, "--format", "[{{json .Id}},{{json .Os}},{{json .Architecture}}]"], { signal });
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof Error && /no such (?:image|object)|not found/iu.test(error.message)) return undefined;
    throw error;
  }
  const value: unknown = JSON.parse(output.stdout);
  if (!Array.isArray(value) || typeof value[0] !== "string" || !digestPattern.test(value[0]) || `${String(value[1])}/${String(value[2])}` !== platform)
    throw new Error("Imported image identity or platform is invalid");
  return value[0];
}

/** Select the transport per environment; only this client's registry requests use pullProxy. */
export function createDockerImagePuller(command: DockerCommand, proxy?: string): DockerImagePull {
  if (proxy === undefined) return async (reference, platform, signal) => {
    await pullDockerImage(command, reference, platform, signal);
    return { reference };
  };
  const pullProxy = parseDockerPullProxy(proxy);
  const downloads = new DockerBuildCache<Awaited<ReturnType<DockerImagePull>>>(false);
  return (reference, platform, signal) => downloads.get(JSON.stringify([reference, platform]), signal, async active => {
    const key = createHash("sha256").update(JSON.stringify([reference, platform])).digest("hex");
    const tag = `ember-evaluator/pull:${key}`;
    const cache = join(process.env.EVALUATOR_CACHE_DIR ?? applicationCacheRoot(), "docker-pulls");
    await mkdir(cache, { recursive: true, mode: 0o700 });
    const path = join(cache, `${key}.json`);
    const release = await acquireRuntimeLock(join(cache, `${key}.lock`), active);
    try {
      const receipt = await readReceipt(path, reference, platform, tag);
      if (receipt) {
        const id = await importedImage(command, tag, platform, active);
        if (id && ![receipt.configDigest, receipt.manifestDigest].includes(id)) throw new Error("Cached proxy-pulled image tag was replaced");
        if (id) return { reference: tag, verifiedDigest: receipt.sourceDigest };
      }
      const directory = await mkdtemp(join(tmpdir(), "evaluator-image-pull-"));
      const activity = dockerActivity();
      const operationId = randomUUID();
      const report = activity ? (event: Parameters<NonNullable<typeof activity>>[0]) => activity({ ...event, operationId }) : undefined;
      report?.({ message: `Pulling image ${reference}`, status: "started", activity: true });
      try {
        const image = await downloadRegistryImage(reference, platform, pullProxy, directory, tag, active, report);
        report?.({ message: "Importing verified image into Docker", activity: true });
        await command(["load", "--input", image.archive], { signal: active, maxBuffer: 8 * 1024 * 1024 });
        const id = await importedImage(command, tag, platform, active);
        if (!id || ![image.configDigest, image.manifestDigest].includes(id)) throw new Error("Docker imported image does not match verified registry content");
        const receipt: PullReceipt = { schemaVersion: 1, reference, platform, tag, id, sourceDigest: image.sourceDigest,
          configDigest: image.configDigest, manifestDigest: image.manifestDigest };
        const temporary = `${path}.${randomUUID()}.tmp`;
        try {
          await writeFile(temporary, JSON.stringify(receipt) + "\n", { flag: "wx", mode: 0o600 });
          await rename(temporary, path);
        } finally { await rm(temporary, { force: true }); }
        report?.({ message: "Image download and import completed", status: "completed", activity: true });
        return { reference: tag, verifiedDigest: image.sourceDigest };
      } catch (error) {
        report?.({ status: active.aborted ? "cancelled" : "failed" });
        throw error;
      } finally { await rm(directory, { recursive: true, force: true }); }
    } catch (error) {
      active.throwIfAborted();
      // Import/cache errors are generated locally; proxy and registry credentials never enter this message.
      throw new EvaluatorError("ENV_IMAGE_PULL_FAILED", `Cannot acquire Docker image ${reference} through pullProxy`,
        { component: "docker", operation: "pull" }, { cause: error });
    } finally { await release(); }
  });
}
