import type { Context } from "@deepseek-ai/cordis";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Selection } from "../../../core/contracts/config.js";
import type { StepDefinition, WorkflowObject } from "../../../core/contracts/workflow.js";
import { expectNonEmptyString, expectRecord, parseSelection, rejectUnknown } from "../../../core/validation/input.js";
import { workflowDigest, workflowObject, workflowValue } from "../../../core/workflow/values.js";
import { checkedPath } from "../../../core/artifacts/artifacts.js";
import { LocalRunStore } from "../../stores/local.js";
import { openNativeResource } from "./component-resource.js";
import { saveReport } from "./report.js";

type ReportGroup = { id: string; repetition: number; grouped: boolean; metrics: Selection[]; reporter: Selection };
function groups(input: unknown): ReportGroup[] {
  const config = workflowObject(input);
  rejectUnknown(config, ["groups"], "benchmark reporting");
  if (!Array.isArray(config.groups)) throw new TypeError("Benchmark report requires group selections");
  return config.groups.map(value => {
    const group = workflowObject(value);
    rejectUnknown(group, ["id", "repetition", "grouped", "metrics", "reporter"], "report group");
    const id = expectNonEmptyString(group.id, "report group ID");
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(id) || id.endsWith(".") || typeof group.grouped !== "boolean" ||
        typeof group.repetition !== "number" || !Number.isSafeInteger(group.repetition) || group.repetition < 0 || !Array.isArray(group.metrics))
      throw new TypeError("Invalid Benchmark report group");
    return { id, repetition: group.repetition, grouped: group.grouped,
      metrics: group.metrics.map((value, index) => parseSelection(value, `metrics[${index}]`)), reporter: parseSelection(group.reporter, "reporter") };
  });
}

export function validateBenchmarkReport(input: unknown): WorkflowObject { return { groups: groups(input).map(group => workflowValue(group)) }; }

export function benchmarkOfflineReport(ctx: Context): NonNullable<StepDefinition["report"]> {
  return {
    dependencies: config => groups(config).flatMap(group => [...group.metrics.map(metric => `native.metrics.${metric.name}`), `native.reporter.${group.reporter.name}`]),
    async rebuild(config, context) {
      const reports: string[] = [];
      const files: Record<string, string> = {};
      for (const group of groups(config)) {
        context.signal.throwIfAborted();
        const suffix = group.grouped ? `-${workflowDigest({ variantId: group.id, repetition: group.repetition }).slice(0, 16)}` : "";
        const prefix = group.grouped ? `benchmark-groups/${group.id}/repeat-${group.repetition}/` : "";
        const path = `${prefix}benchmark-evidence/${context.record.runId}${suffix}`;
        let directory: string;
        try { directory = await checkedPath(context.directory, path); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
        let markdown: string | undefined;
        if (context.reuse) {
          try { markdown = await readFile(await checkedPath(directory, "report.md"), "utf8"); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        }
        if (markdown === undefined) {
          const store = new LocalRunStore();
          const releases: (() => Promise<void>)[] = [];
          try {
            await store.open(directory);
            const runtime = { configDirectory: context.configDirectory, resolvePath: (path: string) => resolve(context.configDirectory, path) };
            const metrics = [];
            const credential = async () => { throw new TypeError("Offline reporting cannot resolve credentials"); };
            for (const selection of group.metrics) {
              const instance = await openNativeResource(ctx, "metrics", selection, runtime, credential);
              releases.push(instance.dispose); metrics.push(instance.value);
            }
            const reporter = await openNativeResource(ctx, "reporter", group.reporter, runtime, credential);
            releases.push(reporter.dispose);
            await saveReport(store, metrics, reporter.value);
          } finally {
            try {
              const errors: unknown[] = [];
              for (const release of releases.reverse()) { try { await release(); } catch (error) { errors.push(error); } }
              if (errors.length) throw new AggregateError(errors, "Report resources failed to close");
            } finally { await store.close(); }
          }
          markdown = await readFile(await checkedPath(directory, "report.md"), "utf8");
        }
        // The entry report is at the workflow root; evidence stays in the native store.
        const relocated = markdown.replace(/\]\(([^)]+)\)/gu, (match, link: string) =>
          /^(?:[a-z][a-z\d+.-]*:|[/#])/iu.test(link) ? match : `](${path}/${link})`);
        const metricsText = await readFile(await checkedPath(directory, "metrics.json"), "utf8");
        files[`${path}/metrics.json`] = metricsText;
        const metrics = expectRecord(JSON.parse(metricsText), "saved report metrics");
        for (const value of Array.isArray(metrics.reports) ? metrics.reports : []) {
          const id = expectNonEmptyString(expectRecord(value, "task report").id, "task report ID");
          if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/u.test(id)) throw new TypeError("Unsafe task report ID");
          for (const name of ["report.md", "metrics.json"]) {
            const relative = `points/${id}/${name}`;
            files[`${path}/${relative}`] = await readFile(await checkedPath(directory, relative), "utf8");
          }
        }
        reports.push(group.grouped ? `## ${group.id}, repetition ${group.repetition}\n\n${relocated}` : relocated);
      }
      return { markdown: reports.join("\n\n"), files };
    },
  };
}
