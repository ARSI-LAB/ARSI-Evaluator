import { randomUUID } from "node:crypto";
import { copyFile, lstat, mkdir, readFile, readdir, rename, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { inspectFile, checkedPath } from "../../core/artifacts/artifacts.js";
import { expectRecord } from "../../core/validation/input.js";
import { acquireRuntimeLock } from "../../infrastructure/runtime-installation/lock.js";
import { fileRetry } from "../../infrastructure/filesystem/atomic-json.js";
import type { JobsClient } from "../../infrastructure/ray/jobs-client.js";
import { LocalWorkflowStore } from "../../plugins/stores/workflow-local.js";
import { downloadRunResults } from "./jobs-results.js";

async function files(root: string, prefix = ""): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    if (entry.name.startsWith(".") || !prefix && ["retry-control.json", "workflow-deployment.json"].includes(entry.name)) continue;
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) result.push(...await files(root, relative));
    else result.push(relative);
  }
  return result;
}

async function ensureParents(root: string, relative: string): Promise<void> {
  const parts = relative.split("/"); parts.pop();
  let current = root;
  for (const part of parts) {
    current = join(current, part);
    try { await mkdir(current); }
    catch (error) { if (!error || typeof error !== "object" || !("code" in error) || error.code !== "EEXIST") throw error; }
    const state = await lstat(current);
    if (!state.isDirectory() || state.isSymbolicLink()) throw new TypeError("Workflow result parent is not a regular directory");
  }
}

/** Validate the complete downloaded snapshot before publishing metadata that refers to its artifacts. */
export async function downloadWorkflowResults(client: JobsClient, jobId: string, outputRoot: string, fingerprint: string,
  signal: AbortSignal, log: (message: string) => void) {
  const root = resolve(outputRoot), staging = join(root, `.workflow-download-${randomUUID()}`);
  let release: (() => Promise<void>) | undefined;
  try {
    const downloaded = await downloadRunResults(client, jobId, staging, log, signal);
    const record = await new LocalWorkflowStore(downloaded).read();
    const plan = expectRecord(JSON.parse(await readFile(join(downloaded, "plan.json"), "utf8")), "downloaded plan");
    if (record.fingerprint !== fingerprint || plan.fingerprint !== fingerprint || record.runId !== basename(downloaded))
      throw new TypeError("Downloaded result differs from the submitted workflow");
    const directory = join(root, record.runId);
    await mkdir(directory, { recursive: true });
    if ((await lstat(directory)).isSymbolicLink()) throw new TypeError("Workflow result directory cannot be a symlink");
    release = await acquireRuntimeLock(join(directory, ".workflow.lock"), signal, { wait: false });
    try {
      const previous = expectRecord(JSON.parse(await readFile(join(directory, "plan.json"), "utf8")), "existing plan");
      if (previous.fingerprint !== fingerprint) throw new TypeError("Existing directory belongs to a different workflow");
    } catch (error) { if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") throw error; }
    const inventory = await files(downloaded);
    // run.json is the commit point. All referenced immutable evidence must already exist.
    inventory.sort((a, b) => Number(a === "run.json") - Number(b === "run.json") || a.localeCompare(b));
    for (const relative of inventory) {
      signal.throwIfAborted();
      const source = await checkedPath(downloaded, relative), target = join(directory, relative);
      await ensureParents(directory, relative);
      try {
        await checkedPath(directory, relative);
        if (relative === "workflow-reporting.json") continue;
        if (relative.startsWith("artifacts/")) {
          const [existing, incoming] = await Promise.all([inspectFile(directory, relative), inspectFile(downloaded, relative)]);
          if (existing.sha256 !== incoming.sha256 || existing.size !== incoming.size) throw new TypeError("Immutable workflow artifact changed");
          continue;
        }
      } catch (error) { if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") throw error; }
      const temporary = join(dirname(target), `.${basename(target)}.${randomUUID()}.tmp`);
      try { await copyFile(source, temporary); await fileRetry(() => rename(temporary, target)); }
      finally { await fileRetry(() => rm(temporary, { force: true })); }
    }
    return { directory, record };
  } finally {
    try { await release?.(); }
    finally { await rm(staging, { recursive: true, force: true }); }
  }
}
