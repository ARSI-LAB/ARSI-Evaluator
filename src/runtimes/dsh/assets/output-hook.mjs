import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fchownSync, lstatSync, mkdirSync, openSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { isAbsolute, join } from "node:path";

const MAX_STRING_BYTES = 8 * 1024;
const MAX_EVENT_BYTES = 32 * 1024;
const handlerKey = Symbol.for("ember.evaluator.dsh.tool-output.v1");
const streamKey = Symbol.for("ember.evaluator.dsh.provider-output.v1");

/** Model capability metadata is not an explicit per-request output ceiling. */
export function streamWithProviderOutput(owner, model, context, options, selected) {
  if (selected === undefined || selected.provider !== model.provider || selected.model !== model.id ||
      model.api !== "openai-completions" || options.maxTokens !== undefined)
    return owner.streamSimple(model, context, options);
  return owner.streamSimple(model, context, { ...options, onPayload: async (payload, ...args) => {
    const adjusted = await options.onPayload?.(payload, ...args) ?? payload;
    if (!adjusted || typeof adjusted !== "object" || Array.isArray(adjusted)) return adjusted;
    const copy = { ...adjusted };
    delete copy.max_tokens;
    delete copy.max_completion_tokens;
    return copy;
  } });
}

export function adaptProviderOutputSource(source) {
  const seam = "snapshot.models.streamSimple(model, context, {";
  if (source.split(seam).length !== 2) throw new Error("Unsupported DSH pi-ai adapter: unique streamSimple entry not found");
  return source.replace(seam, `globalThis[Symbol.for(${JSON.stringify(Symbol.keyFor(streamKey))})](snapshot.models, model, context, {`);
}

function redact(text, secret) {
  if (!secret) return text;
  for (const value of new Set([secret, encodeURIComponent(secret)])) text = text.replaceAll(value, "[redacted]");
  return text;
}

function preview(bytes, maximum) {
  if (bytes.length <= maximum) return bytes.toString("utf8");
  let head = Math.ceil(maximum / 2);
  let tail = bytes.length - (maximum - head);
  while (head > 0 && (bytes[head] & 0xc0) === 0x80) head--;
  while (tail < bytes.length && (bytes[tail] & 0xc0) === 0x80) tail++;
  return `${bytes.subarray(0, head).toString("utf8")}\n[preview truncated; see resultRef]\n${bytes.subarray(tail).toString("utf8")}`;
}

/** Serialize the exported copy only; the Session's model-facing object is untouched. */
export function serializeToolResult(event, outputDir, secret = "") {
  if (typeof event.callId !== "string" || !event.callId ||
      (event.status !== "completed" && event.status !== "error") || typeof event.result !== "string") {
    throw new Error("DSH tool output export requires callId, status and a text result");
  }
  const result = redact(event.result, secret);
  const record = { type: "tool_result", callId: event.callId, status: event.status, result };
  if (Buffer.byteLength(result) <= MAX_STRING_BYTES) {
    const line = JSON.stringify(record);
    if (Buffer.byteLength(line) + 1 <= MAX_EVENT_BYTES) return line;
  }
  if (typeof outputDir !== "string" || !isAbsolute(outputDir)) throw new Error("DSH tool output directory must be absolute");
  const owner = lstatSync(outputDir);
  if (owner.isSymbolicLink()) throw new Error("DSH tool output root cannot be a symlink");
  const directory = join(outputDir, "tool-outputs");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (lstatSync(directory).isSymbolicLink()) throw new Error("DSH tool output directory cannot be a symlink");
  const bytes = Buffer.from(result, "utf8");
  const name = `${randomUUID()}.txt`;
  // Persist before publishing the reference. Never overwrite another call's evidence.
  if (process.getuid?.() === 0 && owner.uid !== 0) {
    // The coordinator verifies referenced files while DSH is still running.
    // Hand off only our private export, before publishing its reference, and
    // keep 0700/0600 permissions. The descriptor cannot follow a replaced link.
    const parent = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      fchownSync(parent, owner.uid, owner.gid);
      const file = openSync(`/proc/self/fd/${parent}/${name}`, "wx", 0o600);
      try { writeFileSync(file, bytes); fchownSync(file, owner.uid, owner.gid); }
      finally { closeSync(file); }
    } finally { closeSync(parent); }
  } else writeFileSync(join(directory, name), bytes, { flag: "wx", mode: 0o600 });
  const summary = {
    ...record,
    truncated: true,
    originalBytes: Buffer.byteLength(event.result, "utf8"),
    storedBytes: bytes.length,
    resultRef: `agent/tool-outputs/${name}`,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
  let previewBytes = Math.min(4096, bytes.length);
  while (true) {
    summary.result = preview(bytes, previewBytes);
    const bounded = JSON.stringify(summary);
    if (Buffer.byteLength(JSON.stringify(summary.result)) <= MAX_STRING_BYTES &&
        Buffer.byteLength(bounded) + 1 <= MAX_EVENT_BYTES) return bounded;
    if (previewBytes <= 2) throw new Error("DSH tool result metadata exceeds the JSON event limit");
    previewBytes = Math.max(2, Math.floor(previewBytes / 2));
  }
}

/** DSH observer failures are otherwise swallowed while the Agent keeps running. */
export function serializeToolResultOrError(event, outputDir, secret = "") {
  try { return serializeToolResult(event, outputDir, secret); }
  catch (error) {
    const errno = error && typeof error === "object" && typeof error.code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/u.test(error.code)
      ? error.code : "EXPORT_FAILED";
    const detail = redact(error instanceof Error ? error.message : "Unknown tool output export failure", secret);
    return JSON.stringify({ type: "error", message: `DSH tool output export failed (${errno}): ${preview(Buffer.from(detail), 1024)}` });
  }
}

const outputDir = process.env.EVALUATOR_DSH_OUTPUT_DIR;
const providerOutput = process.env.EVALUATOR_DSH_PROVIDER_OUTPUT;
if (outputDir !== undefined || providerOutput !== undefined) {
  const secret = process.env.EMBER_EVALUATOR_API_KEY ?? "";
  const selected = providerOutput === undefined ? undefined : JSON.parse(providerOutput);
  if (selected !== undefined && (!selected || typeof selected.provider !== "string" || typeof selected.model !== "string"))
    throw new Error("Invalid DSH provider output binding");
  // PATH shims require NODE_OPTIONS to preload in their child Node process.
  // Remove only our option before DSH launches tools; retain other Node options.
  const option = `--import=${import.meta.url}`;
  if (process.env.NODE_OPTIONS?.includes(option)) process.env.NODE_OPTIONS = process.env.NODE_OPTIONS.replace(option, "").trim();
  Object.defineProperty(globalThis, handlerKey, { value: event => serializeToolResultOrError(event, outputDir, secret) });
  Object.defineProperty(globalThis, streamKey, { value: (owner, model, context, options) =>
    streamWithProviderOutput(owner, model, context, options, selected) });
  registerHooks({
    load(url, context, nextLoad) {
      const loaded = nextLoad(url, context);
      const pathname = new URL(url).pathname;
      const adapter = /\/@deepseek-ai\/dsh-llm-pi-ai\/lib\/index\.js$/u.test(pathname) ||
        /\/packages\/llm\/llm-pi-ai\/(?:src|lib)\/adapter\.[jt]s$/u.test(pathname);
      if (selected !== undefined && adapter) {
        const source = typeof loaded.source === "string" ? loaded.source : Buffer.from(loaded.source).toString("utf8");
        return { ...loaded, source: adaptProviderOutputSource(source) };
      }
      const headless = /\/@deepseek-ai\/dsh-headless\/lib\/json-stream(?:-[^/]+)?\.js$/u.test(pathname) ||
        /\/packages\/bundle\/headless\/(?:src|lib)\/json-stream\.[jt]s$/u.test(pathname);
      if (!headless) return loaded;
      const source = typeof loaded.source === "string" ? loaded.source : Buffer.from(loaded.source).toString("utf8");
      const signature = /function boundJsonLine\(\s*event\b[^{}]*?\)\s*(?::\s*string\s*)?\{/u;
      if (!signature.test(source)) throw new Error("Unsupported DSH headless JSON exporter: boundJsonLine entry not found");
      return { ...loaded, source: source.replace(signature, match =>
        `${match}\nif (event.type === "tool_result") return globalThis[Symbol.for(${JSON.stringify(Symbol.keyFor(handlerKey))})](event);`) };
    },
  });
}
