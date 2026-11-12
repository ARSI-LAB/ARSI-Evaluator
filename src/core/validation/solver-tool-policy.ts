import { EvaluatorError } from "../errors/evaluator-error.js";
import { expectNonEmptyString, expectRecord, rejectUnknown } from "./input.js";

type WebToolMode = "default" | "disabled" | "enabled";
export type SolverToolPolicy = {
  tools?: "default" | "none";
  webSearch?: WebToolMode;
  webFetch?: WebToolMode;
};
export type WebToolNames = { webSearchTools?: string[]; webFetchTools?: string[] };
export const SOLVER_TOOL_FIELDS = ["tools", "webSearch", "webFetch"] as const;

export function parseSolverToolPolicy(
  value: unknown, path: string, extra: readonly string[] = [],
): SolverToolPolicy {
  const config = expectRecord(value, path);
  rejectUnknown(config, [...SOLVER_TOOL_FIELDS, ...extra], path);
  const { tools, webSearch, webFetch } = config;
  if (tools !== undefined && tools !== "default" && tools !== "none") {
    throw new TypeError(`${path}.tools must be default or none`);
  }
  for (const [key, mode] of [["webSearch", webSearch], ["webFetch", webFetch]] as const) {
    if (mode !== undefined && mode !== "default" && mode !== "disabled" && mode !== "enabled") {
      throw new TypeError(`${path}.${key} must be default, disabled or enabled`);
    }
  }
  if (tools === "none" && (webSearch === "enabled" || webFetch === "enabled")) {
    throw new TypeError(`${path}.tools: none conflicts with enabled web tools`);
  }
  return {
    ...(tools === "none" ? { tools } : {}),
    ...(webSearch === "disabled" || webSearch === "enabled" ? { webSearch } : {}),
    ...(webFetch === "disabled" || webFetch === "enabled" ? { webFetch } : {}),
  };
}

export function parseWebToolNames(value: Record<string, unknown>, path: string): WebToolNames {
  const result: WebToolNames = {};
  for (const key of ["webSearchTools", "webFetchTools"] as const) {
    const names = value[key];
    if (names === undefined) continue;
    if (!Array.isArray(names) || names.length === 0) {
      throw new TypeError(`${path}.${key} must be a non-empty array of tool names`);
    }
    const parsed = names.map(name => expectNonEmptyString(name, `${path}.${key}`));
    if (parsed.some(name => !/^[A-Za-z0-9_.:-]+$/u.test(name)) || new Set(parsed).size !== parsed.length) {
      throw new TypeError(`${path}.${key} must contain unique exact tool names`);
    }
    result[key] = parsed;
  }
  return result;
}

export function unsupportedToolPolicy(solver: string, reason: string): never {
  throw new EvaluatorError("CONFIG_INVALID", `${solver}: ${reason}`);
}

export function toolPolicyProvenance(policy: SolverToolPolicy, method: string): Record<string, string> {
  return Object.keys(policy).length === 0 ? {} : {
    toolPolicyMethod: method,
    tools: policy.tools ?? "default",
    webSearch: policy.tools === "none" ? "disabled" : policy.webSearch ?? "default",
    webFetch: policy.tools === "none" ? "disabled" : policy.webFetch ?? "default",
  };
}
