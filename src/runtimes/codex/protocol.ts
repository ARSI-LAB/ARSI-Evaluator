import { open, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { TrajectoryWriter } from "../../core/artifacts/trajectory.js";
import type { ProcessHandle } from "../../core/contracts/environment.js";
import type { SolveResult, Usage } from "../../core/contracts/result.js";
import type { AttemptContext } from "../../core/contracts/solver.js";
import type { JsonValue } from "../../core/contracts/task.js";
import { classifyError } from "../../core/errors/classify.js";
import { redactDiagnostic, redactEvidence } from "../../core/errors/diagnostics.js";
import { EvaluatorError } from "../../core/errors/evaluator-error.js";
import { assertJsonValue } from "../../core/validation/input.js";

const MAX_STDOUT_BYTES = 64 * 1024 * 1024;
const MAX_STDERR_BYTES = 1024 * 1024;

function record(value: JsonValue | undefined): { [key: string]: JsonValue } | undefined {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) return value;
  return undefined;
}

function tokenCount(value: JsonValue | undefined): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function usageFrom(value: JsonValue | undefined): Usage {
  const usage = record(value);
  // Codex reports cached inputs and reasoning outputs as subsets of these counts.
  const inputTokens = tokenCount(usage?.input_tokens);
  const outputTokens = tokenCount(usage?.output_tokens);
  const total = inputTokens === null || outputTokens === null ? null : inputTokens + outputTokens;
  return { inputTokens, outputTokens, totalTokens: tokenCount(total) };
}

function parseEvent(line: string) {
  try {
    const value: unknown = JSON.parse(line);
    assertJsonValue(value);
    const event = record(value);
    if (event && typeof event.type === "string" && event.type !== "") return event;
  } catch {
    // JSON parse errors can embed the unredacted line in their message.
  }
  throw new EvaluatorError("SOLVER_PROTOCOL_INVALID", "Codex stdout contains an invalid JSONL event");
}

async function readEvents(
  source: ProcessHandle["stdout"],
  accept: (event: ReturnType<typeof parseEvent>) => Promise<void>,
): Promise<void> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const decode = (chunk?: Uint8Array) => {
    try { return decoder.decode(chunk, { stream: chunk !== undefined }); }
    catch { throw new EvaluatorError("SOLVER_PROTOCOL_INVALID", "Codex stdout is not valid UTF-8"); }
  };
  let pending = "";
  let bytes = 0;
  for await (const chunk of source) {
    bytes += chunk.byteLength;
    if (bytes > MAX_STDOUT_BYTES) throw new EvaluatorError("SOLVER_OUTPUT_LIMIT", "Codex JSONL exceeds 64 MiB");
    const lines = (pending + decode(chunk)).split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) await accept(parseEvent(line));
  }
  if (pending + decode() !== "") {
    throw new EvaluatorError("SOLVER_PROTOCOL_INVALID", "Codex stdout ended with an incomplete JSONL record");
  }
}

async function saveStderr(source: ProcessHandle["stderr"], file: FileHandle, secrets: string[]): Promise<string> {
  const decoder = new StringDecoder("utf8");
  let pending = "";
  let bytes = 0;
  let tail = "";
  const write = async (text: string) => {
    const safe = redactDiagnostic(text, secrets);
    tail = (tail + safe).slice(-4096);
    await file.appendFile(safe, "utf8");
  };
  for await (const chunk of source) {
    bytes += chunk.byteLength;
    if (bytes > MAX_STDERR_BYTES) continue;
    pending += decoder.write(Buffer.from(chunk));
    const newline = pending.lastIndexOf("\n");
    if (newline < 0) continue;
    await write(pending.slice(0, newline + 1));
    pending = pending.slice(newline + 1);
  }
  if (bytes > MAX_STDERR_BYTES) await write("[Codex stderr truncated after 1 MiB]\n");
  else await write(pending + decoder.end());
  return tail.trim();
}

export async function consumeCodex(handle: ProcessHandle, context: AttemptContext, secret: string): Promise<SolveResult> {
  const { signal, paths, key } = context;
  const secrets = [secret];
  const trajectory = new TrajectoryWriter(join(paths.agent, "trajectory.jsonl"), key);
  let session: FileHandle | undefined;
  let stderr: FileHandle | undefined;
  let pending: Promise<unknown>[] = [handle.done];
  // Observe rejection even if opening the attempt's evidence fails or takes time.
  void handle.done.catch(() => {});
  let stopping: Promise<void> | undefined;
  const stop = () => stopping ??= handle.stop(500).catch(() => {});
  const onAbort = () => { void stop(); };
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) onAbort();
  try {
    session = await open(join(paths.agent, "session.jsonl"), "a", 0o600);
    stderr = await open(join(paths.agent, "stderr.log"), "a", 0o600);
    await trajectory.append("start", { solver: "codex" });
    const sessionLog = session;
    let finalText = "";
    let terminal: "turn.completed" | "turn.failed" | undefined;
    let usage = usageFrom(undefined);
    let diagnostic = "";
    const stdout = readEvents(handle.stdout, async event => {
      const safe = redactEvidence(event, secrets);
      await sessionLog.appendFile(`${JSON.stringify(safe)}\n`, "utf8");
      const type = String(event.type);
      await trajectory.append(`codex.${redactDiagnostic(type, secrets)}`, safe);
      if (type === "item.completed") {
        const item = record(event.item);
        if (item?.type === "agent_message" && typeof item.text === "string") {
          // Keep the answer's exact formatting for scoring.
          finalText = item.text.replaceAll(secret, "[redacted]").replaceAll(encodeURIComponent(secret), "[redacted]");
        }
      }
      if (type === "turn.started" || type.startsWith("item.")) context.activity?.({});
      if (type === "error" || type === "turn.failed") {
        const message = record(event.error)?.message ?? event.message;
        if (typeof message === "string") diagnostic = redactDiagnostic(message, secrets);
      }
      if (type === "turn.completed" || type === "turn.failed") {
        if (terminal !== undefined) throw new EvaluatorError("SOLVER_PROTOCOL_INVALID", "Codex emitted multiple terminal turn events");
        terminal = type;
        if (type === "turn.completed") usage = usageFrom(event.usage);
      }
    });
    const stderrOutput = saveStderr(handle.stderr, stderr, secrets);
    pending = [handle.done, stdout, stderrOutput];
    const [exit, , stderrTail] = await Promise.all([handle.done, stdout, stderrOutput]);
    signal.throwIfAborted();
    if (terminal === "turn.failed" || exit.code !== 0 || exit.signal !== null) {
      const message = diagnostic || stderrTail || `Codex exited with code ${exit.code} and signal ${exit.signal}`;
      const fallbackCode = terminal === "turn.failed" ? "SOLVER_RESULT_INCOMPLETE" : "SOLVER_PROCESS_CRASHED";
      const failure = classifyError(new Error(message), { phase: "solve", component: "codex", fallbackCode });
      throw new EvaluatorError(failure.code, failure.message, failure.details);
    }
    if (terminal !== "turn.completed") {
      throw new EvaluatorError("SOLVER_RESULT_INCOMPLETE", "Codex exited without completing its turn");
    }
    await trajectory.append("usage", usage);
    await trajectory.append("end", { status: "completed", finalText }, true);
    return { finalText, usage };
  } catch (error) {
    await stop();
    await Promise.allSettled(pending);
    const failure = signal.aborted ? signal.reason : error;
    const message = redactDiagnostic(failure instanceof Error ? failure.message : String(failure), secrets);
    await trajectory.append("error", { message }, true).catch(() => {});
    throw failure;
  } finally {
    signal.removeEventListener("abort", onAbort);
    await Promise.all([session?.close(), stderr?.close(), trajectory.close()]);
  }
}
