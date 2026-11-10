import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse, stringify } from "yaml";

// Repository plugins declare themselves in plugins/<name>/ember-plugin.json. The installed
// modules are collected in one patch for the packaged runtime and indexed for discovery.
const FLAG_PATTERN = /^--([a-z][a-z0-9-]*)(?: +(?:<([a-z][a-z0-9-]*)>|\[([a-z][a-z0-9-]*)\]))?$/u;

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "";
}

function installSource(entry) {
  return typeof entry === "string" ? { from: entry, to: entry } : entry;
}

function pluginFlags(manifest, fail) {
  if (manifest.flags === undefined) return [];
  if (!Array.isArray(manifest.flags)) fail("flags must be an array");
  const names = new Set();
  return manifest.flags.map((value, index) => {
    const label = `flags[${index}]`;
    if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
    const unknown = Object.keys(value).find(key => !["command", "flag", "description", "config"].includes(key));
    if (unknown !== undefined) fail(`${label} contains unknown field ${unknown}`);
    if (value.command !== "run") fail(`${label}.command must be run`);
    if (!nonEmptyString(value.description)) fail(`${label}.description must be a non-empty string`);
    const match = typeof value.flag === "string" ? FLAG_PATTERN.exec(value.flag) : null;
    if (!match) fail(`${label}.flag must look like "--name", "--name <value>" or "--name [value]"`);
    if (names.has(match[1])) fail(`${label}.flag duplicates --${match[1]}`);
    names.add(match[1]);
    if (value.config !== undefined) {
      if (typeof value.config !== "string" || !/^[a-z][A-Za-z0-9]*$/u.test(value.config)) fail(`${label}.config must be a camelCase identifier`);
      if (match[2] === undefined && match[3] === undefined) fail(`${label}.config requires a value placeholder in flag`);
    }
    return { command: "run", flag: value.flag, description: value.description,
      ...(value.config === undefined ? {} : { config: value.config }) };
  });
}

function relativePath(root, path) {
  return relative(root, path).split(sep).join("/");
}

export async function buildPlugins(root = fileURLToPath(new URL("..", import.meta.url))) {
  const pluginsDir = join(root, "plugins");
  const distRoot = join(root, "dist");
  const typescript = join(root, "node_modules", "typescript", "bin", "tsc");

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
      const fail = message => { throw new Error(`${relativePath(root, file)}: ${message}`); };
      let manifest;
      try {
        manifest = JSON.parse(await readFile(file, "utf8"));
      } catch (error) {
        fail(`invalid JSON: ${error.message}`);
      }
      if (!nonEmptyString(manifest.id)) fail("id must be a non-empty string");
      if (manifest.id !== name) fail(`id "${manifest.id}" must match the directory name`);
      if (manifest.version !== undefined && !nonEmptyString(manifest.version)) {
        fail("version must be a non-empty string when present");
      }
      if (manifest.entry !== undefined && !nonEmptyString(manifest.entry)) {
        fail("entry must point at a compiled module when present");
      }
      if (manifest.cli !== undefined && !nonEmptyString(manifest.cli)) {
        fail("cli must point at a compiled module when present");
      }
      const flags = pluginFlags(manifest, fail);
      if (manifest.build !== undefined) {
        const { tsconfig, script } = manifest.build;
        if (tsconfig !== undefined && !nonEmptyString(tsconfig)) {
          fail("build.tsconfig must point at a tsconfig file when present");
        }
        if (script !== undefined && !nonEmptyString(script)) {
          fail("build.script must point at a Node script when present");
        }
        if (!Array.isArray(manifest.build.install) || manifest.build.install.length === 0) {
          fail("build.install must list the files to compile or copy into the runtime");
        }
        for (const entry of manifest.build.install) {
          const item = installSource(entry);
          if (!nonEmptyString(item.from) || !nonEmptyString(item.to)) fail("build.install contains an empty path");
        }
      }
      if (manifest.patch !== undefined && !nonEmptyString(manifest.patch)) {
        fail("patch must point at a cordis.patch.yaml file when present");
      }
      manifests.push({ name, dir: join(pluginsDir, name), file, manifest, flags, fail });
    }
    return manifests;
  }

  async function buildPlugin({ name, dir, file, manifest, flags, fail }, version) {
    if (manifest.build === undefined) return undefined;
    const { tsconfig: tsconfigEntry, script, install } = manifest.build;
    await rm(join(dir, "dist"), { recursive: true, force: true });
    if (tsconfigEntry !== undefined) {
      const tsconfig = join(dir, tsconfigEntry);
      if (!existsSync(tsconfig)) fail(`missing tsconfig: ${relativePath(root, tsconfig)}`);
      const compiled = spawnSync(process.execPath, [typescript, "-p", tsconfig], { cwd: root, stdio: "inherit" });
      if (compiled.status !== 0) fail(`TypeScript build failed for ${name}`);
    }
    if (script !== undefined) {
      const scriptPath = join(dir, script);
      if (!existsSync(scriptPath)) fail(`missing build script: ${relativePath(root, scriptPath)}`);
      const built = spawnSync(process.execPath, [scriptPath], { cwd: dir, stdio: "inherit" });
      if (built.status !== 0) fail(`build script failed for ${name}`);
    }
    const target = join(distRoot, "plugins", name);
    await rm(target, { recursive: true, force: true });
    await mkdir(target, { recursive: true });
    for (const entry of install) {
      const { from, to } = installSource(entry);
      const source = join(dir, from);
      if (!existsSync(source)) fail(`install path does not exist: ${relativePath(root, source)}`);
      // The compiled output is flattened into dist/plugins/<id>/; static assets keep their relative path.
      if (from === "dist") {
        for (const child of await readdir(source)) {
          await cp(join(source, child), join(target, child), { recursive: true });
        }
      } else {
        await cp(source, join(target, to), { recursive: true });
      }
    }
    const moduleName = value => `./${value.replace(/^\.\/dist\//u, "").replace(/^\.\//u, "")}`;
    let operations = [];
    if (manifest.patch !== undefined) {
      const patchFile = join(dir, manifest.patch);
      if (!existsSync(patchFile)) fail(`missing patch: ${relativePath(root, patchFile)}`);
      // The compiled entry lands at the plugin root, so ./dist/ prefixed entries are rewritten there.
      const patch = (await readFile(patchFile, "utf8")).replace(/^(\s*name:\s*["']?)\.\/dist\//gmu, "$1./");
      await writeFile(join(target, "cordis.patch.yaml"), patch);
      operations = parse(patch, { maxAliasCount: 100 });
    } else if (manifest.entry !== undefined) {
      operations = [{ insert: [{ id: name, name: moduleName(manifest.entry) }] }];
    }
    await cp(file, join(target, "ember-plugin.json"));
    if (!Array.isArray(operations) || operations.some(operation => !Array.isArray(operation?.insert))) {
      fail("plugin patch must contain a list of insert operations");
    }
    const modules = operations.map(operation => ({
      ...operation,
      insert: operation.insert.map(entry => {
        if (!nonEmptyString(entry?.name)) fail("plugin patch entry must have a module name");
        const modulePath = resolve(target, entry.name);
        if (!entry.name.startsWith("./") || !modulePath.startsWith(target + sep) || !existsSync(modulePath)) {
          fail(`plugin entry must point at an installed module: ${entry.name}`);
        }
        return { ...entry, name: `./${relativePath(distRoot, modulePath)}` };
      }),
    }));
    const installName = value => `${name}/${value.replace(/^\.\/dist\//u, "").replace(/^\.\//u, "")}`;
    const record = {
      id: manifest.id,
      version: manifest.version ?? version,
      entry: manifest.entry === undefined ? modules.flatMap(operation => operation.insert)[0]?.name.replace(/^\.\/plugins\//u, "") : installName(manifest.entry),
      ...(manifest.cli === undefined ? {} : { cli: installName(manifest.cli) }),
      ...(flags.length === 0 ? {} : { flags }),
    };
    if (record.entry === undefined) fail("plugin must declare an entry module");
    return { operations: modules, record };
  }

  const version = JSON.parse(await readFile(join(root, "package.json"), "utf8")).version;
  const operations = [];
  const records = [];
  for (const plugin of await loadManifests()) {
    const built = await buildPlugin(plugin, version);
    if (built === undefined) continue;
    operations.push(...built.operations);
    records.push(built.record);
  }
  await writeFile(join(distRoot, "bundled-plugins.patch.yaml"), stringify(operations));
  await writeFile(join(distRoot, "plugins/index.json"), JSON.stringify({ plugins: records }, null, 2) + "\n");
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await buildPlugins();
}
