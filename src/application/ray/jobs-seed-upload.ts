import { open } from "node:fs/promises";
import { buildFileManifest, checkedPath } from "../../core/artifacts/artifacts.js";
import { workflowDigest } from "../../core/workflow/values.js";
import { expectRecord } from "../../core/validation/input.js";
import type { JobsClient } from "../../infrastructure/ray/jobs-client.js";
import { JOBS_SEED_CHUNK_BYTES, travelsWithRun } from "../../infrastructure/ray/jobs-seed.js";

/** Upload immutable evidence and current metadata; process locks and retry owners never travel. */
export async function uploadJobsSeed(client: JobsClient, id: string, runId: string, directory: string, signal: AbortSignal): Promise<string> {
  const inventory = await buildFileManifest(directory, []);
  if (inventory.missing.some(file => travelsWithRun(file.path))) throw new TypeError("Resume files are missing, unreadable or symbolic links");
  const files = inventory.files.filter(file => travelsWithRun(file.path));
  const digest = workflowDigest({ runId, files });
  const route = `/jobs/${id}/seed`;
  const started = expectRecord(await client.call(route, { op: "start", runId, files }, signal), "seed upload");
  if (started.digest !== digest) throw new TypeError("Gateway seed inventory differs from local files");
  if (started.committed === true) return digest;
  for (const entry of files) {
    const file = await open(await checkedPath(directory, entry.path), "r");
    try {
      for (let offset = 0; offset < entry.size || offset === 0; offset += JOBS_SEED_CHUNK_BYTES) {
        signal.throwIfAborted();
        const bytes = Buffer.alloc(Math.min(JOBS_SEED_CHUNK_BYTES, entry.size - offset));
        const result = await file.read(bytes, 0, bytes.length, offset);
        if (result.bytesRead !== bytes.length) throw new Error(`Resume file changed: ${entry.path}`);
        await client.call(route, { op: "chunk", path: entry.path, offset, data: bytes.toString("base64") }, signal);
      }
    } finally { await file.close(); }
  }
  const committed = expectRecord(await client.call(route, { op: "commit" }, signal), "seed commit");
  if (committed.digest !== digest) throw new TypeError("Gateway committed a different seed");
  return digest;
}
