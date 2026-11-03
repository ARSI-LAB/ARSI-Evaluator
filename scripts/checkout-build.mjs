import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { sourceFingerprint } from "./source-fingerprint.mjs";

// The lock lives outside dist: a build removes and replaces that directory.
// A killed owner leaves evidence for manual recovery; never steal a lock from
// a possibly active installer/compiler based only on elapsed time.
export async function ensureCheckoutBuild(root, rebuild, { timeoutMs = 300_000 } = {}) {
  const lock = join(root, ".evaluator-build.lock");
  const deadline = performance.now() + timeoutMs;
  while (true) {
    try {
      await mkdir(lock);
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (performance.now() >= deadline) {
        throw new Error(`Timed out waiting for checkout build lock ${lock}; inspect owner.json and active build processes before removing an abandoned lock`);
      }
      await setTimeout(Math.min(100, Math.max(1, deadline - performance.now())));
    }
  }
  try {
    await writeFile(join(lock, "owner.json"), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }) + "\n");
    let savedDigest;
    try {
      savedDigest = JSON.parse(await readFile(join(root, "dist/source-provenance.json"), "utf8")).digest;
    } catch (error) {
      if (!(error instanceof SyntaxError || error.code === "ENOENT")) throw error;
    }
    // Recheck after ownership is acquired: a preceding launcher may have built.
    if (savedDigest !== await sourceFingerprint(root)) await rebuild();
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}
