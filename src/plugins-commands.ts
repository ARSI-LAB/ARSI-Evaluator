import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** A plugin that opted into the packaged runtime through plugins/<id>/ember-plugin.json. */
export interface PluginCommand {
  id: string;
  version: string;
  description: string;
  name: string;
  commandDescription: string;
  cliFile: string;
  entryFile: string | null;
  bundled: boolean;
}

interface CommandIndex {
  schemaVersion?: unknown;
  commands?: unknown;
}

interface Manifest {
  id?: unknown;
  version?: unknown;
  description?: unknown;
  entry?: unknown;
  bundled?: unknown;
  command?: { name?: unknown; cli?: unknown; description?: unknown } | undefined;
}

function stringOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function fromIndex(file: string): PluginCommand[] {
  const body = JSON.parse(readFileSync(file, "utf8")) as CommandIndex;
  if (!Array.isArray(body.commands)) throw new TypeError(`${file}: commands must be an array`);
  const base = dirname(file);
  return body.commands.map(entry => {
    const command = entry as Record<string, unknown>;
    const cli = stringOf(command.cli);
    const entryPath = stringOf(command.entry);
    if (cli === "") throw new TypeError(`${file}: a command is missing its cli path`);
    return {
      id: stringOf(command.id),
      version: stringOf(command.version),
      description: stringOf(command.description),
      name: stringOf(command.name),
      commandDescription: stringOf(command.commandDescription),
      cliFile: join(base, cli),
      entryFile: entryPath === "" ? null : join(base, entryPath),
      bundled: command.bundled === true,
    };
  }).filter(command => command.name !== "");
}

/** Reads plugins directly in a source checkout; the artifact is only used from a built package. */
function fromManifests(directory: string): PluginCommand[] {
  const commands: PluginCommand[] = [];
  for (const name of readdirSync(directory, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name)) {
    const file = join(directory, name, "ember-plugin.json");
    if (!existsSync(file)) continue;
    const manifest = JSON.parse(readFileSync(file, "utf8")) as Manifest;
    if (manifest.command === undefined) continue;
    const cli = stringOf(manifest.command.cli);
    if (cli === "") continue;
    const entry = stringOf(manifest.entry);
    commands.push({
      id: stringOf(manifest.id),
      version: stringOf(manifest.version),
      description: stringOf(manifest.description),
      name: stringOf(manifest.command.name),
      commandDescription: stringOf(manifest.command.description),
      cliFile: join(directory, name, cli),
      entryFile: entry === "" ? null : join(directory, name, entry),
      bundled: manifest.bundled === true,
    });
  }
  return commands.filter(command => command.name !== "");
}

/** Compiled command index first, then the source manifests when running from a checkout. */
export function pluginCommands(): PluginCommand[] {
  const compiled = fileURLToPath(new URL("./plugins/commands.json", import.meta.url));
  if (existsSync(compiled)) return fromIndex(compiled);
  const source = fileURLToPath(new URL("../plugins/", import.meta.url));
  return existsSync(source) ? fromManifests(source) : [];
}
