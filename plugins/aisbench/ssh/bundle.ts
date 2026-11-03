import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import resources from "../resources.json" with { type: "json" };

// Replaced at build time. The entry fingerprint therefore covers every owned resource.
declare const __AISBENCH_RESOURCE_HASHES__: Record<string, string>;
const built = typeof __AISBENCH_RESOURCE_HASHES__ !== "undefined";
const root = built ? new URL("./", import.meta.url) : new URL("../", import.meta.url);
const normalized = async (name: string): Promise<string> =>
  (await readFile(new URL(name, root), "utf8")).replace(/\r\n/gu, "\n");

export const upstreamRevision = resources.upstreamRevision;
export const profileDirectory = new URL("profiles/", root);

export async function verifyResources(): Promise<void> {
  if (!built) return;
  for (const [name, expected] of Object.entries(__AISBENCH_RESOURCE_HASHES__)) {
    let actual: string;
    try { actual = createHash("sha256").update(await normalized(name)).digest("hex"); }
    catch (cause) { throw new Error(`AISBench resource missing: ${name}; rebuild/reinstall the plugin`, { cause }); }
    if (actual !== expected) throw new Error(`AISBench resource changed: ${name}; rebuild/reinstall the plugin`);
  }
}

export async function bundleFiles(): Promise<Record<string, string>> {
  await verifyResources();
  const files: Record<string, string> = {};
  for (const name of resources.runtime) files[name] = await normalized(`runtime/${name}`);
  return files;
}

export async function bundleDigest(): Promise<string> {
  return createHash("sha256").update(JSON.stringify(await bundleFiles())).digest("hex");
}
