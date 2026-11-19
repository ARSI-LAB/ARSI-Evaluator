import { mkdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { atomic } from "./atomic-json.js";
import { parsePluginActivations } from "../../core/plugins/activation.js";
import type { PluginActivation } from "../../core/contracts/plugin-extension.js";

const indexRoot = () => process.env.EVALUATOR_RUN_INDEX_DIR ?? join(homedir(), ".arsi-evaluator", "runs");
export const safeId = (value: string) => {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u.test(value) || value.endsWith(".")) throw new TypeError("Unsafe run/request ID");
  return value;
};
export async function registerRunLocation(runId: string, directory: string, indexDirectory = indexRoot()): Promise<void> {
  await mkdir(indexDirectory, { recursive: true });
  await atomic(join(indexDirectory, `${safeId(runId)}.json`), { runId, directory: resolve(directory) });
}
export async function locateRun(value: string): Promise<string> {
  if (value.includes("/") || value.includes("\\")) return resolve(value);
  try { if ((await stat(resolve(value))).isDirectory()) return resolve(value); }
  catch (error) { if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") throw error; }
  const item: unknown = JSON.parse(await readFile(join(indexRoot(), `${safeId(value)}.json`), "utf8"));
  if (!item || typeof item !== "object" || !("runId" in item) || item.runId !== value || !("directory" in item) || typeof item.directory !== "string") throw new Error("Invalid run index");
  return item.directory;
}
