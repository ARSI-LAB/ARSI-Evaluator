import { open, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { TrajectoryWriter } from "../../core/artifacts/trajectory.js";
import type { ExitResult, ProcessHandle } from "../../core/contracts/environment.js";
import type { SolveResult } from "../../core/contracts/result.js";
import type { AttemptContext } from "../../core/contracts/solver.js";
import type { JsonValue } from "../../core/contracts/task.js";
import { redactDiagnostic, redactEvidence } from "../../core/errors/diagnostics.js";
import { EvaluatorError } from "../../core/errors/evaluator-error.js";
import { assertJsonValue } from "../../core/validation/input.js";

const MAX_STDOUT_BYTES = 64 * 1024 * 1024;
const MAX_STDERR_BYTES = 1024 * 1024;

export function record(value: JsonValue | undefined): { [key: string]: JsonValue } | undefined {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) return value;
  return undefined;
}

export function tokenCount(value: JsonValue | undefined): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export type CliEvent = Record<string, JsonValue> & { type: string };

function parseEvent(line: string, label: string): CliEvent {
  try {
    const value: unknown = JSON.parse(line);
    assertJsonValue(value);
    const event = record(value);
    if (event && typeof event.type === "string" && event.type !== "") return { ...event, type: event.type };
  } catch {
    // JSON parse errors can embed the unredacted line in their message.
  }
  throw new EvaluatorError("SOLVER_PROTOCOL_INVALID", `${label} stdout contains an invalid JSONL event`);
}

async function readEvents(
  source: ProcessHandle["stdout"],
  label: string,
  accept: (event: CliEvent) => Promise<void>,
): Promise<void> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const decode = (chunk?: Uint8Array) => {
    try { return decoder.decode(chunk, { stream: chunk !== undefined }); }
    catch { throw new EvaluatorError("SOLVER_PROTOCOL_INVALID", `${label} stdout is not valid UTF-8`); }
  };
  let pending = "";
  let bytes = 0;
  for await (const chunk of source) {
    bytes += chunk.byteLength;
    if (bytes > MAX_STDOUT_BYTES) throw new EvaluatorError("SOLVER_OUTPUT_LIMIT", `${label} JSONL exceeds 64 MiB`);
    const lines = (pending + decode(chunk)).split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) await accept(parseEvent(line, label));
  }
  if (pending + decode() !== "") {
    throw new EvaluatorError("SOLVER_PROTOCOL_INVALID", `${label} stdout ended with an incomplete JSONL record`);
  }
}

async function saveStderr(source: ProcessHandle["stderr"], file: FileHandle, secrets: readonly string[], label: string): Promise<string> {
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
  if (bytes > MAX_STDERR_BYTES) await write(`[${label} stderr truncated after 1 MiB]\n`);
  else await write(pending + decoder.end());
  return tail.trim();
}

type CliProtocol = {
  solver: string;
  label: string;
  accept(event: CliEvent): void;
  finish(exit: ExitResult, stderr: string): SolveResult;
};

export async function consumeCliJsonl(
  handle: ProcessHandle, context: AttemptContext, secrets: readonly string[], protocol: CliProtocol,
): Promise<SolveResult> {
  const { signal, paths, key } = context;
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
    await trajectory.append("start", { solver: protocol.solver });
    const sessionLog = session;
    const stdout = readEvents(handle.stdout, protocol.label, async event => {
      const safe = redactEvidence(event, secrets);
      await sessionLog.appendFile(`${JSON.stringify(safe)}\n`, "utf8");
      await trajectory.append(`${protocol.solver}.${redactDiagnostic(event.type, secrets)}`, safe);
      protocol.accept(event);
    });
    const stderrOutput = saveStderr(handle.stderr, stderr, secrets, protocol.label);
    pending = [handle.done, stdout, stderrOutput];
    const [exit, , stderrTail] = await Promise.all([handle.done, stdout, stderrOutput]);
    signal.throwIfAborted();
    const result = protocol.finish(exit, stderrTail);
    let finalText = result.finalText;
    for (const secret of secrets) {
      if (secret) finalText = finalText.replaceAll(secret, "[redacted]").replaceAll(encodeURIComponent(secret), "[redacted]");
    }
    await trajectory.append("usage", result.usage);
    await trajectory.append("end", { status: "completed", finalText }, true);
    return { ...result, finalText };
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
