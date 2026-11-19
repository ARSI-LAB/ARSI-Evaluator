import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, posix, relative, resolve } from "node:path";
import type { WorkflowExecutorOptions, WorkflowRunRecord, WorkflowReportDocument } from "../core/contracts/workflow.js";
import { checkedPath, evidencePath } from "../core/artifacts/artifacts.js";
import { formatError, redactDiagnostic } from "../core/errors/diagnostics.js";
import { LocalWorkflowStore } from "../plugins/stores/workflow-local.js";
import { acquireRuntimeLock } from "../infrastructure/runtime-installation/lock.js";
import { atomic, fileRetry } from "../infrastructure/filesystem/atomic-json.js";
import { workflowDigest } from "../core/workflow/values.js";
import { openWorkflowReporting } from "./workflow-report-plugins.js";
import type { PluginRegistry } from "./plugins/open-registry.js";

async function textFile(path: string, text: string) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, text, { flag: "wx", mode: 0o600 });
    await fileRetry(() => rename(temporary, path));
  } finally { await rm(temporary, { force: true }); }
}

function summary(record: WorkflowRunRecord): string {
  const latest = new Map(record.units.map(unit => [unit.key, unit]));
  const completed = [...latest.values()].filter(unit => unit.status === "completed").length;
  const lines = ["# Evaluation report", "", `Run: ${record.runId}`, "", `Status: ${record.status}`, "",
    `Completed units: ${completed}/${latest.size}`, "", `Business results committed: ${record.businessComplete ? "yes" : "no"}`, ""];
  const metrics = record.outputs.metrics ?? record.steps.findLast(step => step.status === "completed" && step.outputs.metrics !== undefined)?.outputs.metrics;
  if (metrics !== undefined) lines.push("## Metrics", "", "```json", JSON.stringify(metrics, null, 2), "```", "");
  const failures = [...record.errors, ...record.steps.flatMap(step => step.errors)];
  if (failures.length) lines.push("## Diagnostics", "", "```json", JSON.stringify(failures, null, 2), "```", "");
  const artifacts = record.artifacts.filter(artifact => artifact.visibility === "public");
  if (artifacts.length) lines.push("## Artifacts", "", ...artifacts.map(artifact =>
    `- [${artifact.protocol.replace(/[\[\]\r\n]/g, "_")}](${artifact.path.split("/").map(encodeURIComponent).join("/")})`), "");
  return lines.join("\n");
}

function reportDocument(path: string, value: string | WorkflowReportDocument, files: Map<string, string>, secrets: readonly string[] = []): string {
  if (typeof value === "string") return redactDiagnostic(value, secrets);
  if (!value || typeof value.markdown !== "string" || !value.files || typeof value.files !== "object" || Array.isArray(value.files))
    throw new TypeError("Invalid offline report document");
  const namespace = `report-assets/${workflowDigest(path).slice(0, 16)}`;
  const supplied = new Map(Object.entries(value.files));
  for (const [name, content] of supplied) {
    if (evidencePath(name) !== name || typeof content !== "string")
      throw new TypeError("Unsafe report attachment");
  }
  const relocate = (text: string, source: string, target: string) => text.replace(/\]\(([^)]+)\)/gu, (match, link: string) => {
    if (/^(?:[a-z][a-z\d+.-]*:|[/#])/iu.test(link)) return match;
    const location = link.replace(/[?#].*$/u, "");
    let decoded: string;
    try { decoded = decodeURIComponent(location); } catch { return match; }
    const original = posix.normalize(posix.join(posix.dirname(source), decoded));
    const destination = supplied.has(original) ? `${namespace}/${original}` : original;
    return `](${posix.relative(posix.dirname(target), destination).split("/").map(encodeURIComponent).join("/")}${link.slice(location.length)})`;
  });
  for (const [name, content] of supplied) files.set(`${namespace}/${name}`, redactDiagnostic(name.endsWith(".md")
    ? relocate(content, name, `${namespace}/${name}`) : content, secrets));
  return redactDiagnostic(relocate(value.markdown, "report.md", "report.md"), secrets);
}

async function publish(root: string, files: Map<string, string>, mode: "update" | "resume") {
  const reports = join(root, "reports");
  let current: string | undefined;
  try {
    const value: unknown = JSON.parse(await readFile(await checkedPath(root, "reports/current.json"), "utf8"));
    if (!value || typeof value !== "object" || !("directory" in value) || typeof value.directory !== "string" || !/^resume-[1-9]\d*$/.test(value.directory))
      throw new TypeError("Invalid current workflow report directory");
    current = value.directory;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const write = async (base: string, path: string, content: string) => {
    const target = join(base, path);
    const parts = evidencePath(relative(root, target)).split("/"); parts.pop();
    let parent = "";
    for (const part of parts) {
      parent = parent ? `${parent}/${part}` : part;
      await mkdir(join(root, parent), { recursive: true });
      await checkedPath(root, parent);
    }
    await textFile(target, content);
  };
  const snapshot = async (name: string, contents: Map<string, string>) => {
    const directory = join(reports, name);
    for (const [path, content] of contents) await write(directory, path, path.endsWith(".md")
      ? content.replace(/\]\(([^)]+)\)/gu, (match, link: string) => {
        if (/^(?:[a-z][a-z\d+.-]*:|[/#])/iu.test(link)) return match;
        let decoded: string;
        try { decoded = decodeURIComponent(link.replace(/[?#].*$/u, "")); } catch { return match; }
        const target = posix.normalize(posix.join(posix.dirname(path), decoded));
        return contents.has(target) ? match : `](../../${link})`;
      }) : content);
  };
  if (mode === "resume") {
    await mkdir(reports, { recursive: true });
    await checkedPath(root, "reports");
    const names = await readdir(reports);
    if (!current && !names.includes("initial")) {
      const previous = new Map<string, string>();
      let paths: unknown = ["report.md"];
      try { paths = JSON.parse(await readFile(await checkedPath(root, "report-files.json"), "utf8")); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (!Array.isArray(paths) || paths.some(path => typeof path !== "string" || path !== "report.md" && !path.startsWith("report-assets/")))
        throw new TypeError("Invalid saved report attachment list");
      for (const path of paths as string[]) {
        try { previous.set(path, await readFile(await checkedPath(root, path), "utf8")); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
      if (previous.size) await snapshot("initial", previous);
    }
    current = `resume-${Math.max(0, ...names.filter(name => /^resume-[1-9]\d*$/.test(name)).map(name => Number(name.slice(7)))) + 1}`;
    await snapshot(current, files);
    await atomic(join(reports, "current.json"), { directory: current });
  } else if (current) await snapshot(current, files);
  for (const [path, content] of files) await write(root, path, content);
  await atomic(join(root, "report-files.json"), [...files.keys()]);
  return join(root, "report.md");
}

type ReportOptions = { registry?: PluginRegistry; automatic?: boolean; mode?: "update" | "resume"; secrets?: readonly string[]; onEvent?: WorkflowExecutorOptions["onEvent"] };

/** Caller holds the workflow writer lock. Reporting runs after evaluation resources have closed. */
export async function finalizeWorkflowReport(directory: string, options: ReportOptions = {}): Promise<string> {
  const root = resolve(directory), store = new LocalWorkflowStore(root), record = await store.read();
  const failures: string[] = [], sections: string[] = [], files = new Map<string, string>();
  const log = (message: string) => options.onEvent?.({ path: "report", status: "running", message,
    progress: { phase: "report", message } });
  log("Writing saved evaluation report");
  try {
    const reporting = await openWorkflowReporting(root, record.fingerprint, options.registry);
    try {
      for (const step of reporting.steps) {
        const prior = record.steps.findLast(row => row.path === step.path);
        // A failed in-workflow Reporter is not automatically called twice in the same run.
        if (options.automatic && prior?.status === "failed") continue;
        try {
          const hook = reporting.ctx.evaluator.workflows.step(step.type).report;
          if (!hook) throw new TypeError(`Missing report hook: ${step.type}`);
          const rendered = await hook.rebuild(step.config, { record: structuredClone(record), directory: root,
            configDirectory: reporting.configDirectory, path: step.path, signal: AbortSignal.timeout(30_000),
            reuse: options.automatic === true && prior?.status === "completed", artifacts: { read: store.artifacts(step.path).read },
            log: message => log(redactDiagnostic(message, options.secrets)),
          });
          const markdown = reportDocument(step.path, rendered, files, options.secrets);
          if (markdown) sections.push(markdown);
        } catch (error) { failures.push(formatError(error, options.secrets)); }
      }
    } finally { await reporting.dispose(); }
  } catch (error) { failures.push(formatError(error, options.secrets)); }
  const content = sections.length ? `# Evaluation report\n\nRun: ${record.runId}\n\nStatus: ${record.status}\n\n${sections.join("\n\n")}` : summary(record);
  files.set("report.md", content);
  const target = await publish(root, files, options.mode ?? "update");
  if (failures.length) {
    await atomic(join(root, "report-errors.json"), { errors: failures });
    const message = failures.join("\n");
    options.onEvent?.({ path: "report", status: "failed", message, progress: { phase: "report", message, error: true } });
    if (!options.automatic) throw new Error(message);
  } else await rm(join(root, "report-errors.json"), { force: true });
  return target;
}

/** Offline reporting never receives model credentials or evaluation resources. */
export async function rebuildWorkflowReport(directory: string): Promise<string> {
  const root = resolve(directory);
  const release = await acquireRuntimeLock(join(root, ".workflow.lock"), new AbortController().signal, { wait: false });
  try { return await finalizeWorkflowReport(root); }
  finally { await release(); }
}
