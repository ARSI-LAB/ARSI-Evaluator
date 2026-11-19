import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { expectNonEmptyString, expectRecord } from "../../core/validation/input.js";
import { evidencePath } from "../../core/artifacts/artifacts.js";
import type { JobsClient } from "../../infrastructure/ray/jobs-client.js";

// Writer locks and staging temporaries are coordinator-local state; they must
// never travel with results or they would poison the next store.open/report.
function travelsWithResults(relative: string): boolean {
  return relative.split("/").every(segment => segment && !segment.startsWith("."));
}

/** Download and verify a complete snapshot into a fresh staging directory. */
export async function downloadRunResults(
  client: JobsClient,
  jobId: string,
  outputRoot: string,
  log: (text: string) => void,
  signal?: AbortSignal,
): Promise<string> {
  const manifest = expectRecord(await client.call(`/jobs/${jobId}/manifest`, undefined, signal), "result manifest");
  const runId = expectNonEmptyString(manifest.runId, "runId");
  if (!/^[0-9a-f-]{36}$/u.test(runId) || !Array.isArray(manifest.files)) throw new Error("Invalid result manifest");
  const missing = Array.isArray(manifest.missing) ? manifest.missing : [];
  const root = resolve(outputRoot);
  await mkdir(root, { recursive: true });
  const destination = join(root, runId);
  const staging = join(root, `.download-${randomUUID()}`);
  await mkdir(staging);
  try {
    const seen = new Set<string>();
    for (const item of manifest.files) {
      const entry = expectRecord(item, "result file");
      const relative = evidencePath(expectNonEmptyString(entry.path, "file path"));
      if (seen.has(relative.toLowerCase())) throw new Error("Duplicate result file");
      seen.add(relative.toLowerCase());
      if (!travelsWithResults(relative)) continue;
      if (
        typeof entry.size !== "number" ||
        !Number.isSafeInteger(entry.size) ||
        entry.size < 0 ||
        typeof entry.sha256 !== "string" ||
        !/^[0-9a-f]{64}$/u.test(entry.sha256)
      )
        throw new Error("Invalid file digest");
      const target = join(staging, relative);
      await mkdir(dirname(target), { recursive: true });
      // Create the file even for zero-size evidence; chunks are appended below.
      await writeFile(target, new Uint8Array());
      const hash = createHash("sha256");
      let offset = 0;
      let size = 0;
      while (offset < entry.size) {
        const part = expectRecord(
          await client.call(
            `/jobs/${jobId}/file?path=${encodeURIComponent(relative)}&offset=${offset}`,
            undefined,
            signal,
          ),
          "file chunk",
        );
        const data = Buffer.from(expectNonEmptyString(part.data, "chunk data"), "base64");
        if (!data.length || data.length > entry.size - offset) throw new Error("Invalid chunk length");
        await writeFile(target, data, { flag: "a" });
        hash.update(data);
        offset += data.length;
        size += data.length;
      }
      if (size !== entry.size || hash.digest("hex") !== entry.sha256)
        throw new Error(`Result digest mismatch: ${relative}`);
    }
    await rename(staging, destination);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  if (missing.length) log(`Warning: ${missing.length} cluster result files are missing (partial evidence from unfinished tasks); downloaded the available results.`);
  return destination;
}
