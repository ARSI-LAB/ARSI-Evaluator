import { parse } from "@iarna/toml";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join, posix, resolve } from "node:path";

import {
  buildFileManifest,
  fingerprintConfig,
  validateStateProfile,
  HarborShellVerifier,
  planBenchmarkRun,
  GitBlobCache,
  parseGitTree,
  writeGitFile,
  checkedPath,
} from "ember-evaluator";
import type {
  Benchmark,
  EnvironmentSession,
  EnvironmentSpec,
  JsonValue,
  PreparedTask,
  SolveResult,
  SourceLock,
  TaskRef,
  VerifyResult,
  GitTreeEntry,
} from "ember-evaluator";
import { expectNonEmptyString, expectRecord, parseRepositoryConfig, rejectUnknown, REPOSITORY_PATTERN } from "./config.js";

const COMMIT_PATTERN = /^[a-f0-9]{40}$/u;

export type DocOpsConfig = {
  repository: string;
  revision: string;
  cacheDir: string;
};

export type DocOpsTransport = {
  apiBase: string;
  rawBase: string;
};

type DocOpsDocument = {
  schemaVersion: string;
  task: Record<string, unknown>;
  verifier: Record<string, unknown>;
  environment: Record<string, unknown>;
};

type DocOpsMetadata = {
  repository: string;
  requestedRevision: string;
  commit: string;
  taskIds: string[];
};

const defaultTransport: DocOpsTransport = {
  apiBase: "https://api.github.com",
  rawBase: "https://raw.githubusercontent.com",
};

function table(value: unknown, path: string): Record<string, unknown> {
  if (value === undefined) return {};
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${path} must be a table`);
  return value as Record<string, unknown>;
}
function positiveNumber(value: unknown, fallback: number, path: string): number {
  const selected = value ?? fallback;
  if (typeof selected !== "number" || !Number.isFinite(selected) || selected <= 0) throw new TypeError(`${path} must be a positive number`);
  return selected;
}

function positiveInteger(value: unknown, path: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${path} must be a positive integer`);
  return value;
}

function encodedPath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

function commitFromResponse(value: unknown): string {
  if (!value || typeof value !== "object" || !("sha" in value) || typeof value.sha !== "string" || !COMMIT_PATTERN.test(value.sha)) {
    throw new TypeError("Invalid DocOps GitHub commit response");
  }
  return value.sha;
}

function metadata(source: SourceLock): DocOpsMetadata {
  const value = source.metadata;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid DocOps source metadata");
  const { repository, requestedRevision, commit, taskIds } = value;
  if (typeof repository !== "string" || !REPOSITORY_PATTERN.test(repository) || typeof requestedRevision !== "string" ||
      typeof commit !== "string" || !COMMIT_PATTERN.test(commit) || !Array.isArray(taskIds) ||
      taskIds.some(id => typeof id !== "string" || !id)) throw new Error("Invalid DocOps source metadata");
  return { repository, requestedRevision, commit, taskIds: [...taskIds] as string[] };
}

function taskIdsFromTree(tree: readonly GitTreeEntry[]): string[] {
  const ids = new Set<string>();
  for (const entry of tree) {
    const match = /^tasks\/([^/]+)\/task\.toml$/u.exec(entry.path);
    if (match && entry.type === "blob") ids.add(match[1]!);
  }
  const result = [...ids].sort();
  if (!result.length) throw new Error("DocOps repository contains no task directories");
  return result;
}

async function readDocOpsDocument(taskDir: string): Promise<DocOpsDocument> {
      const document = parse(await readFile(await checkedPath(taskDir, "task.toml"), "utf8")) as Record<string, unknown>;
  if (document.schema_version !== "1.1") throw new TypeError("DocOps task schema_version must equal 1.1");
  const task = table(document.task, "task");
  expectNonEmptyString(task.name, "task.name");
  return { schemaVersion: document.schema_version, task, verifier: table(document.verifier, "verifier"), environment: table(document.environment, "environment") };
}

export function parseDocOpsConfig(value: unknown): DocOpsConfig {
  const config = expectRecord(value, "docops");
  rejectUnknown(config, ["repository", "revision", "cacheDir"], "docops");
  const { repository, revision } = parseRepositoryConfig(config, "docops");
  return { repository, revision, cacheDir: expectNonEmptyString(config.cacheDir ?? ".cache/docops", "docops.cacheDir") };
}

export class DocOpsBenchmark implements Benchmark {
  readonly planRun: NonNullable<Benchmark["planRun"]> = (refs, source, signal, activity) =>
    planBenchmarkRun(this, refs, source, signal,
      { version: "docops-preparation-v2", source: "DocOpsBenchmark:declared-build-timeouts" }, 600, activity);
  private readonly verifier = new HarborShellVerifier();
  private readonly cache: GitBlobCache;
  private readonly cacheDir: string;

  constructor(private readonly config: DocOpsConfig, private readonly transport: DocOpsTransport = defaultTransport) {
    this.cacheDir = resolve(config.cacheDir);
    this.cache = new GitBlobCache(this.cacheDir);
  }

  private commitUrl(revision: string): string {
    return `${this.transport.apiBase}/repos/${this.config.repository}/commits/${encodeURIComponent(revision)}`;
  }

  private treeUrl(commit: string): string {
    return `${this.transport.apiBase}/repos/${this.config.repository}/git/trees/${commit}?recursive=1`;
  }

  private async lockedTree(source: SourceLock, signal: AbortSignal): Promise<GitTreeEntry[]> {
    const details = metadata(source);
    if (source.source !== "docops" || details.repository !== this.config.repository || details.requestedRevision !== this.config.revision || source.revision !== details.commit) {
      throw new Error("DocOps source lock does not match configuration");
    }
    const treeFile = source.files.find(file => file.path === `trees/${details.commit}.json`);
    if (source.files.length !== 1 || !treeFile || treeFile.origin !== this.treeUrl(details.commit)) throw new Error("Invalid locked DocOps tree inventory");
    const object = await this.cache.bytes.fetch(treeFile.origin, treeFile.sha256, signal);
    const tree = parseGitTree(JSON.parse(await readFile(object.path, "utf8")));
    if (JSON.stringify(taskIdsFromTree(tree)) !== JSON.stringify(details.taskIds)) throw new Error("DocOps task inventory differs from the locked source");
    return tree;
  }

  async resolveSource(previous: SourceLock | null, signal: AbortSignal): Promise<SourceLock> {
    signal.throwIfAborted();
    if (previous) {
      await this.lockedTree(previous, signal);
      return structuredClone(previous);
    }
    const resolved = await this.cache.bytes.fetch(this.commitUrl(this.config.revision), null, signal);
    const commit = commitFromResponse(JSON.parse(await readFile(resolved.path, "utf8")));
    const treeOrigin = this.treeUrl(commit);
    const treeObject = await this.cache.bytes.fetch(treeOrigin, null, signal);
    const tree = parseGitTree(JSON.parse(await readFile(treeObject.path, "utf8")));
    const taskIds = taskIdsFromTree(tree);
    return {
      source: "docops",
      revision: commit,
      files: [{ path: `trees/${commit}.json`, origin: treeOrigin, sha256: treeObject.sha256 }],
      metadata: { repository: this.config.repository, requestedRevision: this.config.revision, commit, taskIds },
    };
  }

  async *enumerate(source: SourceLock, signal: AbortSignal): AsyncIterable<TaskRef> {
    await this.lockedTree(source, signal);
    for (const id of metadata(source).taskIds) {
      signal.throwIfAborted();
      yield { id, recordKey: id };
    }
  }

  async prepare(ref: TaskRef, source: SourceLock, signal: AbortSignal): Promise<PreparedTask> {
    const details = metadata(source);
    if (typeof ref.recordKey !== "string" || ref.recordKey !== ref.id || !details.taskIds.includes(ref.id)) throw new Error("Invalid DocOps task reference");
    const tree = await this.lockedTree(source, signal);
    const prefix = `tasks/${ref.id}/`;
    const entries = tree.filter(entry => entry.path.startsWith(prefix) && entry.type !== "tree");
    if (!entries.length || entries.some(entry => entry.type !== "blob" || !["100644", "100755"].includes(entry.mode))) {
      throw new Error(`DocOps task contains unsupported links or submodules: ${ref.id}`);
    }
    const preparedRoot = join(this.cacheDir, "prepared");
    await mkdir(preparedRoot, { recursive: true });
    const identity = fingerprintConfig({ repository: details.repository, commit: details.commit, taskId: ref.id } as unknown as JsonValue);
    const taskDir = await mkdtemp(join(preparedRoot, `${identity.slice(0, 16)}-`));
    try {
      for (const entry of entries) {
        signal.throwIfAborted();
        const relative = entry.path.slice(prefix.length);
        const origin = `${this.transport.rawBase}/${details.repository}/${details.commit}/${encodedPath(entry.path)}`;
        const bytes = await this.cache.blob(origin, entry.sha, signal);
        await writeGitFile(taskDir, relative, bytes, entry.mode === "100755", signal);
      }
      const document = await readDocOpsDocument(taskDir);
      const instruction = await readFile(await checkedPath(taskDir, "instruction.md"), "utf8");
      if (!instruction.trim()) throw new TypeError("DocOps instruction.md must not be empty");
      const testsDir = await checkedPath(taskDir, "tests");
      await readFile(await checkedPath(taskDir, "tests/test.sh"));
      const environmentDir = await checkedPath(taskDir, "environment");
      await readFile(await checkedPath(taskDir, "environment/Dockerfile"));
      const environmentManifest = await buildFileManifest(environmentDir, []);
      if (environmentManifest.missing.length) throw new Error("DocOps environment contains unsafe or unreadable entries");

      const environmentVariables = table(document.environment.env, "environment.env");
      const outputPath = expectNonEmptyString(environmentVariables.OUTPUT_PATH, "environment.env.OUTPUT_PATH");
      if (!posix.isAbsolute(outputPath) || posix.normalize(outputPath) !== outputPath || outputPath.endsWith("/")) throw new TypeError("environment.env.OUTPUT_PATH must be a normalized absolute file path");
      const outputRoot = posix.dirname(outputPath);
      validateStateProfile({ workdir: outputRoot, extraPaths: [] });
      if (document.environment.allow_internet === false) throw new TypeError("DocOps tasks requiring disabled internet are unsupported");
      const mcpServers = document.environment.mcp_servers;
      if (mcpServers !== undefined && (!Array.isArray(mcpServers) || mcpServers.length > 0)) throw new TypeError("DocOps MCP servers are unsupported");

      const cpus = positiveNumber(document.environment.cpus, 1, "environment.cpus");
      const memoryMb = positiveInteger(document.environment.memory_mb, "environment.memory_mb");
      const storageMb = positiveInteger(document.environment.storage_mb, "environment.storage_mb");
      const resources: NonNullable<EnvironmentSpec["resources"]> = {
        cpus,
        ...(memoryMb === undefined ? {} : { memory: `${memoryMb}M` }),
        ...(storageMb === undefined ? {} : { storage: `${storageMb}M` }),
      };
      const environment: EnvironmentSpec = {
        workdir: outputRoot,
        image: null,
        initialFiles: [],
        runtime: [],
        resources,
        build: { context: environmentDir, dockerfile: "Dockerfile", sourceHash: fingerprintConfig(environmentManifest.files as unknown as JsonValue) },
      };
      const timeoutSeconds = positiveNumber(document.verifier.timeout_sec, 300, "verifier.timeout_sec");
      const buildTimeoutSeconds = positiveNumber(document.environment.build_timeout_sec, 600, "environment.build_timeout_sec");
      return {
        input: { id: ref.id, prompt: instruction },
        preparationTimeoutSeconds: { solve: buildTimeoutSeconds, verify: buildTimeoutSeconds },
        verification: { descriptor: await this.verifier.prepare({ id: ref.id, taskDir, datasetDir: taskDir, workdir: outputRoot, timeoutSeconds }, signal), env: {} },
        solveEnv: environment,
        verifyEnv: structuredClone(environment),
        transfer: { kind: "workspace-archive", workdir: outputRoot, extraPaths: [] },
      };
    } catch (error) {
      await rm(taskDir, { recursive: true, force: true });
      throw error;
    }
  }

  async verify(task: PreparedTask, _result: SolveResult, session: EnvironmentSession | null, signal: AbortSignal): Promise<VerifyResult> {
    if (!session) throw new Error("DocOps verification requires an environment");
    const evidence = await this.verifier.verify(task.verification, session, signal);
    const score = evidence.rewards.reward;
    if (score === undefined) throw new Error("DocOps verifier has no reward");
    return { score, passed: score >= 1, details: { rewards: evidence.rewards, evidence: evidence.details } };
  }
}
