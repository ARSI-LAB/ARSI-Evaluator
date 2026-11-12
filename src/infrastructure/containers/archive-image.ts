import { createHash, randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ContainerPlatform } from "../../core/contracts/environment.js";
import type { ArchiveImageAcquisition, ImageRequestContext, NetworkAccess } from "../../core/contracts/network.js";
import type { ActivityListener } from "../../core/contracts/activity.js";
import { DatasetCache } from "../datasets/cache.js";
import { withDatasetActivity } from "../datasets/activity.js";

function segment(value: string): string {
  if (!value || value === "." || value === ".." || /[\\\u0000-\u001f]/u.test(value)) throw new Error("Invalid task archive path segment");
  return encodeURIComponent(value);
}

export function taskArchiveUrl(settings: ArchiveImageAcquisition, context: ImageRequestContext, platform: ContainerPlatform): string {
  const parts = context.taskId.split("/").map(segment);
  // The benchmark download root already identifies the task namespace.
  const task = (parts.length > 1 ? parts.slice(1) : parts).join("/");
  const file = context.service === undefined ? `${context.phase}.tar.gz` : `${context.phase}/services/${segment(context.service)}.tar.gz`;
  return `${settings.baseUrl.replace(/\/$/u, "")}/${task}/${platform}/${file}`;
}

/** Store the bytes per immutable archive URL while the caller holds its import lock. */
export async function downloadArchiveImage(url: string, settings: ArchiveImageAcquisition, network: NetworkAccess,
  cacheRoot: string, signal: AbortSignal, activity?: ActivityListener, validate?: (archive: string) => Promise<void>): Promise<string> {
  const target = network.sourceUrl(url);
  const origin = new URL(target).origin;
  const token = settings.provider === "huggingface" && ["https://huggingface.co", network.settings.sources.huggingface].includes(origin)
    ? process.env.HF_TOKEN : settings.provider === "modelscope" && new URL(target).hostname === "modelscope.cn" ? process.env.MODELSCOPE_API_TOKEN : undefined;
  const cache = new DatasetCache(join(cacheRoot, "archives"), network);
  const receipt = join(cacheRoot, `download-${createHash("sha256").update(target).digest("hex")}`);
  const expected = await readFile(receipt, "utf8").catch(error => {
    if (error?.code === "ENOENT") return "";
    throw error;
  });
  return withDatasetActivity(event => activity?.(event), async () => {
    const cached = /^[a-f0-9]{64}$/u.test(expected) ? await cache.cached(expected, signal) : null;
    if (cached) {
      await validate?.(cached.path);
      return cached.path;
    }
    const downloaded = await cache.fetch(target, null, signal, token ? { authorization: `Bearer ${token}` } : undefined);
    await validate?.(downloaded.path);
    const temporary = `${receipt}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, downloaded.sha256, { flag: "wx", mode: 0o600, signal });
      await rename(temporary, receipt);
    } finally { await rm(temporary, { force: true }); }
    return downloaded.path;
  });
}
