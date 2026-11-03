import { readFile } from "node:fs/promises";
import type { RunIdentity } from "./contracts/result.js";

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

/** Actual package name/version plus host runtime; source and dist both sit two levels below package.json. */
export async function loadRunIdentity(): Promise<RunIdentity> {
  const manifest = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8")) as {
    name?: unknown;
    version?: unknown;
  };
  if (!nonEmpty(manifest.name) || !nonEmpty(manifest.version))
    throw new TypeError("Evaluator package.json lacks name/version");
  return {
    evaluator: { name: manifest.name, version: manifest.version },
    runtime: { node: process.version, platform: process.platform, arch: process.arch },
  };
}

/** Persisted manifests are a validation boundary; identity is optional for historical runs. */
export function assertRunIdentity(value: unknown): asserts value is RunIdentity {
  const object = (item: unknown): item is Record<string, unknown> =>
    item !== null && typeof item === "object" && !Array.isArray(item);
  const exact = (item: unknown, keys: string[]) =>
    object(item) &&
    Object.keys(item).length === keys.length &&
    keys.every(key => {
      const field = item[key];
      return nonEmpty(field) && field.length <= 1024;
    });
  if (
    !object(value) ||
    Object.keys(value).length !== 2 ||
    !exact(value.evaluator, ["name", "version"]) ||
    !exact(value.runtime, ["node", "platform", "arch"])
  )
    throw new TypeError("Invalid run identity");
}
