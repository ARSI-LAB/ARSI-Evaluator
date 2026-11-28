import "../fixtures/network-fetch.js";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { expect, test, vi } from "vitest";
import { stringify } from "yaml";
import { runCli } from "../../src/cli/main.js";
import { inspectWorkflow } from "../../src/application/workflow.js";
import { benchmarkExperiment } from "../fixtures/workflow/benchmark-plan.js";

test.each([60, 120, 3600])("YAML durationSeconds=%s overrides the profile without other configuration changes", async durationSeconds => {
  await mkdir(".scratch", { recursive: true });
  const root = await mkdtemp(resolve(".scratch/agentx-duration-config-"));
  const file = join(root, "experiment.yaml");
  await writeFile(file, stringify({ schemaVersion: 2, workflow: "benchmark.evaluate", with: {
    services: { default: { model: "fixture/model", base_url: "http://localhost:8000/v1", apiKeyEnv: "AGENTX_CONFIG_KEY" } },
    benchmark: { name: "agentx", config: { durationSeconds } },
  } }));
  const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected external request"));
  try {
    const config = { experiment: benchmarkExperiment(await inspectWorkflow({ configPath: file, env: {} })) };
    expect(config.experiment.benchmark.config).toMatchObject({ mode: "standard", durationSeconds, seed: 42 });
    expect(config.experiment.run.timeoutSeconds).toBe(10800);
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    fetch.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});

test.each([
  { scenario: "smoke" },
  { scenario: "standard", config: { mode: "smoke" } },
])("removed smoke configuration fails before source, model or hardware access: %j", async selection => {
  await mkdir(".scratch", { recursive: true });
  const root = await mkdtemp(resolve(".scratch/agentx-config-"));
  const file = join(root, "removed-scenario.yaml");
  vi.stubEnv("AGENTX_CONFIG_KEY", "fixture-key");
  await writeFile(file, stringify({ schemaVersion: 2, workflow: "benchmark.evaluate", with: {
    services: { default: { model: "fixture/model", base_url: "http://localhost:8000/v1", apiKeyEnv: "AGENTX_CONFIG_KEY" } },
    benchmark: { name: "agentx", ...selection },
  } }));
  const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected external request"));
  try {
    for (const args of [["doctor", file], ["run", file, "--dry-run"]]) {
      const messages: string[] = [];
      const code = await runCli(args, { out: text => { messages.push(text); }, error: text => { messages.push(text); } });
      expect(code).not.toBe(0);
      expect(messages.join("\n")).toMatch(/unknown scenario smoke|agentx\.mode must be standard or replay/iu);
    }
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    fetch.mockRestore();
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  }
});
