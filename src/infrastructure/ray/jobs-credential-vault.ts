import { expectRecord, expectNonEmptyString } from "../../core/validation/input.js";

/** Process-owned credentials. Persisted job metadata contains names only. */
export class JobsCredentialVault {
  private readonly entries = new Map<string, { values: Map<string, string>; touched: number }>();

  put(jobId: string, scope: string, input: unknown): string[] {
    const values = new Map<string, string>();
    let bytes = 0;
    for (const [name, raw] of Object.entries(expectRecord(input, "job credentials"))) {
      expectNonEmptyString(name, "credential name");
      const value = expectNonEmptyString(raw, "credential value");
      bytes += Buffer.byteLength(name) + Buffer.byteLength(value);
      if (bytes > 1024 * 1024 || values.size >= 256) throw new TypeError("Job credential limit exceeded");
      values.set(name, value);
    }
    this.prune();
    const key = `${jobId}/${scope}`;
    if (!this.entries.has(key) && this.entries.size >= 256) throw new Error("Too many jobs holding credentials");
    this.entries.set(key, { values, touched: Date.now() });
    return [...values.keys()].sort();
  }

  read(jobId: string, scope: string, name?: string): { names: string[] } | { value: string } {
    const entry = this.entries.get(`${jobId}/${scope}`);
    if (!entry) throw new Error("Job credentials unavailable; submit credentials again after gateway restart");
    entry.touched = Date.now();
    if (name === undefined) return { names: [...entry.values.keys()].sort() };
    const value = entry.values.get(name);
    if (value === undefined) throw new Error("Credential was not provided for this job");
    return { value };
  }

  remove(jobId: string, scope: string): void { this.entries.delete(`${jobId}/${scope}`); }
  keepAlive(jobId: string, scope: string): void {
    const entry = this.entries.get(`${jobId}/${scope}`);
    if (entry) entry.touched = Date.now();
  }
  prune(): void {
    for (const [key, entry] of this.entries) if (Date.now() - entry.touched > 86_400_000) this.entries.delete(key);
  }
}
