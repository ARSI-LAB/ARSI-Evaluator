import { expect, test } from "vitest";
import { parseAgentBundleConfig } from "../../src/plugins/solvers/agentbundle.js";
import { parseClaudeCodeConfig } from "../../src/plugins/solvers/claudecode.js";
import { parseCodeBuddyConfig } from "../../src/plugins/solvers/codebuddy.js";
import { parseCodexConfig } from "../../src/plugins/solvers/codex.js";
import { parseSimpleAgentConfig } from "../../src/plugins/solvers/simpleagent.js";
import { parseTraeConfig } from "../../src/plugins/solvers/trae.js";
import { parseZCodeConfig } from "../../src/plugins/solvers/zcode.js";
import { parseRunnerInput, projectRunnerInput } from "../../src/runtimes/pi/protocol.js";

test.each([parseClaudeCodeConfig, parseCodeBuddyConfig, parseSimpleAgentConfig, parseTraeConfig, parseZCodeConfig])(
  "%s accepts a strict no-tools policy and preserves omitted defaults",
  parse => {
    expect(parse({ tools: "none", webSearch: "disabled" })).toMatchObject({ tools: "none", webSearch: "disabled" });
    expect(parse({ tools: "default", webSearch: "default", webFetch: "default" })).toEqual({});
    expect(() => parse({ tools: "none", webFetch: "enabled" })).toThrow(/conflicts/u);
    expect(() => parse({ webSearch: false })).toThrow(/webSearch/u);
    expect(() => parse({ tool: "none" })).toThrow(/unknown field/u);
  },
);

test("native launchers reject modes unavailable on their locked headless paths", () => {
  expect(parseCodexConfig({ tools: "none" })).toEqual({ shellTool: "disabled" });
  expect(parseCodexConfig({ tools: "none", webSearch: "enabled" })).toEqual({ shellTool: "disabled", webSearch: "enabled" });
  expect(parseCodexConfig({ tools: "none", webSearch: "disabled" })).toEqual({ shellTool: "disabled", webSearch: "disabled" });
  expect(() => parseCodexConfig({ tools: false })).toThrow(/tools must be default or none/u);
  expect(() => parseCodexConfig({ webSearch: "enabled", webFetch: "disabled" })).toThrow(/independently/u);
  expect(parseCodexConfig({ webSearch: "enabled" })).toEqual({ webSearch: "enabled" });
  expect(() => parseTraeConfig({ webSearch: "enabled" })).toThrow(/headless exec/u);
  expect(() => parseZCodeConfig({ webSearch: "enabled" })).toThrow(/custom model route/u);
  expect(() => parseSimpleAgentConfig({ webFetch: "enabled" })).toThrow(/requires?|require/u);
});

test("AgentBundle and Pi runner preserve policy and exact external tool names", () => {
  const config = parseAgentBundleConfig({
    path: "bundle", webSearch: "disabled", pi: { webSearchTools: ["mcp__search__query"] },
  });
  expect(config).toEqual({ path: "bundle", webSearch: "disabled", pi: { webSearchTools: ["mcp__search__query"] } });
  expect(() => parseAgentBundleConfig({ path: "bundle", pi: { webSearchTools: ["*"] } })).toThrow(/exact tool names/u);

  const toolAccess = { webSearch: "disabled", webSearchTools: ["mcp__search__query"] } as const;
  const input = projectRunnerInput({
    key: { runId: "r", taskId: "t", attemptId: "a" },
    input: { id: "t", prompt: "Respond with text." },
    model: { name: "fixture", endpoint: "http://127.0.0.1/v1", api: "openai-completions", provider: null },
    auth: { value: "fixture", reference: null },
    workdir: "/workspace", outputDir: "/agent",
    toolAccess: { ...toolAccess, webSearchTools: [...toolAccess.webSearchTools] },
  });
  expect(parseRunnerInput(JSON.parse(JSON.stringify(input))).toolAccess).toEqual(toolAccess);
});
