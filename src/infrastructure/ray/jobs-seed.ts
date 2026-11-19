import { mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { checkedPath, evidencePath, inspectFile } from "../../core/artifacts/artifacts.js";
import type { FileEntry } from "../../core/contracts/result.js";
import { expectRecord, expectNonEmptyString } from "../../core/validation/input.js";
import { workflowDigest } from "../../core/workflow/values.js";

export const JOBS_SEED_CHUNK_BYTES = 512 * 1024;
export const travelsWithRun = (path: string): boolean => !["retry-control.json", "workflow-deployment.json", "workflow-reporting.json"].includes(path) && path.split("/").every(part => part && !part.startsWith("."));
type Seed = { runId: string; files: FileEntry[]; digest: string };

function parseSeed(input: Record<string, unknown>): Seed {
  const runId = expectNonEmptyString(input.runId, "seed run ID");
  if (!/^[0-9a-f-]{36}$/.test(runId) || !Array.isArray(input.files) || input.files.length > 100_000) throw new TypeError("Invalid resume inventory");
  const paths = new Set<string>();
  let size = 0;
  const files = input.files.map(raw => {
    const value = expectRecord(raw, "seed file");
    const path = evidencePath(expectNonEmptyString(value.path, "seed file path"));
    if (!travelsWithRun(path) || paths.has(path.toLowerCase()) || typeof value.size !== "number" ||
        !Number.isSafeInteger(value.size) || value.size < 0 || value.size > 256 * 1024 * 1024 ||
        typeof value.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.sha256)) throw new TypeError("Invalid seed file entry");
    paths.add(path.toLowerCase()); size += value.size;
    return { path, size: value.size, sha256: value.sha256 };
  });
  if (size > 64 * 1024 ** 3) throw new TypeError("Resume inventory exceeds 64 GiB");
  for (const path of paths) {
    const parts = path.split("/"); parts.pop();
    while (parts.length) { if (paths.has(parts.join("/"))) throw new TypeError("Seed path is both file and directory"); parts.pop(); }
  }
  return { runId, files, digest: workflowDigest({ runId, files }) };
}

/** Serialized, restartable uploads. Commit verifies every byte before a coordinator may use the seed. */
export class JobsSeedUploads {
  private readonly pending = new Map<string, Promise<unknown>>();
  constructor(readonly root: string) {}

  handle(id: string, value: unknown): Promise<unknown> {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new TypeError("Invalid seed job ID");
    const previous = this.pending.get(id) ?? Promise.resolve();
    const work = previous.catch(() => {}).then(() => this.perform(id, expectRecord(value, "seed operation")));
    this.pending.set(id, work);
    void work.finally(() => { if (this.pending.get(id) === work) this.pending.delete(id); }).catch(() => {});
    return work;
  }

  async ready(id: string, runId: string, digest: string): Promise<void> {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new TypeError("Invalid seed job ID");
    const receipt = expectRecord(JSON.parse(await readFile(await checkedPath(this.root, `${id}/ready.json`), "utf8")), "seed receipt");
    if (receipt.runId !== runId || receipt.digest !== digest) throw new TypeError("Resume seed identity mismatch");
  }

  async materialize(id: string, runId: string, digest: string, destination: string): Promise<void> {
    const source = await this.source(id, runId, digest);
    await mkdir(dirname(destination), { recursive: true });
    await rename(source, destination);
  }

  async source(id: string, runId: string, digest: string): Promise<string> {
    await this.ready(id, runId, digest);
    return checkedPath(this.root, `${id}/files`);
  }

  private async perform(id: string, input: Record<string, unknown>): Promise<unknown> {
    const directory = join(this.root, id), metadata = join(directory, "manifest.json");
    if (input.op === "start") {
      const seed = parseSeed(input);
      await mkdir(join(directory, "files"), { recursive: true });
      await checkedPath(this.root, `${id}/files`);
      try { await writeFile(metadata, JSON.stringify(seed), { flag: "wx", mode: 0o600 }); }
      catch (error) {
        if (!error || typeof error !== "object" || !("code" in error) || error.code !== "EEXIST") throw error;
        const previous = expectRecord(JSON.parse(await readFile(metadata, "utf8")), "seed inventory");
        if (previous.digest !== seed.digest) throw new TypeError("Seed job ID reused with different files");
      }
      try {
        await this.ready(id, seed.runId, seed.digest);
        return { digest: seed.digest, committed: true };
      } catch (error) { if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") throw error; }
      return { digest: seed.digest };
    }
    const seed = parseSeed(expectRecord(JSON.parse(await readFile(await checkedPath(this.root, `${id}/manifest.json`), "utf8")), "seed inventory"));
    if (input.op === "chunk") {
      try { await open(join(directory, "ready.json"), "r").then(handle => handle.close()); throw new TypeError("Committed seed is immutable"); }
      catch (error) { if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") throw error; }
      const entry = seed.files.find(file => file.path === input.path);
      if (!entry || typeof input.offset !== "number" || !Number.isSafeInteger(input.offset) || input.offset < 0 ||
          typeof input.data !== "string" || input.data.length > Math.ceil(JOBS_SEED_CHUNK_BYTES / 3) * 4 ||
          !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.data)) throw new TypeError("Invalid seed chunk");
      const bytes = Buffer.from(input.data, "base64");
      if (input.offset + bytes.length > entry.size || !bytes.length && entry.size !== 0) throw new TypeError("Invalid seed chunk size");
      const target = join(directory, "files", entry.path);
      await mkdir(dirname(target), { recursive: true });
      // Directories are owned by this upload; reject links before opening a file for writing.
      const parent = dirname(`${id}/files/${entry.path}`).replaceAll("\\", "/");
      await checkedPath(this.root, parent);
      try { await writeFile(target, "", { flag: "wx", mode: 0o600 }); }
      catch (error) { if (!error || typeof error !== "object" || !("code" in error) || error.code !== "EEXIST") throw error; }
      const handle = await open(await checkedPath(this.root, `${id}/files/${entry.path}`), "r+");
      try {
        const state = await handle.stat();
        if (!state.isFile() || input.offset > state.size) throw new TypeError("Seed chunks must be contiguous");
        if (input.offset < state.size) {
          if (input.offset + bytes.length > state.size) throw new TypeError("Overlapping seed chunk");
          const existing = Buffer.alloc(bytes.length);
          const read = await handle.read(existing, 0, existing.length, input.offset);
          if (read.bytesRead !== bytes.length || !existing.equals(bytes)) throw new TypeError("Seed chunk replay changed content");
        } else {
          let written = 0;
          while (written < bytes.length) {
            const result = await handle.write(bytes, written, bytes.length - written, input.offset + written);
            if (!result.bytesWritten) throw new Error("Seed file write made no progress");
            written += result.bytesWritten;
          }
        }
      } finally { await handle.close(); }
      return { accepted: true };
    }
    if (input.op === "commit") {
      for (const entry of seed.files) {
        const actual = await inspectFile(join(directory, "files"), entry.path);
        if (actual.size !== entry.size || actual.sha256 !== entry.sha256) throw new TypeError(`Seed file digest mismatch: ${entry.path}`);
      }
      await writeFile(join(directory, "ready.json"), JSON.stringify({ runId: seed.runId, digest: seed.digest }), { mode: 0o600 });
      return { digest: seed.digest };
    }
    throw new TypeError("Unknown seed operation");
  }
}
