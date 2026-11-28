import type { ImageCleanupSummary } from "../core/contracts/image-cleanup.js";

/** Host-wide image cleanup without an experiment. Scoped cleanup belongs to workflow resources. */
export async function cleanupImages(options: { execute: boolean; signal: AbortSignal }): Promise<ImageCleanupSummary> {
  const { DockerEnvironment } = await import("../plugins/environments/docker/environment.js");
  const result = await new DockerEnvironment().cleanupImages({ all: true, execute: options.execute }, options.signal);
  return { preview: !options.execute, nodes: [result] };
}
