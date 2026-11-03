import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createDeepsweSource } from "../dist/plugins/benchmarks/deepswe/source.js";

if (process.argv.length !== 4) {
  console.error("Usage: node scripts/register-deepswe-cache.mjs RUN_MANIFEST CACHE_DIRECTORY");
  process.exit(2);
}
const manifest = JSON.parse(await readFile(resolve(process.argv[2]), "utf8"));
const source = manifest.source;
if (source?.source !== "deepswe" || typeof source.metadata?.version !== "string" ||
    typeof source.revision !== "string" || !/^[a-f0-9]{64}$/u.test(source.revision) || !Array.isArray(source.files)) {
  throw new Error("Manifest must contain a locked DeepSWE source");
}
const cacheDir = resolve(process.argv[3]);
const bytes = await readFile(join(cacheDir, "objects", source.revision));
if (createHash("sha256").update(bytes).digest("hex") !== source.revision)
  throw new Error("Existing tree cache checksum mismatch; no index registered");
const benchmark = createDeepsweSource({ version: source.metadata.version, cacheDir });
const locked = await benchmark.resolveSource(source, AbortSignal.timeout(30_000));
console.log(JSON.stringify({ registered: true, source: locked.source, revision: locked.revision }));
