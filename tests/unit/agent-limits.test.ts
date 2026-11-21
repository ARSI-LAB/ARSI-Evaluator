import { resolve } from "node:path";
import { expect, test } from "vitest";
import { checkAgentLimits } from "../../src/plugins/solvers/agent-limits.js";
import { AgentBundleSolver } from "../../src/plugins/solvers/agentbundle.js";
import { parseClaudeCodeConfig } from "../../src/plugins/solvers/claudecode.js";
import { parseCodeBuddyConfig } from "../../src/plugins/solvers/codebuddy.js";
import { parseCodexConfig } from "../../src/plugins/solvers/codex.js";
import { parseNativeCodeConfig } from "../../src/plugins/solvers/native-code.js";
import { parseSimpleAgentConfig } from "../../src/plugins/solvers/simpleagent.js";
import { parseTraeConfig } from "../../src/plugins/solvers/trae.js";
import { parseZCodeConfig } from "../../src/plugins/solvers/zcode.js";

test.each([
  ["codex", parseCodexConfig, ["contextWindow"]],
  ["trae", parseTraeConfig, ["contextWindow"]],
  ["zcode", parseZCodeConfig, ["maxTokens", "contextWindow"]],
  ["simpleagent", parseSimpleAgentConfig, ["maxTokens", "contextWindow"]],
  ["claudecode", parseClaudeCodeConfig, ["maxTokens", "maxTurns", "contextWindow"]],
  ["codebuddy", parseCodeBuddyConfig, ["maxTokens", "maxTurns", "contextWindow"]],
  ...(["qwencode", "kimicode", "minimaxcode", "opencode"] as const).map(name =>
    [name, (value: unknown) => parseNativeCodeConfig(name, value), ["maxTokens", "maxTurns", "contextWindow"]] as const),
] as const)("%s only accepts limits its harness can execute", (name, parse, allowed: readonly string[]) => {
  expect(parse({})).toEqual({});
  for (const field of ["maxTokens", "maxTurns", "contextWindow"]) {
    const config = { [field]: 100000 };
    if (allowed.includes(field)) expect(parse(config)).toEqual(config);
    else expect(() => parse(config)).toThrow(new RegExp(`${name}.*${field}`));
    expect(() => parse({ [field]: 0 })).toThrow(/positive integer/);
  }
});

test.each([
  ["deepagents", "tests/fixtures/agentbundle/deepagents", "maxTurns"],
  ["deepagents", "tests/fixtures/agentbundle/deepagents", "maxTokens"],
  ["deepagents", "tests/fixtures/agentbundle/deepagents", "contextWindow"],
  ["dsh", "tests/fixtures/agentbundle/dsh-deepswe", "maxTurns"],
])("%s rejects %s's unsupported %s before runtime installation", async (name, path, field) => {
  const limits = { [field]: 100000 };
  const model = { name: "fixture", provider: null, endpoint: null, api: null, ...limits };
  const solver = new AgentBundleSolver(resolve(path), model, { value: "", reference: null }, undefined, { limits });
  await expect(solver.provenance(new AbortController().signal)).rejects.toThrow(new RegExp(`${name}.*${field}`));
});

test("Pi Bundle exposes native model limits and rejects a task-loop limit", () => {
  expect(() => checkAgentLimits("pi", { maxTokens: 2048, contextWindow: 120000 })).not.toThrow();
  expect(() => checkAgentLimits("pi", { maxTurns: 2 })).toThrow(/pi.*maxTurns/);
});
