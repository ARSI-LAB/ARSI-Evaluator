import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AttemptKey, AttemptRecord } from "../../../core/contracts/result.js";
import type { RunStore } from "../../../core/contracts/run-store.js";
import type { WorkflowArtifacts, WorkflowArtifact } from "../../../core/contracts/workflow.js";
import { artifactReference } from "../../../core/workflow/record.js";
import { workflowObject } from "../../../core/workflow/values.js";
import { validateUploadManifest } from "../../../infrastructure/transfer/protocol.js";

/** Import only evidence from the dispatched attempt after the workflow transport verified its bytes. */
export async function importBenchmarkEvidence(key: AttemptKey, references: readonly WorkflowArtifact[], artifacts: WorkflowArtifacts,
  store: RunStore, directory: string, completed?: (record: AttemptRecord) => void): Promise<void> {
  if (!store.importAttempt) throw new TypeError("Benchmark Ray execution requires a store with artifact import");
  for (const reference of references.filter(value => value.protocol === "arsi.benchmark-evidence/v1")) {
    if (reference.visibility !== "private") throw new TypeError("Benchmark evidence must remain private");
    const evidence = workflowObject(JSON.parse(new TextDecoder().decode(await artifacts.read(reference))));
    if (!Array.isArray(evidence.files)) throw new TypeError("Benchmark evidence has no file inventory");
    const entries = evidence.files.map(value => workflowObject(value));
    const manifest = validateUploadManifest({ schemaVersion: 1, key, transferId: key.attemptId,
      result: evidence.record, files: entries.map(entry => entry.file), missing: evidence.missing });
    await mkdir(directory, { recursive: true });
    const staging = await mkdtemp(join(directory, "benchmark-import-"));
    try {
      for (const [index, file] of manifest.files.entries()) {
        const artifact = artifactReference(entries[index]?.artifact);
        if (artifact.protocol !== "arsi.benchmark-file/v1" || artifact.visibility !== "private" ||
            artifact.sha256 !== file.sha256 || artifact.size !== file.size) throw new TypeError("Benchmark file differs from its artifact receipt");
        const target = join(staging, file.path);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, await artifacts.read(artifact), { flag: "wx" });
      }
      if (!await store.importAttempt(manifest.result, { files: manifest.files, missing: manifest.missing }, staging))
        throw new Error("Benchmark store rejected remote attempt evidence");
      completed?.(manifest.result);
    } finally { await rm(staging, { recursive: true, force: true }); }
  }
}
