import { readFile } from "node:fs/promises";
import type { CliOverrides } from "../core/contracts/config.js";
import type { ImageCleanupSummary } from "../core/contracts/image-cleanup.js";
import { formatError } from "../core/errors/diagnostics.js";
import { workflowObject } from "../core/workflow/values.js";
import { parseImageCleanupSummary } from "../infrastructure/ray/image-cleanup.js";
import type { diagnose } from "../plugins/workflows/benchmark/doctor.js";
import type { diagnoseDownloads } from "../plugins/workflows/benchmark/downloads.js";
import type { WorkflowOptions } from "./workflow.js";
import { maintainWorkflow } from "./workflow-maintenance.js";

type ConfigOptions = Pick<WorkflowOptions, "configPath" | "patchPath" | "networkConfigPath" | "env" | "signal">;
export type DoctorOptions = ConfigOptions & { overrides?: CliOverrides };
export type CleanupOptions = ConfigOptions & { execute?: boolean };
export type DoctorReport = {
  checks: Awaited<ReturnType<typeof diagnose>>;
  network: Awaited<ReturnType<typeof diagnoseDownloads>>;
};

async function benchmarkGroups(options: ConfigOptions, operation: "doctor" | "cleanup-images", execute = false, overrides: CliOverrides = {}) {
  const { signal } = options;
  signal?.throwIfAborted();
  const { apiKey, plugins, ...parameters } = overrides;
  const env = { ...(options.env ?? process.env) };
  if (apiKey !== undefined) {
    if (!apiKey.trim()) throw new TypeError("API key must not be empty");
    parameters.apiKeyEnv = "EVALUATOR_SDK_API_KEY";
    env.EVALUATOR_SDK_API_KEY = apiKey;
  }
  try {
    const rows = await maintainWorkflow({ ...options, env, ...(plugins ? { plugins } : {}), parameterOverrides: parameters },
      { operation, options: operation === "doctor" ? {} : { execute } });
    signal?.throwIfAborted();
    const groups = rows.filter(row => row.provider === "benchmark.runtime").flatMap(row =>
      "output" in row && Array.isArray(row.output.groups) ? row.output.groups.map(group => workflowObject(group)) : []);
    if (!groups.length) throw new Error("This operation requires a Benchmark report. Use maintain() for per-resource results.");
    return groups;
  } catch (error) {
    signal?.throwIfAborted();
    const secrets = new Set(Object.entries(env).flatMap(([key, value]) =>
      /key|token|secret|password|credential|authorization/i.test(key) && value ? [value] : []));
    const overrideSecret = parameters.apiKeyEnv && env[parameters.apiKeyEnv];
    if (overrideSecret) secrets.add(overrideSecret);
    for (const file of [options.configPath, options.networkConfigPath]) {
      if (!file) continue;
      const yaml = await readFile(file, { encoding: "utf8", signal }).catch(() => "");
      for (const [, name] of yaml.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)) {
        const value = name && env[name];
        if (value) secrets.add(value);
      }
    }
    signal?.throwIfAborted();
    throw new Error(formatError(error, [...secrets].sort((a, b) => b.length - a.length)));
  }
}

export async function doctorBenchmark(options: DoctorOptions): Promise<DoctorReport> {
  const groups = await benchmarkGroups(options, "doctor", false, options.overrides);
  const [group] = groups;
  if (groups.length !== 1 || !group || !Array.isArray(group.checks) || !group.network)
    throw new Error("doctor() requires one Benchmark group. Use maintain() to inspect every group.");
  // The built-in benchmark.runtime provider serializes the native reports for transport.
  const { checks, network } = group as unknown as DoctorReport;
  const missing = checks.filter(check => check.name.startsWith("credential ") && check.status === "failed");
  if (missing.length) throw new Error("Missing " + missing.map(check => check.name).join(", "));
  return { checks, network };
}

export async function cleanupBenchmark(options: CleanupOptions): Promise<ImageCleanupSummary> {
  if (options.execute !== undefined && typeof options.execute !== "boolean") throw new TypeError("cleanup.execute must be a boolean");
  const execute = options.execute ?? false;
  const groups = await benchmarkGroups(options, "cleanup-images", execute);
  const nodes = groups.flatMap(group => {
    const summary = parseImageCleanupSummary(group);
    if (summary.preview !== !execute) throw new TypeError("Unexpected Benchmark cleanup mode");
    return summary.nodes;
  });
  return { preview: !execute, nodes };
}
