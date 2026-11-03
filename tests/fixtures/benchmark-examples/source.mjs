import { readFile } from "node:fs/promises";
import { fingerprintConfig } from "ember-evaluator";

// This tiny file source belongs to the example; real adapters may fetch/cache elsewhere.
export function questionSource(path) {
  async function snapshot(signal) {
    signal.throwIfAborted();
    const rows = JSON.parse(await readFile(path, { encoding: "utf8", signal }));
    if (!Array.isArray(rows) || rows.length !== 2 || rows.some(row =>
      !row || typeof row.question !== "string" || typeof row.answer !== "string"))
      throw new TypeError("Example source requires two question/answer records");
    return { rows, lock: { source: "example-questions", revision: fingerprintConfig(rows), files: [], metadata: { count: rows.length } } };
  }
  return {
    async resolve(previous, signal) {
      const { lock } = await snapshot(signal);
      if (previous && fingerprintConfig(previous) !== fingerprintConfig(lock)) throw new Error("Example source changed");
      return lock;
    },
    async *rows(lock, selection, signal) {
      const current = await snapshot(signal);
      if (selection !== "test" || fingerprintConfig(lock) !== fingerprintConfig(current.lock)) throw new Error("Example source or partition changed");
      for (const row of current.rows) { signal.throwIfAborted(); yield row; }
    },
  };
}

export function sourceConfig(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).some(key => key !== "path") || typeof value.path !== "string" || !value.path.trim())
    throw new TypeError("Example config requires only a nonempty path");
  return { path: value.path };
}
