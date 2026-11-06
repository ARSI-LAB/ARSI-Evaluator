import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

// External plugins declare themselves in plugins/<name>/ember-plugin.json. Only plugins with such a
// manifest are compiled, installed into dist/plugins and exposed as CLI commands; everything else in
// plugins/ stays source-only and cannot be reached through the packaged runtime.
const root = fileURLToPath(new URL("..", import.meta.url));
const pluginsDir = join(root, "plugins");
const distRoot = join(root, "dist");
const typescript = join(root, "node_modules", "typescript", "bin", "tsc");
// Manifests may omit version; the package version keeps run provenance populated without duplicates.
const packageVersion = JSON.parse(await readFile(join(root, "package.json"), "utf8")).version ?? "0.0.0";

function fail(file, message) {
  throw new Error(`${relative(root, file)}: ${message}`);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "";
}

async function loadManifests() {
  if (!existsSync(pluginsDir)) return [];
  const names = (await readdir(pluginsDir, { withFileTypes: true }))
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort();
  const manifests = [];
  for (const name of names) {
    const file = join(pluginsDir, name, "ember-plugin.json");
    if (!existsSync(file)) continue;
    let manifest;
    try {
      manifest = JSON.parse(await readFile(file, "utf8"));
    } catch (error) {
      fail(file, `invalid JSON: ${error.message}`);
    }
    if (!nonEmptyString(manifest.id)) fail(file, "id must be a non-empty string");
    if (manifest.id !== name) fail(file, `id "${manifest.id}" must match the directory name`);
    if (manifest.version !== undefined && !nonEmptyString(manifest.version)) {
      fail(file, "version must be a non-empty string when present");
    }
    if (manifest.command !== undefined) {
      if (!nonEmptyString(manifest.command?.name)) fail(file, "command.name must be a non-empty string");
      if (!nonEmptyString(manifest.command?.cli)) fail(file, "command.cli must point at the compiled CLI entry");
    }
    if (manifest.build !== undefined) {
      if (!nonEmptyString(manifest.build?.tsconfig)) fail(file, "build.tsconfig must point at a tsconfig file");
      if (!Array.isArray(manifest.build.install) || manifest.build.install.length === 0) {
        fail(file, "build.install must list the files to compile or copy into the runtime");
      }
      for (const entry of manifest.build.install) {
        if (!nonEmptyString(entry)) fail(file, "build.install contains an empty path");
      }
    }
    manifests.push({ name, dir: join(pluginsDir, name), file, manifest });
  }
  return manifests;
}

async function buildPlugin({ name, dir, file, manifest }) {
  if (manifest.build === undefined) return;
  const tsconfig = join(dir, manifest.build.tsconfig);
  if (!existsSync(tsconfig)) fail(file, `missing tsconfig: ${relative(root, tsconfig)}`);
  await rm(join(dir, "dist"), { recursive: true, force: true });
  const compiled = spawnSync(process.execPath, [typescript, "-p", tsconfig], { cwd: root, stdio: "inherit" });
  if (compiled.status !== 0) fail(file, `TypeScript build failed for ${name}`);
  const target = join(distRoot, "plugins", name);
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });
  for (const entry of manifest.build.install) {
    const source = join(dir, entry);
    if (!existsSync(source)) fail(file, `install path does not exist: ${relative(root, source)}`);
    // The compiled output is flattened into dist/plugins/<id>/; static assets keep their relative path.
    if (entry === "dist") {
      for (const child of await readdir(source)) {
        await cp(join(source, child), join(target, child), { recursive: true });
      }
    } else {
      await cp(source, join(target, entry), { recursive: true });
    }
  }
  await cp(file, join(target, "ember-plugin.json"));
}

function installedPath(id, path) {
  return `${id}/${path.replace(/^\.\//u, "").replace(/^dist\//u, "")}`;
}

async function writeCommandIndex(manifests) {
  const commands = manifests
    .filter(({ manifest }) => manifest.command !== undefined)
    .map(({ name, manifest }) => ({
      id: manifest.id,
      version: nonEmptyString(manifest.version) ? manifest.version : packageVersion,
      description: manifest.description ?? "",
      name: manifest.command.name,
      commandDescription: manifest.command.description ?? "",
      cli: installedPath(name, manifest.command.cli),
      entry: manifest.entry === undefined ? null : installedPath(name, manifest.entry),
      bundled: manifest.bundled === true,
    }));
  const seen = new Map();
  for (const command of commands) {
    if (seen.has(command.name)) {
      throw new Error(`duplicate plugin command "${command.name}" declared by ${seen.get(command.name)} and ${command.id}`);
    }
    seen.set(command.name, command.id);
  }
  await mkdir(join(distRoot, "plugins"), { recursive: true });
  await writeFile(join(distRoot, "plugins", "commands.json"),
    JSON.stringify({ schemaVersion: 1, commands }, null, 2) + "\n");
}

const manifests = await loadManifests();
for (const plugin of manifests) await buildPlugin(plugin);
await writeCommandIndex(manifests);
