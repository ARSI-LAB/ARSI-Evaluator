import type { RetryAdmission } from "../contracts/retry-control.js";

/** Reservations keep the queue alive until the application's retry receipt is durable. */
export class WorkflowUnitQueue<T extends { key: string }> {
  private readonly originals: Map<string, T>;
  private readonly pending: { value: T; retry: boolean }[];
  private readonly active = new Set<string>();
  private readonly reserved = new Set<string>();
  private changed = Promise.withResolvers<void>();
  private closed = false;
  private readonly source: AsyncIterator<string> | undefined;
  private readonly admitted = new Set<string>();
  private pulling: Promise<void> | undefined;
  private sourceDone: boolean;
  private sourceError: unknown;

  constructor(values: readonly T[], source?: AsyncIterable<string>) {
    this.originals = new Map(values.map(value => [value.key, value]));
    this.source = source?.[Symbol.asyncIterator]();
    this.sourceDone = !this.source;
    this.pending = this.source ? [] : values.map(value => ({ value, retry: false }));
  }
  private wake() { this.changed.resolve(); this.changed = Promise.withResolvers<void>(); }

  reserve(key: string): RetryAdmission | undefined {
    const value = this.originals.get(key);
    if (this.closed || !value || this.source && !this.admitted.has(key) || this.active.has(key) || this.reserved.has(key) || this.pending.some(item => item.value.key === key)) return;
    this.reserved.add(key);
    let released = false;
    const release = () => { if (!released) { released = true; this.reserved.delete(key); this.wake(); } };
    return { release, commit: () => {
      if (released) return;
      if (!this.closed) this.pending.push({ value, retry: true });
      release();
    } };
  }
  complete(key: string) { this.active.delete(key); this.wake(); }
  close() { this.closed = true; this.wake(); }

  async dispose(): Promise<void> {
    this.close();
    await this.pulling;
    await this.source?.return?.();
  }

  private pull() {
    if (this.pulling || this.sourceDone || !this.source) return;
    const source = this.source;
    this.pulling = (async () => {
      const item = await source.next();
      if (this.closed) return;
      if (item.done) {
        this.sourceDone = true;
        if (this.admitted.size !== this.originals.size) throw new TypeError("Readiness admission omitted execution units");
      } else {
        const value = this.originals.get(item.value);
        if (!value || this.admitted.has(item.value)) throw new TypeError("Readiness admission returned an unknown or duplicate execution unit");
        this.admitted.add(item.value);
        this.pending.push({ value, retry: false });
      }
    })().catch(error => { this.sourceError = error; this.sourceDone = true; })
      .finally(() => { this.pulling = undefined; this.wake(); });
  }

  async take(signal: AbortSignal): Promise<{ value: T; retry: boolean } | undefined> {
    const abort = () => this.wake();
    signal.addEventListener("abort", abort, { once: true });
    try {
      while (!this.closed && !signal.aborted) {
        if (this.sourceError !== undefined) throw this.sourceError;
        const change = this.changed.promise, item = this.pending.shift();
        if (item) { this.active.add(item.value.key); return item; }
        if (this.sourceDone && !this.active.size && !this.reserved.size) { this.close(); return; }
        this.pull();
        await change;
      }
    } finally { signal.removeEventListener("abort", abort); }
  }
}
