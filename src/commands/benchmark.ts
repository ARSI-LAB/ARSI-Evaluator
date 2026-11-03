import { writeFile } from "node:fs/promises";
import { stringify } from "yaml";
import type { PluginRegistry } from "../plugin-runtime.js";
import { profileChain } from "../config/profiles.js";
import { resolveInput } from "../config/resolve.js";
import type { UserConfig } from "../config/user-schema.js";
import { expectRecord } from "../config/schema.js";

const service = (prefix: string) => ({ model: `\${${prefix}_NAME}`, base_url: `\${${prefix}_ENDPOINT}`, api_key: `\${${prefix}_API_KEY}` });

export function benchmarkNames(registry: PluginRegistry): string[] {
  return [...new Set([...registry.ctx.evaluator.entries().filter(item => item.role === "benchmark").map(item => item.name),
    ...registry.ctx.evaluator.profiles().filter(item => item.role === "benchmark").map(item => item.id)])].sort();
}

export function benchmarkInfo(registry: PluginRegistry, name: string) {
  if (!benchmarkNames(registry).includes(name)) throw new TypeError(`Unknown benchmark: ${name}`);
  const profiles = registry.ctx.evaluator.profiles();
  const profile = profiles.find(item => item.role === "benchmark" && item.id === name);
  const chain = profile ? profileChain(profiles, "benchmark", name) : [];
  // Info has no experiment file; preview defaults using a file named after the benchmark.
  const resolution = resolveInput(`${name}.yaml`, { services: { default: service("MODEL") }, benchmark: name }, profiles);
  return { name, implementation: expectRecord(resolution.source.benchmark, "benchmark").name,
    versions: [...new Set(chain.flatMap(item => Object.keys(item.versions ?? {})))],
    scenarios: [...new Set(chain.flatMap(item => Object.keys(item.scenarios ?? {})))],
    defaultVersion: chain.map(item => item.defaultVersion).filter(item => item !== undefined).at(-1) ?? null,
    defaultScenario: chain.map(item => item.defaultScenario).filter(item => item !== undefined).at(-1) ?? null,
    resolved: resolution.source, origins: resolution.origins };
}

export async function initializeExperiment(registry: PluginRegistry, name: string, path: string): Promise<void> {
  const info = benchmarkInfo(registry, name);
  const benchmark = expectRecord(info.resolved.benchmark, "benchmark");
  const judge = expectRecord(benchmark.config, "benchmark.config").judgeService;
  const verifier = info.resolved.verifier === undefined ? undefined : expectRecord(info.resolved.verifier, "verifier").service;
  const services: UserConfig["services"] = { default: service("MODEL") };
  for (const selected of [judge, verifier])
    if (typeof selected === "string" && selected !== "default" && selected !== "$default") services[selected] = service(selected.toUpperCase().replace(/-/g, "_"));
  const config: UserConfig = { services, benchmark: name };
  await writeFile(path, stringify(config), { flag: "wx", encoding: "utf8" });
}
