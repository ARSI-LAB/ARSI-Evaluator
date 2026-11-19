import { nativeResourceTransport } from "arsi-evaluator";
import "../fixtures/network-fetch.js";
import { resolve } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { openPluginRegistry } from "../../src/application/plugins/open-registry.js";
import { inspectWorkflow } from "../../src/application/workflow.js";
import { benchmarkExperiment } from "../fixtures/workflow/benchmark-plan.js";
import { projectPortableSelection } from "../../src/infrastructure/ray/protocol.js";
import { parseAgentXConfig } from "../../src/plugins/benchmarks/inference-engine/agentx/agentx-benchmark.js";
import { parseAgentXReplayConfig } from "../../src/plugins/solvers/agentx-replay.js";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

test("AgentX Trace accepts hfToken and rejects hfTokenEnv without adding tokenizer credentials", async () => {
  expect(parseAgentXConfig({ hfToken: "explicit-token" })).toMatchObject({ hfToken: "explicit-token" });
  expect(parseAgentXConfig({})).not.toHaveProperty("hfTokenEnv");
  expect(() => parseAgentXConfig({ hfTokenEnv: "HF_TOKEN" })).toThrow(/unknown field hfTokenEnv/);
  expect(() => parseAgentXConfig({ hfToken: "" })).toThrow(); expect(() => parseAgentXConfig({ hfToken: 123 })).toThrow();
  expect(() => parseAgentXReplayConfig({ hfToken: "not-a-solver-option" })).toThrow(/unknown field hfToken/);
  const registry = await openPluginRegistry();
  try {
    const lookup = (role: string, name: string) => nativeResourceTransport(registry.ctx.evaluator.workflows, role, name);
    const portable = projectPortableSelection({ name: "agentx", config: { hfToken: "private-token" } }, "benchmark", lookup);
    expect(portable.config).not.toHaveProperty("hfToken");
    expect(JSON.stringify(portable)).not.toContain("private-token");
  } finally { await registry.dispose(); }
});

test("authenticated Playbooks use env values and existing public examples do not require a token", async () => {
  vi.stubEnv("HF_TOKEN", undefined);
  const env = { MODEL_NAME: "fixture/model", MODEL_ENDPOINT: "https://model.invalid", MODEL_API_KEY: "fixture-model-key", HF_TOKEN: "configured-token", AGENTX_TOKENIZER: "fixture/tokenizer" };
  const plan = await inspectWorkflow({ configPath: resolve("playbook/gpqa/gpqa-simpleagent.yaml"), env });
  expect(benchmarkExperiment(plan).benchmark.config.hfToken).toEqual({ credential: "HF_TOKEN" });
  expect(JSON.stringify(plan)).not.toContain("configured-token");
  const { HF_TOKEN: _token, ...publicEnv } = env;
  for (const file of ["gsm8k/gsm8k-simpleagent.yaml", "mmlu/mmlu-simpleagent.yaml", "humaneval/humaneval-simpleagent.yaml", "agentx/agentx-standard.yaml"])
    expect(benchmarkExperiment(await inspectWorkflow({ configPath: resolve("playbook", file), env: publicEnv })).benchmark.config.hfToken).toBeUndefined();
});
