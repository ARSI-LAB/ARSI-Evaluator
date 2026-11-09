import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";

// Repository plugins declare themselves in plugins/<name>/ember-plugin.json. The installed
// modules are collected in one patch for the packaged runtime.
const root = fileURLToPath(new URL("..", import.meta.url));
const pluginsDir = join(root, "plugins");
const distRoot = join(root, "dist");
const typescript = join(root, "node_modules", "typescript", "bin", "tsc");

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
    if (manifest.build !== undefined) {
      const { tsconfig, script } = manifest.build;
      if (tsconfig === undefined && script === undefined) {
        fail(file, "build.tsconfig or build.script must be provided");
      }
      if (tsconfig !== undefined && !nonEmptyString(tsconfig)) {
        fail(file, "build.tsconfig must point at a tsconfig file when present");
      }
      if (script !== undefined && !nonEmptyString(script)) {
        fail(file, "build.script must point at a Node script when present");
      }
      if (!Array.isArray(manifest.build.install) || manifest.build.install.length === 0) {
        fail(file, "build.install must list the files to compile or copy into the runtime");
      }
      for (const entry of manifest.build.install) {
        if (!nonEmptyString(entry)) fail(file, "build.install contains an empty path");
      }
    }
    if (manifest.patch !== undefined && !nonEmptyString(manifest.patch)) {
      fail(file, "patch must point at a cordis.patch.yaml file when present");
    }
    manifests.push({ name, dir: join(pluginsDir, name), file, manifest });
  }
  return manifests;
}

async function buildPlugin({ name, dir, file, manifest }) {
  if (manifest.build === undefined) return [];
  const { tsconfig: tsconfigEntry, script, install } = manifest.build;
  await rm(join(dir, "dist"), { recursive: true, force: true });
  if (tsconfigEntry !== undefined) {
    const tsconfig = join(dir, tsconfigEntry);
    if (!existsSync(tsconfig)) fail(file, `missing tsconfig: ${relative(root, tsconfig)}`);
    const compiled = spawnSync(process.execPath, [typescript, "-p", tsconfig], { cwd: root, stdio: "inherit" });
    if (compiled.status !== 0) fail(file, `TypeScript build failed for ${name}`);
  }
  if (script !== undefined) {
    const scriptPath = join(dir, script);
    if (!existsSync(scriptPath)) fail(file, `missing build script: ${relative(root, scriptPath)}`);
    const built = spawnSync(process.execPath, [scriptPath], { cwd: dir, stdio: "inherit" });
    if (built.status !== 0) fail(file, `build script failed for ${name}`);
  }
  const target = join(distRoot, "plugins", name);
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });
  for (const entry of install) {
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
  let operations = [];
  if (manifest.patch !== undefined) {
    const patchFile = join(dir, manifest.patch);
    if (!existsSync(patchFile)) fail(file, `missing patch: ${relative(root, patchFile)}`);
    // The compiled entry lands at the plugin root, so ./dist/ prefixed entries are rewritten there.
    const patch = (await readFile(patchFile, "utf8")).replace(/^(\s*name:\s*["']?)\.\/dist\//gmu, "$1./");
    await writeFile(join(target, "cordis.patch.yaml"), patch);
    operations = parse(patch, { maxAliasCount: 100 });
  } else if (manifest.entry !== undefined) {
    if (!nonEmptyString(manifest.entry)) fail(file, "entry must point at a compiled module");
    operations = [{ insert: [{ id: name, name: manifest.entry.replace(/^\.\/dist\//u, "./") }] }];
  }
  await cp(file, join(target, "ember-plugin.json"));
  if (!Array.isArray(operations) || operations.some(operation => !Array.isArray(operation?.insert))) {
    fail(file, "plugin patch must contain a list of insert operations");
  }
  return operations.map(operation => ({
    ...operation,
    insert: operation.insert.map(entry => {
      if (!nonEmptyString(entry?.name)) fail(file, "plugin patch entry must have a module name");
      const modulePath = resolve(target, entry.name);
      if (!entry.name.startsWith("./") || !modulePath.startsWith(target + sep) || !existsSync(modulePath)) {
        fail(file, `plugin entry must point at an installed module: ${entry.name}`);
      }
      return { ...entry, name: `./${relative(distRoot, modulePath).split(sep).join("/")}` };
    }),
  }));
}

const operations = [];
for (const plugin of await loadManifests()) operations.push(...await buildPlugin(plugin));
await writeFile(join(distRoot, "bundled-plugins.patch.yaml"), stringify(operations));
