import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { ContainerPlatform, PreparationCacheSource } from "../../core/contracts/environment.js";
import type { ArchiveImageAcquisition, ImageRequestContext, NetworkAccess } from "../../core/contracts/network.js";
import { EvaluatorError } from "../../core/errors/evaluator-error.js";
import { downloadArchiveImage, taskArchiveUrl } from "./archive-image.js";
import type { DockerImageInventory } from "./image-inventory.js";
import { dockerImageReference } from "./image-name.js";
import { prepareTaskArchiveImport } from "./task-archive-import.js";
import { dockerActivity } from "./progress.js";
import type { DockerCommand } from "./runtime-contract.js";
import { applicationCacheRoot } from "../runtime-installation/install.js";
import { acquireRuntimeLock } from "../runtime-installation/lock.js";

export class DockerTaskArchive {
  constructor(private readonly command: DockerCommand, private readonly inventory: DockerImageInventory, private readonly settings: ArchiveImageAcquisition,
    private readonly network: NetworkAccess) {}

  source(context: ImageRequestContext, platform: ContainerPlatform): string {
    return this.network.sourceUrl(taskArchiveUrl(this.settings, context, platform));
  }

  async load(context: ImageRequestContext, platform: ContainerPlatform, signal: AbortSignal,
    observe?: (source: PreparationCacheSource) => void,
    preferred = dockerImageReference(platform, context.service ? `${context.phase}-service-${context.service}` : "base")): Promise<{ reference: string; pinnedReference: string; id: string }> {
    const url = this.source(context, platform);
    const key = createHash("sha256").update(JSON.stringify([url, platform])).digest("hex");
    const buildInput = context.phase === "verify" && !context.service;
    const cache = join(process.env.EVALUATOR_CACHE_DIR ?? applicationCacheRoot(), "archive-images");
    await mkdir(cache, { recursive: true });
    const release = await acquireRuntimeLock(join(cache, `${key}.lock`), signal);
    try {
      const cached = await this.inventory.cached(`archive:${key}`, platform, signal, buildInput ? undefined : preferred);
      if (cached) {
        if (!buildInput) await this.inventory.markRetained(cached.reference, cached.id, signal);
        observe?.("image");
        return { reference: cached.reference, pinnedReference: cached.reference, id: cached.digest };
      }
      const activity = dockerActivity();
      const operationId = randomUUID();
      const report: typeof activity = activity ? event => activity({ ...event, operationId }) : undefined;
      report?.({ message: `Downloading task image archive (${context.phase}, ${platform})`, status: "started" });
      const tag = `ember-evaluator/staging:${operationId}`;
      const directory = await mkdtemp(join(cache, "import-"));
      try {
        let imported: Awaited<ReturnType<typeof prepareTaskArchiveImport>> | undefined;
        await downloadArchiveImage(url, this.settings, this.network, cache, signal, report, async archive => {
          imported = await prepareTaskArchiveImport(archive, directory, tag, platform, signal);
        });
        if (!imported) throw new Error("Docker archive validation did not complete");
        report?.({ message: "Loading task image archive into Docker" });
        await this.command(["load", "--input", imported.archive], { signal, maxBuffer: 8 * 1024 * 1024 });
        const id = (await this.command(["image", "inspect", "--platform", platform, tag, "--format", "{{.Id}}"], { signal })).stdout.trim();
        if (id !== imported.configId && id !== imported.manifestId) throw new Error("Docker imported image does not match the selected archive image");
        const image = await this.inventory.retain(tag, platform, signal, { key: `archive:${key}`, temporary: true, buildInput, preferred });
        observe?.("reference");
        report?.({ message: "Task image archive loaded", status: "completed" });
        return { reference: image.reference, pinnedReference: image.reference, id: image.digest };
      } catch (error) {
        report?.({ status: signal.aborted ? "cancelled" : "failed" });
        throw error;
      } finally {
        try { await this.inventory.discardStaging(tag, AbortSignal.timeout(30_000)); }
        finally { await rm(directory, { recursive: true, force: true }); }
      }
    } catch (error) {
      signal.throwIfAborted();
      throw new EvaluatorError("ENV_IMAGE_PULL_FAILED", `Cannot load task image archive for ${context.taskId}/${context.phase}`,
        { component: "docker", operation: "load" }, { cause: error });
    } finally { await release(); }
  }
}
