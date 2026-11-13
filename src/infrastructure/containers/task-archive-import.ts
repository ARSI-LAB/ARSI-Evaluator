import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { create, extract, list } from "tar";
import type { ContainerPlatform } from "../../core/contracts/environment.js";
import { expectRecord } from "../../core/validation/input.js";

const metadataLimit = 16 * 1024 * 1024;

function archivePath(value: unknown): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_.\/-]+$/u.test(value) ||
    value.split("/").some(part => !part || part === "." || part === "..")) throw new Error("Invalid Docker archive path");
  return value;
}

/** Replace archive names before Docker sees them. Layer bytes and image configuration remain intact. */
export async function prepareTaskArchiveImport(source: string, workspace: string, reference: string, platform: ContainerPlatform, signal: AbortSignal) {
  const directory = join(workspace, "contents");
  await mkdir(directory);
  const files = new Set<string>();
  let invalid: unknown;
  await pipeline(createReadStream(source), list({ strict: true, onReadEntry(entry) {
    try {
      signal.throwIfAborted();
      if (entry.type !== "Directory" && entry.type !== "File") throw new Error("Unsupported Docker archive entry type");
      const name = entry.path.replace(/^\.\//u, "").replace(/\/$/u, "");
      if (entry.type === "File") {
        const path = archivePath(name);
        if (files.has(path) || files.size >= 100_000) throw new Error("Invalid Docker archive file list");
        files.add(path);
      } else if (name && name !== ".") archivePath(name);
    } catch (error) { invalid ??= error; }
    entry.resume();
  } }), { signal });
  if (invalid) throw invalid;
  signal.throwIfAborted();
  await pipeline(createReadStream(source), extract({ cwd: directory, strict: true, preservePaths: false,
    filter: (path, entry) => "type" in entry && entry.type === "File" && files.has(path.replace(/^\.\//u, "")) }), { signal });
  const bytes = async (path: string) => {
    signal.throwIfAborted();
    if (!files.has(path) || (await stat(join(directory, path))).size > metadataLimit) throw new Error("Invalid Docker archive metadata");
    return readFile(join(directory, path));
  };
  const json = async (path: string): Promise<unknown> => JSON.parse((await bytes(path)).toString("utf8"));
  const manifest = await json("manifest.json");
  if (!Array.isArray(manifest) || !manifest.length) throw new Error("Docker archive has no image manifest");
  let selected: { config: string; layers: string[]; configId: string } | undefined;
  for (const value of manifest) {
    const row = expectRecord(value, "Docker archive image");
    const config = archivePath(row.Config);
    const configBytes = await bytes(config);
    const identity = expectRecord(JSON.parse(configBytes.toString("utf8")), "Docker archive image config");
    if (`${identity.os}/${identity.architecture}` !== platform) continue;
    const entries = row.Layers === null ? [] : row.Layers;
    if (!Array.isArray(entries)) throw new Error("Docker archive has no layer list");
    const layers = entries.map(archivePath);
    if (layers.some(path => !files.has(path))) throw new Error("Docker archive layer is missing");
    const configId = `sha256:${createHash("sha256").update(configBytes).digest("hex")}`;
    if (selected && (selected.configId !== configId || JSON.stringify(selected.layers) !== JSON.stringify(layers)))
      throw new Error("Docker archive has multiple images for the selected platform");
    selected = { config, layers, configId };
  }
  if (!selected) throw new Error(`Docker archive has no image for ${platform}`);
  const selectedConfigId = selected.configId;
  await writeFile(join(directory, "manifest.json"), JSON.stringify([{ Config: selected.config, RepoTags: [reference], Layers: selected.layers }]));
  const members = new Set(["manifest.json", selected.config, ...selected.layers]);
  // Preserve the selected OCI manifest when a modern Docker save supplies it.
  // OCI ref annotations can otherwise restore the publisher's original tags.
  let manifestId: string | undefined;
  if (files.has("index.json") && files.has("oci-layout")) {
    const blob = (digest: unknown) => {
      if (typeof digest !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(digest)) throw new Error("Invalid OCI descriptor digest");
      return `blobs/sha256/${digest.slice(7)}`;
    };
    const seen = new Set<string>();
    const find = async (value: unknown): Promise<Record<string, unknown> | undefined> => {
      if (!Array.isArray(value)) return undefined;
      for (const item of value) {
        const descriptor = expectRecord(item, "OCI descriptor");
        const path = blob(descriptor.digest);
        if (seen.has(path)) continue;
        seen.add(path);
        if (!files.has(path)) continue;
        const content = await bytes(path);
        if (`sha256:${createHash("sha256").update(content).digest("hex")}` !== descriptor.digest)
          throw new Error("OCI descriptor digest mismatch");
        const image = expectRecord(JSON.parse(content.toString("utf8")), "OCI image");
        if (image.config && expectRecord(image.config, "OCI image config").digest === selectedConfigId) {
          const layers = image.layers === null ? [] : image.layers;
          if (!Array.isArray(layers)) throw new Error("OCI image has no layers");
          const paths = [path, blob(selectedConfigId), ...layers.map(layer => blob(expectRecord(layer, "OCI layer").digest))];
          if (paths.some(member => !files.has(member))) throw new Error("OCI image member is missing");
          paths.forEach(member => members.add(member));
          manifestId = String(descriptor.digest);
          return { mediaType: descriptor.mediaType, digest: descriptor.digest, size: content.length,
            annotations: { "io.containerd.image.name": `docker.io/${reference}`, "org.opencontainers.image.ref.name": `docker.io/${reference}` } };
        }
        const nested = await find(image.manifests);
        if (nested) return nested;
      }
      return undefined;
    };
    const index = expectRecord(await json("index.json"), "OCI index");
    const descriptor = await find(index.manifests);
    if (descriptor) {
      await writeFile(join(directory, "index.json"), JSON.stringify({ schemaVersion: 2, manifests: [descriptor] }));
      members.add("index.json");
      members.add("oci-layout");
    }
  }
  signal.throwIfAborted();
  const archive = join(workspace, "import.tar");
  await pipeline(create({ cwd: directory, portable: true, noDirRecurse: true }, [...members]), createWriteStream(archive), { signal });
  return { archive, configId: selected.configId, manifestId };
}
