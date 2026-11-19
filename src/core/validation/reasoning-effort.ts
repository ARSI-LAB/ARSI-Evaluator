import type { ReasoningEffort } from "../contracts/config.js";

export function parseReasoningEffort(value: unknown, path: string): ReasoningEffort {
  switch (value) {
    case "minimal":
    case "low":
    case "medium":
    case "high":
    case "xhigh":
    case "max":
      return value;
    default:
      throw new TypeError(`${path} must be one of minimal, low, medium, high, xhigh, max`);
  }
}

export function validateReasoningEffortApi(effort: ReasoningEffort, api: string | null, path: string): void {
  if (api !== "openai-completions" && api !== "openai-responses" && api !== "anthropic-messages")
    throw new TypeError(`${path} requires openai-completions, openai-responses or anthropic-messages`);
  if (api === "anthropic-messages" && effort === "minimal")
    throw new TypeError(`${path}: anthropic-messages does not accept minimal`);
}
