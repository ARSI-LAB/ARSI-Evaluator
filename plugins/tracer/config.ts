import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

export type TracerConfig = {
  /** Collector base URL, without a trailing slash. */
  url: string;
  /** Absolute path to the bundled Collector FastAPI entrypoint (app.py). */
  collector: string;
  /** Python interpreter used to start the Collector. */
  python: string;
  /** Persistent SQLite database; reuse requires the running Collector to use this file. */
  db: string;
  /** Persistent spool directory; never deleted by the plugin. */
  spool: string;
  /** Optional Bearer token for the Collector write APIs. */
  token: string;
  /** Start the Collector when no healthy process is reachable. */
  autostart: boolean;
  /** Health probe and startup budget. */
  timeoutMs: number;
};

/** Plugin package root; identical for the source and the bundled dist layout. */
const PLUGIN_ROOT = fileURLToPath(new URL("..", import.meta.url));
/** Bundled Collector entrypoint, so the plugin is self-contained. */
const DEFAULT_COLLECTOR = resolve(PLUGIN_ROOT, "collector", "app.py");
const KNOWN_FIELDS = ["url", "collector", "python", "db", "spool", "token", "autostart", "timeoutMs"];
/** Interpreter candidates, in order, when neither tracer.python nor TRACER_PYTHON is set. */
const PYTHON_CANDIDATES = ["python3", "python"];
/** Versioned binaries, so a system python3 without the Collector dependencies cannot hide a newer install. */
const PYTHON_VERSIONS = ["3.13", "3.12", "3.11", "3.10", "3.9"];
let detectedPython: string | null = null;

/** Active virtualenv/conda interpreter first: an activated environment needs no extra configuration. */
function pythonCandidates(): string[] {
  const win = process.platform === "win32";
  const envs: string[] = [];
  // venv keeps the binary under bin/ (POSIX) or Scripts/ (Windows); conda keeps it at the environment root on Windows
  if (process.env.VIRTUAL_ENV) envs.push(resolve(process.env.VIRTUAL_ENV, win ? "Scripts/python.exe" : "bin/python"));
  if (process.env.CONDA_PREFIX) envs.push(resolve(process.env.CONDA_PREFIX, win ? "python.exe" : "bin/python"));
  return [...envs, ...PYTHON_CANDIDATES, ...PYTHON_VERSIONS.map(version => `python${version}`)];
}

/** First candidate that can import the Collector's dependencies; falls back to python3. */
function detectPython(): string {
  if (detectedPython !== null) return detectedPython;
  for (const candidate of pythonCandidates()) {
    const probe = spawnSync(candidate, ["-c", "import fastapi, uvicorn"], { stdio: "ignore", timeout: 5000 });
    if (!probe.error && probe.status === 0) {
      detectedPython = candidate;
      return candidate;
    }
  }
  const fallback = PYTHON_CANDIDATES[0] ?? "python3";
  detectedPython = fallback;
  return fallback;
}

function expectRecord(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function optionalString(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${path} must be a non-empty string`);
  return value;
}

export function parseTracerConfig(value: unknown): TracerConfig {
  const record = expectRecord(value ?? {}, "tracer store config");
  const unknown = Object.keys(record).find(key => !KNOWN_FIELDS.includes(key));
  if (unknown !== undefined) throw new TypeError(`tracer store config contains unknown field ${unknown}`);

  const rawUrl = optionalString(record.url, "tracer.url") ?? process.env.TRACER_URL ?? "http://127.0.0.1:8787";
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new TypeError(`tracer.url must be an absolute http(s) URL, got ${rawUrl}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new TypeError("tracer.url must use http or https");
  }

  const collector = resolve(optionalString(record.collector, "tracer.collector")
    ?? process.env.TRACER_COLLECTOR ?? DEFAULT_COLLECTOR);
  const db = resolve(optionalString(record.db, "tracer.db") ?? process.env.TRACER_DB ?? resolve(PLUGIN_ROOT, "trace.db"));
  const spool = resolve(optionalString(record.spool, "tracer.spool") ?? process.env.TRACER_SPOOL ?? resolve(PLUGIN_ROOT, "spool"));
  const python = optionalString(record.python, "tracer.python") ?? process.env.TRACER_PYTHON ?? detectPython();
  const token = optionalString(record.token, "tracer.token") ?? process.env.TRACER_TOKEN ?? "";

  if (record.autostart !== undefined && typeof record.autostart !== "boolean") {
    throw new TypeError("tracer.autostart must be a boolean");
  }
  const timeoutMs = record.timeoutMs === undefined ? 30000 : record.timeoutMs;
  if (typeof timeoutMs !== "number" || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError("tracer.timeoutMs must be a positive integer");
  }

  return {
    url: parsed.origin,
    collector,
    python,
    db,
    spool,
    token,
    autostart: record.autostart ?? true,
    timeoutMs,
  };
}