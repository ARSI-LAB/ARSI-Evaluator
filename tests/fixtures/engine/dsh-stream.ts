import type { ProcessHandle } from "../../../src/core/contracts/environment.js";

export const interruptedResponse = "litellm.APIConnectionError: APIConnectionError: OpenAIException - Response payload is not completed: <TransferEncodingError: 400, message='Not enough data to satisfy transfer length header.'>";

async function* chunks(text: string): AsyncIterable<Uint8Array> {
  if (text) yield Buffer.from(text);
}

export function dshStream(error?: string, final = true): ProcessHandle {
  const records = [
    { type: "session", sessionId: "fixture-session", cwd: "/workspace" },
    { type: "status", phase: "turn_start", turn: 1 },
    { type: "status", phase: "step_start", turn: 1, step: 1 },
    { type: "status", phase: "step_end", turn: 1, step: 1 },
    { type: "status", phase: "turn_end", turn: 1, reason: error === undefined
      ? { kind: "completed" } : { kind: "error", error: { code: "INVALID_REQUEST", message: error } } },
    ...(final ? [{ type: "final", text: error === undefined ? "42" : "" }] : []),
  ];
  return {
    stdout: chunks(records.map(record => JSON.stringify(record)).join("\n") + "\n"),
    stderr: chunks(""),
    done: Promise.resolve({ code: error === undefined ? 0 : 1, signal: null }),
    async stop() {},
  };
}
