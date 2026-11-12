import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { expectRecord } from "../../../../core/validation/input.js";

type CachedCapture = { metrics: Record<string, Record<string, unknown>>; replay: Record<string, unknown> };

/** The scope identifies the complete candidate tree, reference, device and capture protocol. */
export class MsProfCache {
  private constructor(private readonly directory: string, private readonly scope: string,
    private readonly log?: (line: string) => void, private readonly maxEntries?: number) {}

  private get entry(): string {
    return join(this.directory, createHash("sha256").update(this.scope).digest("hex"));
  }

  static async open(scope: string | undefined, cacheDir?: string, log?: (line: string) => void, maxEntries?: number): Promise<MsProfCache | null> {
    if (maxEntries !== undefined && (!Number.isSafeInteger(maxEntries) || maxEntries <= 0))
      throw new TypeError("cacheMaxEntries must be a positive integer");
    if (!scope || process.env.KA_MSPROF_CACHE_DISABLED === "1") return null;
    const directory = cacheDir || process.env.KA_MSPROF_CACHE_DIR || join(homedir(), ".kernel_agent", "msprof_cache");
    await mkdir(directory, { recursive: true });
    return new MsProfCache(directory, scope, log, maxEntries);
  }

  async restore(profileDir: string): Promise<CachedCapture | null> {
    try {
      const data = expectRecord(JSON.parse(await readFile(join(this.entry, "capture.json"), "utf8")), "cached capture");
      if (data.scope !== this.scope) throw new TypeError("Profile cache receipt mismatch");
      const metrics = Object.fromEntries(Object.entries(expectRecord(data.metrics, "cached metrics"))
        .map(([block, values]) => [block, expectRecord(values, "cached block metrics")]));
      const replay = expectRecord(data.replay, "cached replay");
      await cp(join(this.entry, "profile"), profileDir, { recursive: true });
      return { metrics, replay };
    } catch (error) {
      if (error instanceof TypeError || error instanceof SyntaxError) await rm(this.entry, { recursive: true, force: true });
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.log?.(`MSProfCache miss: ${String(error)}`);
      await rm(profileDir, { recursive: true, force: true });
      return null;
    }
  }

  async put(profileDir: string, capture: CachedCapture): Promise<void> {
    const temporary = await mkdtemp(join(this.directory, ".capture-"));
    try {
      await cp(profileDir, join(temporary, "profile"), { recursive: true });
      await writeFile(join(temporary, "capture.json"), JSON.stringify({ scope: this.scope, ...capture }));
      // Publish the receipt and native artifacts together. A concurrent writer may have already published this scope.
      try { await rename(temporary, this.entry); }
      catch (error) {
        if (!["EEXIST", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      }
      await this.prune();
    } catch (error) {
      this.log?.(`MSProfCache store failed: ${String(error)}`);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }

  private async prune(): Promise<void> {
    if (this.maxEntries === undefined) return;
    const names = (await readdir(this.directory, { withFileTypes: true }))
      .filter(entry => entry.isDirectory() && /^[a-f0-9]{64}$/.test(entry.name));
    if (names.length <= this.maxEntries) return;
    const entries = await Promise.all(names.map(async ({ name }) => {
      const path = join(this.directory, name);
      return { path, mtime: (await stat(path)).mtimeMs };
    }));
    entries.sort((a, b) => b.mtime - a.mtime);
    for (const stale of entries.slice(this.maxEntries)) await rm(stale.path, { recursive: true, force: true });
  }
}
