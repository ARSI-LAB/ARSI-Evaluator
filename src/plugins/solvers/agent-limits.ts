import type { ModelConfig } from "../../core/contracts/config.js";
import { EvaluatorError } from "../../core/errors/evaluator-error.js";
import { expectPositiveInteger, expectRecord } from "../../core/validation/input.js";
import { parseSolverToolPolicy } from "../../core/validation/solver-tool-policy.js";

const fields = ["maxTokens", "maxTurns", "contextWindow"] as const;
export type AgentLimits = Partial<Record<typeof fields[number], number>>;

export function checkAgentLimits(harness: string, limits: AgentLimits): void {
  for (const field of fields) {
    if (limits[field] === undefined) continue;
    let reason: string | undefined;
    if (harness === "deepagents") reason = "the Bundle factory owns its model, graph loop and summarization settings";
    else if ((harness === "codex" || harness === "trae") && field === "maxTokens") reason = "the exec CLI has no per-response output limit setting";
    else if (field === "maxTurns" && ["codex", "trae", "zcode", "simpleagent", "pi", "dsh"].includes(harness)) {
      reason = "the native task loop does not expose a turn limit";
    }
    if (reason) throw new EvaluatorError("CONFIG_INVALID", `${harness} does not allow overriding ${field}: ${reason}`);
  }
}

export function parseAgentOptions(value: unknown, harness: string, extra: readonly string[] = []) {
  const path = `${harness} config`;
  const config = expectRecord(value, path);
  const policy = parseSolverToolPolicy(config, path, [...extra, ...fields]);
  const limits: AgentLimits = {};
  for (const field of fields) {
    if (config[field] !== undefined) limits[field] = expectPositiveInteger(config[field], `${path}.${field}`);
  }
  checkAgentLimits(harness, limits);
  return { ...policy, ...limits };
}

export function modelWithLimits(model: ModelConfig, { maxTokens, contextWindow }: AgentLimits): ModelConfig {
  if (maxTokens === undefined && contextWindow === undefined) return model;
  return { ...model, ...(maxTokens === undefined ? {} : { maxTokens }), ...(contextWindow === undefined ? {} : { contextWindow }) };
}
