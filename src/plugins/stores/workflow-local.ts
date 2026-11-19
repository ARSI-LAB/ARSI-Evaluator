import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile, lstat, realpath, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { WorkflowArtifacts, WorkflowRunRecord, WorkflowStore } from "../../core/contracts/workflow.js";
import { workflowDigest, workflowObject } from "../../core/workflow/values.js";
import { parseWorkflowRun, validateRecordConsistency } from "../../core/workflow/record.js";
import { checkedPath, evidencePath, inspectFile } from "../../core/artifacts/artifacts.js";
import { fileRetry } from "../../infrastructure/filesystem/atomic-json.js";

function localPath(root: string, path: string): string {
  evidencePath(path);
  if (isAbsolute(path) || path.split(/[\\/]/).some(part => part === ".." || part === "." || !part)) throw new TypeError("Unsafe workflow artifact path");
  const target = resolve(root, path);
  if (!target.startsWith(`${resolve(root)}${sep}`)) throw new TypeError("Artifact escapes its run directory");
  return target;
}

/** File-backed persistence with immutable artifact names and atomic run snapshots. */
export class LocalWorkflowStore implements WorkflowStore {
  readonly directory: string;
  private writes = Promise.resolve();

  constructor(directory: string) { this.directory = resolve(directory); }

  save(record: WorkflowRunRecord): Promise<void> {
    const content = JSON.stringify(record, null, 2) + "\n";
    this.writes = this.writes.then(async () => {
      await mkdir(this.directory, { recursive: true });
      const temporary = join(this.directory, `.run-${randomUUID()}.tmp`);
      try {
        await writeFile(temporary, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
        await fileRetry(() => rename(temporary, join(this.directory, "run.json")));
      } finally { await fileRetry(() => rm(temporary, { force: true })); }
    });
    return this.writes;
  }

  artifacts(producer: string): WorkflowArtifacts {
    const root = this.directory;
    return {
      async write(name, content, options) {
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) throw new TypeError("Artifact name must be a filename without directories");
        const bytes = typeof content === "string" ? Buffer.from(content, "utf8") : content;
        const sha256 = createHash("sha256").update(bytes).digest("hex");
        const id = randomUUID();
        const path = `artifacts/${workflowDigest(producer).slice(0, 24)}/${id}-${name}`;
        const target = localPath(root, path);
        await mkdir(dirname(target), { recursive: true });
        await checkedPath(root, relative(root, dirname(target)));
        await writeFile(target, bytes, { flag: "wx" });
        return { id, path, sha256, size: bytes.byteLength, mediaType: options.mediaType, protocol: options.protocol,
          visibility: options.visibility ?? "public", producer, complete: options.complete ?? true };
      },
      async read(artifact) {
        const target = localPath(root, artifact.path);
        const [canonicalRoot, canonicalTarget, stat] = await Promise.all([realpath(root), realpath(target), lstat(target)]);
        const inside = relative(canonicalRoot, canonicalTarget);
        if (stat.isSymbolicLink() || inside.startsWith(`..${sep}`) || isAbsolute(inside)) throw new TypeError("Artifact resolves outside its run directory");
        const content = await readFile(target);
        if (content.length !== artifact.size || createHash("sha256").update(content).digest("hex") !== artifact.sha256)
          throw new Error(`Artifact integrity check failed: ${artifact.path}`);
        return content;
      },
    };
  }

  async read(): Promise<WorkflowRunRecord> {
    const record = workflowObject(JSON.parse(await readFile(join(this.directory, "run.json"), "utf8")), "run record");
    if (record.schemaVersion !== 2 || typeof record.runId !== "string" || typeof record.fingerprint !== "string" ||
        !Array.isArray(record.units) || !Array.isArray(record.steps) || !Array.isArray(record.resources) || !Array.isArray(record.artifacts))
      throw new TypeError("Invalid workflow run record; legacy result formats require their original evaluator version");
    // Validate full persisted records at the storage boundary before constructing the typed result.
    const parsed = parseWorkflowRun(record);
    validateRecordConsistency(parsed);
    for (const artifact of parsed.artifacts) {
      const actual = await inspectFile(this.directory, artifact.path);
      if (actual.sha256 !== artifact.sha256 || actual.size !== artifact.size) throw new TypeError(`Workflow evidence changed: ${artifact.path}`);
    }
    return parsed;
  }
}
