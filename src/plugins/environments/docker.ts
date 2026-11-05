import { NetworkRuntime } from "../../adapters/network/runtime.js";
import type { NetworkAccess } from "../../core/contracts/network.js";
import { declaredErrorCode } from "../../core/errors/classify.js";
import type { ErrorCode } from "../../core/errors/registry.js";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { dockerBuildNetwork } from "../../adapters/containers/build-network.js";
import { constants } from "node:fs";
import { access, chmod, cp, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { removeDockerContainer, stopDockerContainer } from "./docker-cleanup.js";
import { captureDockerLogOwnership, makeDockerLogsWritable, restoreDockerLogOwnership } from "./docker-log-ownership.js";
import { dockerExecutionOwner, ownDockerRuntimeUpload, type DockerExecutionOwner } from "./docker-runtime-upload.js";
import { assertDockerCapacity, readDockerCapacity, type DockerCapacity } from "./docker-resources.js";
import { applyBuildPipConstraints, parseBuildPipConstraints } from "../../adapters/containers/pip-constraints.js";
import { readDirectoryModes, restoreDirectoryModes } from "../../adapters/filesystem/directory-modes.js";
import { createDockerImagePuller, type DockerImagePull } from "./docker-image-pull.js";
import { DockerTaskArchive } from "./docker-task-archive.js";
import { dockerImageName, type DockerImageScope } from "./docker-image-name.js";
import { resolvePinnedTaskImage } from "./docker-base-image.js";
import { dockerActivity, observeDockerCommand, withDockerActivity } from "./docker-progress.js";
import type { ActivityListener } from "../../core/contracts/activity.js";
import { constrainDockerCpus, cpuBudgetNodeOptions, cpuCountForBudget } from "./docker-cpu.js";

import type {
  ContainerPlatform,
  CommandSpec,
  Environment,
  EnvironmentSession,
  EnvironmentSpec,
  EnvironmentPreparationTimings,
  EnvironmentImageReady,
  EnvironmentPreparationContext,
  PreparationCacheSource,
  ModelEndpointMapping,
  ProcessHandle,
  RuntimeInstallation,
  RuntimeRequirement,
  RuntimeLocation,
  TransferArtifact,
  TransferSpec,
} from "../../core/contracts/environment.js";
import type { AttemptKey, AttemptPaths } from "../../core/contracts/result.js";
import type { JsonValue } from "../../core/contracts/task.js";
import { validateNetworkPolicy } from "../../core/network-policy.js";
import { EGRESS_PROXY_ENV } from "./egress-proxy.js";
import { buildFileManifest } from "../../core/artifacts.js";
import { fingerprintConfig } from "../../core/run-manifest.js";
import { startDockerProcess } from "./docker-process.js";
import { recoverDockerAttempts } from "./docker-recovery.js";
import { DockerBuildCache } from "./docker-build-cache.js";
import { DOCKER_PLATFORM, DockerRuntime, EVALUATOR_NODE_EXECUTABLE, PROCESS_HELPER, type DockerCommand, type PreparedRuntimeImage } from "./docker-runtime.js";
import { PlatformCapabilityDetector, parseDockerPlatform, parseDockerEmulation, resolveDockerPlatform, nodePlatform, type DockerPlatformSelection, type PlatformResolution } from "./docker-platform.js";
import { DockerSolverRuntime } from "./docker-solver-runtime.js";
import { DockerComposeProject, recoverComposeNetworks } from "./docker-compose.js";
import { platformImageCommand } from "./docker-image-inspect.js";
import { DockerImageInventory } from "./docker-image-inventory.js";
import { waitTaskHealth } from "./docker-healthcheck.js";
import { validateTransferSpec } from "./workspace-transfer.js";
import { exportGitPatch, restoreGitPatch } from "./git-patch.js";
import {
  GATEWAY_SOCKET_TARGET,
  MODEL_FORWARDER_PORT,
  cleanupGatewayVolumes,
  createModelGateway,
  gatewayProxyEnv,
  dockerHostModelEndpoint,
  parseModelEndpointPolicy,
  startModelForwarder,
  type GatewayHandle,
} from "./model-gateway.js";
import { exportWorkspace, restoreWorkspace, RESERVED_STATE_ROOTS } from "./workspace-transfer.js";
import { classifyError } from "../../core/errors/classify.js";
import { EvaluatorError } from "../../core/errors/evaluator-error.js";

const DOCKER_OUTPUT_LIMIT = 4 * 1024 * 1024;
const PROCESS_STOP_GRACE_MS = 500;
// Direct egress to pypi.org/deb.debian.org is unreliable on CN networks, so the
// Task builds receive explicit per-run network settings.


export class DockerEnvironmentError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    cause?: unknown,
    public readonly containerId: string | null = null,
  ) {
    super(`${code}: ${message}`, { cause });
    this.name = "DockerEnvironmentError";
  }
}

export function parseDockerContainerEnv(value: unknown = {}): Record<string, string> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("docker containerEnv must be an object of strings");
  const entries = Object.entries(value);
  for (const [key, item] of entries) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) || typeof item !== "string" || item.includes("\0"))
      throw new TypeError("docker containerEnv must contain valid environment names and string values without NUL");
  }
  return Object.fromEntries(entries);
}

export function parseDockerImageOverrides(value: unknown = {}): Record<string, string> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("docker imageOverrides must be an object of image references");
  const entries = Object.entries(value);
  for (const [source, target] of entries) {
    if (!source || /[\s\0]/u.test(source) || typeof target !== "string" || !target || /[\s\0]/u.test(target))
      throw new TypeError("docker imageOverrides must map non-empty image references without whitespace or NUL");
  }
  return Object.fromEntries(entries);
}

function abortError(): Error {
  return new DOMException("The operation was aborted", "AbortError");
}
function errno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

type ChildOutcome = { code: number | null; signal: NodeJS.Signals | null };

// On Windows, plugin commands such as `docker build` run in a CLI plugin
// process (docker-buildx.exe) started by docker.exe. Killing only docker.exe
// leaves the plugin building with the inherited pipes, so kill the whole tree.
function killDockerClient(child: ChildProcess): Promise<void> {
  if (process.platform !== "win32" || child.pid === undefined) {
    child.kill("SIGKILL");
    return Promise.resolve();
  }
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows";
  const taskkill = join(systemRoot, "System32", "taskkill.exe");
  return new Promise(resolve => {
    execFile(taskkill, ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, timeout: 5_000 }, error => {
      if (error) child.kill("SIGKILL");
      resolve();
    });
  });
}

export async function runDockerCommand(
  dockerExecutable: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; input?: Uint8Array | null; signal?: AbortSignal; maxBuffer?: number;
    onOutput?: (stream: "stdout" | "stderr", chunk: Uint8Array) => void } = {},
): Promise<{ stdout: string; stderr: string }> {
  options.signal?.throwIfAborted();
  const child = spawn(dockerExecutable, args, { env: options.env ?? process.env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, shell: false });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let observationFailure: unknown;
  let observationFailed = false;
  const notify = (stream: "stdout" | "stderr", chunk: Uint8Array) => {
    if (observationFailed) return;
    try { options.onOutput?.(stream, chunk); } catch (error) {
      observationFailed = true; observationFailure = error;
      void killDockerClient(child);
    }
  };
  const limit = options.maxBuffer ?? DOCKER_OUTPUT_LIMIT;
  const collect = (chunks: Buffer[], value: Buffer, count: number): number => {
    chunks.push(value);
    count += value.length;
    while (count > limit && chunks.length) {
      const first = chunks.shift();
      if (first) count -= first.length;
    }
    return count;
  };
  const collectOutput = (stream: "stdout" | "stderr", chunks: Buffer[]) => {
    let bytes = 0;
    child[stream].on("data", (chunk: Buffer) => {
      bytes = collect(chunks, Buffer.from(chunk), bytes);
      notify(stream, Buffer.from(chunk));
    });
  };
  collectOutput("stdout", stdout);
  collectOutput("stderr", stderr);
  child.stdin.on("error", error => {
    if ((error as NodeJS.ErrnoException).code !== "EPIPE") child.emit("error", error);
  });
  child.stdin.end(options.input ?? undefined);
  let termination: Promise<void> | undefined;
  let abort = () => {};
  const result = await new Promise<ChildOutcome>((done, fail) => {
    let exited: ChildOutcome | undefined;
    // A descendant that escaped the kill still holds the inherited pipes and
    // would delay "close" until it exits; once cancelled, the client's exit is enough.
    abort = () => {
      if (exited) done(exited);
      else termination ??= killDockerClient(child);
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    child.once("error", fail);
    child.once("exit", (code, signal) => {
      exited = { code, signal };
      if (options.signal?.aborted) done(exited);
    });
    child.once("close", (code, signal) => done({ code, signal }));
  }).finally(() => options.signal?.removeEventListener("abort", abort));
  if (options.signal?.aborted) {
    child.stdout.destroy();
    child.stderr.destroy();
    await termination;
    throw options.signal.reason;
  }
  const output = { stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") };
  if (observationFailed) throw observationFailure;
  if (result.code !== 0 || result.signal !== null) {
    // Docker's legacy-builder warning goes to stderr while the actual failed
    // RUN step is on stdout. Keep both so the task error identifies its cause.
    const diagnostic =
      [output.stderr.trim(), output.stdout.trim()].filter(Boolean).join("\n").slice(-32_768) ||
      `docker exited with code ${result.code ?? "null"} signal ${result.signal ?? "none"}`;
    throw Object.assign(new DockerEnvironmentError("ENV_PREPARATION_FAILED", diagnostic), { exitCode: result.code, signal: result.signal });
  }
  return output;
}

async function assertLinkFree(path: string, label: string): Promise<void> {
  const stat = await lstat(path);
  if (stat.isSymbolicLink()) throw new DockerEnvironmentError("TRANSFER_UNSAFE", `${label} contains a symlink`);
  if (stat.isDirectory()) for (const item of await readdir(path)) await assertLinkFree(join(path, item), label);
}

async function writable(path: string, label: string): Promise<string> {
  try {
    const requested = resolve(path);
    const existing = await lstat(requested).catch(error => (errno(error, "ENOENT") ? null : Promise.reject(error)));
    if (existing?.isSymbolicLink()) throw new DockerEnvironmentError("TRANSFER_UNSAFE", `${label} is a symlink`);
    await mkdir(requested, { recursive: true });
    const actual = await realpath(requested);
    await access(actual, constants.R_OK | constants.W_OK);
    const probe = join(actual, `.docker-mount-probe-${randomUUID()}`);
    const handle = await open(probe, "wx", 0o600);
    await handle.close();
    await rm(probe, { force: true });
    return actual;
  } catch (error) {
    throw new DockerEnvironmentError("CONFIG_INVALID", `${label} is not writable: ${path}`, error);
  }
}

function within(root: string, target: string): boolean {
  const path = relative(root, target);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function containerWorkdir(value: string): string {
  const normalized = posix.normalize(value.replaceAll("\\", "/"));
  const target = posix.isAbsolute(normalized) ? normalized : posix.resolve("/workspace", normalized);
  const reserved = RESERVED_STATE_ROOTS;
  if (
    value.includes("\0") || target === "/" ||
    reserved.some(root => target === root || target.startsWith(`${root}/`))
  ) {
    throw new DockerEnvironmentError("TRANSFER_UNSAFE", `unsafe Docker workdir: ${target}`);
  }
  return target;
}

function versionMatches(actual: string, expected: string): boolean {
  const wanted = expected.trim().replace(/^v/u, "");
  if (wanted === "" || wanted === "*" || wanted === "any") return true;
  const normalized = wanted.replace(/\.x$/u, "");
  return actual === normalized || actual.startsWith(`${normalized}.`);
}

function containerTarget(
  workdir: string,
  value: string,
  runtimeRoots: readonly string[] = [],
): { root: string; target: string } {
  if (value.includes("\0")) throw new DockerEnvironmentError("TRANSFER_UNSAFE", "container path contains NUL");
  const target = posix.isAbsolute(value) ? posix.normalize(value) : posix.resolve(workdir, value.replaceAll("\\", "/"));
  const inWorkspace = target === workdir || target.startsWith(`${workdir}/`);
  const runtimeRoot = runtimeRoots.find(root => target === root || target.startsWith(`${root}/`));
  if (!inWorkspace && runtimeRoot === undefined)
    throw new DockerEnvironmentError("TRANSFER_UNSAFE", "container path escapes the allowed roots");
  return { root: runtimeRoot ?? workdir, target };
}

function containerFileTarget(workdir: string, value: string, runtimeRoots: readonly string[] = []) {
  const destination = containerTarget(workdir, value, runtimeRoots);
  // A cwd may contain runtime directories; file transfers must never include
  // them. Explicit runtime/private roots retain their existing access rules.
  if (!runtimeRoots.includes(destination.root) && RESERVED_STATE_ROOTS.some(root =>
    destination.target === root || destination.target.startsWith(`${root}/`) || root.startsWith(`${destination.target}/`)))
    throw new DockerEnvironmentError("TRANSFER_UNSAFE", "container file path overlaps a reserved root");
  return destination;
}

async function allocationKey(paths: AttemptPaths): Promise<AttemptKey> {
  try {
    const value = JSON.parse(await readFile(join(paths.root, "allocation.json"), "utf8")) as {
      key?: Partial<AttemptKey>;
    };
    if (
      typeof value.key?.runId === "string" &&
      typeof value.key.taskId === "string" &&
      typeof value.key.attemptId === "string"
    )
      return value.key as AttemptKey;
  } catch {}
  return {
    runId: basename(dirname(dirname(dirname(paths.root)))) || "unknown",
    taskId: basename(dirname(dirname(paths.root))) || "unknown",
    attemptId: basename(paths.root) || "unknown",
  };
}

async function validateBuildContext(
  context: string,
  dockerfile: string,
): Promise<{ context: string; dockerfile: string }> {
  const requested = resolve(context);
  await assertLinkFree(requested, "Docker build context");
  const root = await realpath(requested);
  const file = resolve(root, dockerfile);
  if (!within(root, file)) throw new DockerEnvironmentError("TRANSFER_UNSAFE", "Dockerfile escapes build context");
  const actualFile = await realpath(file);
  if (!within(root, actualFile))
    throw new DockerEnvironmentError("TRANSFER_UNSAFE", "Dockerfile resolves outside build context");
  if (!(await lstat(actualFile)).isFile())
    throw new DockerEnvironmentError("TRANSFER_UNSAFE", "Dockerfile is not a regular file");
  return { context: root, dockerfile: actualFile };
}


type ResolvedBaseImage = { reference: string; pinnedReference: string; id: string };

export type DockerEnvironmentOptions = {
  imageConfigFingerprint?: string;
  /** Fetch external base images before an uncached build; never allocate task containers here. */
  prepareBuild?: (spec: EnvironmentSpec, signal: AbortSignal, activity?: ActivityListener) => Promise<void>;
  /** Supplement the benchmark requirement when EnvironmentSpec has no platform. */
  platform?: DockerPlatformSelection;
  /** Reject foreign architectures before probing or starting emulation. */
  allowEmulation?: boolean;
  /** Runtime diagnostic sink; not a YAML configuration field. */
  onWarning?: (message: string) => void;
  /** Explicit per-container runtime settings, shared by solve and verify. */
  containerEnv?: Record<string, string>;
  /** Per-task pip version bounds; * supplies defaults for other main images. */
  buildPipConstraints?: Record<string, string[]>;
  /** Exact, one-step mapping to explicitly prepared public task images. */
  imageOverrides?: Record<string, string>;
  network?: import("../../core/contracts/network.js").NetworkAccess | undefined;
  benchmarkName?: string | undefined;
  dockerExecutable?: string;
  nodeImage?: string;
  modelEndpoint?: string | null;
  /** Base task image for benchmarks that do not ship container images. */
  image?: string;
};

type DockerMetadata = {
  executionUsers?: NonNullable<EnvironmentSpec["executionUsers"]>;
  kind: "docker";
  phase: "solve" | "verify";
  platform: ContainerPlatform;
  platformResolution: PlatformResolution;
  containerId: string;
  services?: { project: string; containers: Record<string, string> };
  baseImage: { reference: string; id: string };
  derivedImage: { reference: string; id: string };
  installation?: RuntimeLocation;
  modelEndpoint?: {
    baseUrl: string;
    originEndpoint: string;
    gateway?: { containerId: string; image: string; volume: string };
  };
  runtimes: PreparedRuntimeImage["runtimes"];
  resources: {
    requested: { cpus: number | null; memory: string | null; storage: string | null };
    effective: { cpus: number | null; memoryBytes: number | null; storage: { enforced: false }; cpusetCpus?: string; availableCpus?: number };
  };
};

type DockerDownloadCleanup = {
  containerId: string;
  token: string;
  staging: string;
  snapshotAttempted: boolean;
  restoreStoppedState: boolean;
};

type DockerDownloadOutcome = { ok: true } | { ok: false; error: unknown };

export async function completeDockerDownload(
  command: DockerCommand,
  cleanup: DockerDownloadCleanup,
  outcome: DockerDownloadOutcome,
): Promise<void> {
  const failures: unknown[] = [];
  if (cleanup.snapshotAttempted) {
    try {
      await command(["exec", cleanup.containerId, EVALUATOR_NODE_EXECUTABLE, PROCESS_HELPER, "remove-snapshot", cleanup.token], {
        signal: AbortSignal.timeout(5_000),
      });
    } catch (error) {
      failures.push(error);
    }
  }
  if (cleanup.restoreStoppedState) {
    try {
      await command(["stop", "--time", "0", cleanup.containerId], { signal: AbortSignal.timeout(5_000) });
    } catch (error) {
      failures.push(error);
    }
  }
  try {
    await rm(cleanup.staging, { recursive: true, force: true });
  } catch (error) {
    failures.push(error);
  }
  if (failures.length > 0) {
    const errors = outcome.ok ? failures : [outcome.error, ...failures];
    throw new DockerEnvironmentError(
      "CLEANUP_FAILED",
      `Docker container ${cleanup.containerId} download cleanup failed`,
      new AggregateError(errors),
      cleanup.containerId,
    );
  }
  if (!outcome.ok) throw outcome.error;
}

async function preflightRuntimes(
  command: DockerCommand,
  containerId: string,
  requirements: RuntimeRequirement[],
  signal: AbortSignal,
  target: ContainerPlatform,
): Promise<PreparedRuntimeImage["runtimes"]> {
  const platform = (
    await command(["exec", containerId, EVALUATOR_NODE_EXECUTABLE, "-e", "process.stdout.write(process.platform + '/' + process.arch)"], {
      signal,
    })
  ).stdout.trim();
  if (platform !== nodePlatform(target))
    throw new DockerEnvironmentError(
      "ENV_ARCH_UNSUPPORTED",
      `Docker container runtime is ${platform || "unknown"}; ${nodePlatform(target)} is required`,
    );
  const result: PreparedRuntimeImage["runtimes"] = [];
  for (const requirement of requirements) {
    if (requirement.name === "node") {
      const version = (await command(["exec", containerId, EVALUATOR_NODE_EXECUTABLE, "--version"], { signal })).stdout
        .trim()
        .replace(/^v/u, "");
      if (!versionMatches(version, requirement.version))
        throw new DockerEnvironmentError(
          "ENV_RUNTIME_INSTALL_FAILED",
          `node ${requirement.version} is required; container has ${version}`,
        );
      result.push({ name: "node", version, executable: "/usr/local/bin/node" });
    } else if (requirement.name === "bash" || requirement.name === "shell") {
      const output = (await command(["exec", containerId, "bash", "--version"], { signal })).stdout;
      const version = output.match(/version\s+(\d+(?:\.\d+)+)/iu)?.[1] ?? "unknown";
      if (!versionMatches(version, requirement.version))
        throw new DockerEnvironmentError(
          "ENV_RUNTIME_INSTALL_FAILED",
          `bash ${requirement.version} is required; container has ${version}`,
        );
      result.push({ name: "bash", version, executable: "bash" });
    }
  }
  return result;
}

class DockerSession implements EnvironmentSession {
  readonly metadata: DockerMetadata;
  readonly runtime?: RuntimeLocation;
  readonly modelEndpoint?: ModelEndpointMapping;
  private readonly processes = new Set<ProcessHandle>();
  private readonly starting = new Set<Promise<ProcessHandle>>();
  private readonly gateway?: GatewayHandle;
  private processEnv: Record<string, string> = {};
  private runtimeUploadOwner: { user: string | undefined; owner: DockerExecutionOwner } | undefined;
  private disposed = false;
  private quiesced = false;
  private disposal: Promise<void> | null = null;
  constructor(
    readonly id: string,
    readonly workdir: string,
    readonly agentOutputDir: string,
    readonly verifierOutputDir: string,
    private readonly dockerExecutable: string,
    private readonly command: DockerCommand,
    metadata: DockerMetadata,
    private readonly logOwners: Awaited<ReturnType<typeof captureDockerLogOwnership>>,
    gateway?: GatewayHandle,
    private readonly project?: DockerComposeProject,
  ) {
    this.metadata = metadata;
    if (metadata.installation) this.runtime = metadata.installation;
    if (metadata.modelEndpoint) {
      this.modelEndpoint = {
        baseUrl: metadata.modelEndpoint.baseUrl,
        originEndpoint: metadata.modelEndpoint.originEndpoint,
      };
    }
    if (gateway) this.gateway = gateway;
  }
  private active(): void {
    if (this.disposed) throw new DockerEnvironmentError("ENV_SESSION_CLOSED", `Docker session ${this.id} is disposed`);
  }
  async start(command: CommandSpec, signal: AbortSignal): Promise<ProcessHandle> {
    if (this.quiesced) throw new Error("Session is quiesced; new work is forbidden");
    this.active();
    signal.throwIfAborted();
    const runtimeRoots = this.runtime
      ? [this.runtime.stateRoot, this.runtime.root].filter((root): root is string => root !== undefined)
      : [];
    const cwd = containerTarget(this.workdir, command.cwd, runtimeRoots).target;
    const pending = startDockerProcess(
      { dockerExecutable: this.dockerExecutable, containerId: this.id, command: this.command },
      { ...command, cwd, env: { ...command.env, ...this.processEnv },
        ...(this.metadata.executionUsers?.[this.metadata.phase] === undefined ? {} : { user: this.metadata.executionUsers[this.metadata.phase] }) },
      signal,
    );
    this.starting.add(pending);
    let handle: ProcessHandle;
    try { handle = await pending; } finally { this.starting.delete(pending); }
    if (this.quiesced) {
      await handle.stop(PROCESS_STOP_GRACE_MS);
      throw new Error("Session quiesced while a process was starting");
    }
    this.processes.add(handle);
    void handle.done.finally(() => this.processes.delete(handle)).catch(() => {});
    return handle;
  }
  async upload(source: string, target: string, signal: AbortSignal): Promise<void> {
    if (this.quiesced) throw new Error("Session is quiesced; new work is forbidden");
    this.active();
    signal.throwIfAborted();
    const requested = resolve(source);
    await assertLinkFree(requested, "upload source");
    const actual = await realpath(requested);
    const sourceStat = await lstat(actual);
    const privateRoot = ["/tests", "/environment", "/logs/verifier"].find(root => target === root || target.startsWith(root + "/"));
    const privateTarget = this.metadata.phase === "verify" ? privateRoot : undefined;
    const writableRuntimeRoots = this.runtime?.stateRoot === undefined ? [] : [this.runtime.stateRoot];
    const destination = privateTarget
      ? { root: privateTarget, target: posix.normalize(target) }
      : containerFileTarget(this.workdir, target, writableRuntimeRoots);
    if (privateTarget && destination.target !== privateRoot && !destination.target.startsWith(privateRoot + "/"))
      throw new DockerEnvironmentError("TRANSFER_UNSAFE", "private upload escapes /tests");
    const runtimeUpload = this.metadata.phase === "solve" && destination.root === this.runtime?.stateRoot;
    let owner: DockerExecutionOwner | undefined;
    if (runtimeUpload) {
      if (destination.target === destination.root)
        throw new DockerEnvironmentError("TRANSFER_UNSAFE", "runtime upload must be beneath the state root");
      const user = this.metadata.executionUsers?.solve;
      if (!this.runtimeUploadOwner || this.runtimeUploadOwner.user !== user)
        this.runtimeUploadOwner = { user, owner: await dockerExecutionOwner(this.command, this.id, user, signal) };
      owner = this.runtimeUploadOwner.owner;
      await ownDockerRuntimeUpload(this.command, this.id, "prepare", destination.root, destination.target, sourceStat.isDirectory(), owner, signal);
    } else await this.command(
      [
        "exec",
        this.id,
        EVALUATOR_NODE_EXECUTABLE,
        PROCESS_HELPER,
        "mkdir",
        destination.root,
        destination.target,
        sourceStat.isDirectory() ? "directory" : "file",
      ],
      { signal },
    );
    const dockerSource = sourceStat.isDirectory() ? `${actual}${sep}.` : actual;
    await this.command(["cp", dockerSource, `${this.id}:${destination.target}`], {
      signal,
      maxBuffer: 8 * 1024 * 1024,
    });
    if (owner)
      await ownDockerRuntimeUpload(this.command, this.id, "complete", destination.root, destination.target, sourceStat.isDirectory(), owner, signal);
    signal.throwIfAborted();
  }
  async download(source: string, target: string, signal: AbortSignal): Promise<void> {
    this.active();
    signal.throwIfAborted();
    const allowed = containerFileTarget(this.workdir, source,
      this.metadata.phase === "verify" ? ["/logs/verifier", "/tests"] : [this.agentOutputDir]);
    const origin = allowed.target;
    const state = JSON.parse(
      (await this.command(["inspect", this.id, "--format", "{{json .State}}"], { signal })).stdout,
    ) as { Running?: boolean; Paused?: boolean };
    if (state.Paused)
      throw new DockerEnvironmentError("ENV_CAPABILITY_UNSUPPORTED", `cannot download from paused container ${this.id}`);
    const staging = await mkdtemp(join(tmpdir(), "ember-docker-download-"));
    const payload = join(staging, "payload");
    const token = randomUUID();
    let snapshotAttempted = false;
    let restoreStoppedState = false;
    let outcome: DockerDownloadOutcome = { ok: true };
    try {
      if (state.Running !== true) {
        restoreStoppedState = true;
        await this.project?.enterMaintenance(signal);
        await this.command(["start", this.id], { signal });
      }
      snapshotAttempted = true;
      await this.command(["exec", this.id, EVALUATOR_NODE_EXECUTABLE, PROCESS_HELPER, "snapshot", token, allowed.root, origin], {
        signal,
        maxBuffer: 8 * 1024 * 1024,
      });
      await this.command(["cp", `${this.id}:/opt/evaluator/downloads/${token}/payload`, payload], {
        signal,
        maxBuffer: 8 * 1024 * 1024,
      });
      await assertLinkFree(payload, "download source");
      signal.throwIfAborted();
      const destination = resolve(target);
      await mkdir(dirname(destination), { recursive: true });
      await cp(payload, destination, { recursive: true, dereference: true, force: true });
      signal.throwIfAborted();
    } catch (error) {
      outcome = { ok: false, error };
    }
    await completeDockerDownload(
      this.command,
      { containerId: this.id, token, staging, snapshotAttempted, restoreStoppedState },
      outcome,
    );
  }
  async exportState(spec: TransferSpec, target: string, signal: AbortSignal): Promise<TransferArtifact> {
    this.active();
    signal.throwIfAborted();
    if (spec.kind === "artifacts" && spec.services) {
      validateTransferSpec(spec, this.workdir);
      if (!this.project) throw new Error("Service artifacts require a multi-container environment");
    }
    const state = JSON.parse(
      (await this.command(["inspect", this.id, "--format", "{{json .State}}"], { signal })).stdout,
    ) as { Running?: boolean; Paused?: boolean };
    if (state.Paused)
      throw new DockerEnvironmentError("ENV_CAPABILITY_UNSUPPORTED", `cannot export from paused container ${this.id}`);
    const restoreStoppedState = state.Running !== true;
    let exportFailure: unknown;
    try {
      // As with download(), restart the managed idle process for the snapshot;
      // solver exec processes are not restarted with the container.
      if (restoreStoppedState) {
        await this.project?.enterMaintenance(signal);
        await this.command(["start", this.id], { signal });
      }
      if (spec.kind === "artifacts" && spec.services && this.project) await this.project.snapshotArtifacts(this.id, spec, signal);
      if (spec.kind === "git-patch")
        return await exportGitPatch({ id: this.id, workdir: this.workdir, command: this.command }, spec, target, signal);
      return await exportWorkspace({ id: this.id, workdir: this.workdir, command: this.command }, spec, target, signal);
    } catch (error) {
      exportFailure = error;
      throw error;
    } finally {
      if (restoreStoppedState) {
        try {
          await this.command(["stop", "--time", "0", this.id], { signal: AbortSignal.timeout(5_000) });
        } catch (error) {
          throw new DockerEnvironmentError(
            "CLEANUP_FAILED",
            `failed to restore stopped state after workspace export from ${this.id}`,
            new AggregateError(exportFailure === undefined ? [error] : [exportFailure, error]),
            this.id,
          );
        }
      }
    }
  }
  async restoreState(artifact: TransferArtifact, signal: AbortSignal): Promise<void> {
    if (this.quiesced) throw new Error("Session is quiesced; new work is forbidden");
    this.active();
    if (artifact.spec.kind === "git-patch")
      return await restoreGitPatch({ id: this.id, workdir: this.workdir, command: this.command }, artifact, signal);
    return await restoreWorkspace({ id: this.id, workdir: this.workdir, command: this.command }, artifact, signal);
  }
  async transitionToVerification(network: EnvironmentSpec["network"], signal: AbortSignal): Promise<void> {
    this.active();
    validateNetworkPolicy(network);
    await Promise.allSettled(this.starting);
    signal.throwIfAborted();
    // Restart only the managed idle entrypoint, reclaiming detached solver
    // descendants before any private verifier material is uploaded.
    if (this.project && network === undefined) {
      // Sidecars may measure the running main service. Stop Solver processes,
      // capture trusted hooks, and only then quiesce the namespace for export.
      await Promise.all([...this.processes].map(handle => handle.stop(PROCESS_STOP_GRACE_MS)));
      const running = (await this.command(["inspect", this.id, "--format", "{{.State.Running}}"], { signal })).stdout.trim();
      if (running !== "true" && running !== "false")
        throw new DockerEnvironmentError("ARTIFACT_COLLECTION_INCOMPLETE", `Cannot determine main container state before collection: ${this.id}`);
      if (running === "false") {
        // Timeout cancellation stops main's entire namespace. Restart only the
        // managed idle entrypoint; leave live sidecars and their evidence intact.
        await this.project.enterMaintenance(signal);
        await this.command(["start", this.id], { signal });
      }
    } else await this.quiesce(signal);
    this.quiesced = false;
    if (typeof network === "object") {
      if (!this.gateway) throw new Error("Shared verifier needs a prepared gateway for allowlist; declare a separate verifier environment");
      await this.gateway.resume(signal);
      await this.gateway.setAllowedHosts(network.allowedHosts, signal);
      await startModelForwarder(this.command, this.id, signal);
      this.processEnv = { ...EGRESS_PROXY_ENV };
    } else if (network === "bridge" && this.gateway) {
      await this.gateway.suspend(signal);
      await this.command(["network", "disconnect", "none", this.id], { signal });
      await this.command(["network", "connect", "bridge", this.id], { signal });
      this.processEnv = Object.fromEntries(Object.keys(EGRESS_PROXY_ENV).map(key => [key, ""]));
    } else if (this.gateway && network !== "none") {
      await this.gateway.resume(signal);
      if (network === "model-api") await this.gateway.setAllowedHosts([], signal);
      await startModelForwarder(this.command, this.id, signal);
    }
    if (network === "none") {
      const inspected = await this.command(["inspect", "--format", "{{json .NetworkSettings.Networks}}", this.id], { signal });
      const networks: unknown = JSON.parse(inspected.stdout);
      if (!networks || typeof networks !== "object" || Array.isArray(networks)) throw new Error("Invalid Docker network inventory");
      for (const name of Object.keys(networks)) {
        if (name !== "none") await this.command(["network", "disconnect", name, this.id], { signal });
      }
      await this.gateway?.suspend(signal);
    }
    this.metadata.phase = "verify";
    await makeDockerLogsWritable(this.command, this.id, this.logOwners, signal);
    // The task filesystem survives the phase transition.
    await this.command(["exec", this.id, EVALUATOR_NODE_EXECUTABLE, PROCESS_HELPER, "mkdir", "/logs/verifier", "/logs/verifier/.evaluator-placeholder"], { signal });
  }
  async transitionToSolve(network: EnvironmentSpec["network"], signal: AbortSignal, users?: EnvironmentSpec["executionUsers"]): Promise<void> {
    this.active();
    await this.quiesce(signal);
    // Private scripts and rewards must disappear before any network or Solver
    // process is restored. rm removes links themselves, never their targets.
    const clean = "const f=require('node:fs/promises');(async()=>{for(const p of ['/tests','/environment'])await f.rm(p,{recursive:true,force:true});for(const p of ['/logs/verifier','/logs/agent'])for(const n of await f.readdir(p))await f.rm(p+'/'+n,{recursive:true,force:true});})().catch(e=>{console.error(e);process.exit(1)});";
    await this.command(["exec", "--user", "0", this.id, EVALUATOR_NODE_EXECUTABLE, "-e", clean], { signal });
    if (typeof network === "object" || network === "model-api") {
      const inspected = await this.command(["inspect", "--format", "{{json .NetworkSettings.Networks}}", this.id], { signal });
      const networks = JSON.parse(inspected.stdout) as Record<string, unknown>;
      for (const name of Object.keys(networks)) if (name !== "none")
        await this.command(["network", "disconnect", name, this.id], { signal });
    }
    if (network === "bridge" && !this.gateway) {
      const inspected = await this.command(["inspect", "--format", "{{json .NetworkSettings.Networks}}", this.id], { signal });
      const networks = JSON.parse(inspected.stdout) as Record<string, unknown>;
      if (!networks.bridge) {
        if (networks.none) await this.command(["network", "disconnect", "none", this.id], { signal });
        await this.command(["network", "connect", "bridge", this.id], { signal });
      }
    }
    await this.transitionToVerification(network, signal);
    if (users) this.metadata.executionUsers = users;
    this.metadata.phase = "solve";
  }
  async quiesce(signal: AbortSignal): Promise<void> {
    this.active();
    this.quiesced = true;
    await Promise.allSettled(this.starting);
    signal.throwIfAborted();
    await Promise.all([...this.processes].map(handle => handle.stop(PROCESS_STOP_GRACE_MS)));
    // Stop the entire PID namespace, including detached writers. Restart only
    // our fixed idle entrypoint so controlled export can use docker exec.
    await this.project?.enterMaintenance(signal);
    await stopDockerContainer(this.command, this.id, signal);
    signal.throwIfAborted();
    await this.command(["start", this.id], { signal });
    await restoreDockerLogOwnership(this.command, this.id, this.logOwners, signal);
  }

  async startService(service: string, command: CommandSpec, signal: AbortSignal): Promise<ProcessHandle> {
    this.active();
    if (!this.project) throw new Error("Environment has no sidecar services");
    return this.project.start(service, command, signal);
  }

  dispose(signal: AbortSignal): Promise<void> {
    if (this.disposal) return this.disposal;
    this.disposed = true;
    this.disposal = (async () => {
      this.quiesced = true;
      await Promise.allSettled(this.starting);
      await Promise.all([...this.processes].map(handle => handle.stop(PROCESS_STOP_GRACE_MS).catch(() => {})));
      const failures: unknown[] = [];
      try {
        // Stop detached writers before handing private 0600 evidence back to
        // its original host owner; collection runs after this session ends.
        await this.project?.enterMaintenance(signal);
        await stopDockerContainer(this.command, this.id, signal);
        await this.command(["start", this.id], { signal });
        await restoreDockerLogOwnership(this.command, this.id, this.logOwners, signal);
      } catch (error) { failures.push(error); }
      // The task's mount keeps the socket volume in use even after the gateway
      // stops. Remove the task first, sharing the caller's cleanup budget.
      try { await (this.project ? this.project.dispose(signal) : removeDockerContainer(this.command, this.id, signal)); }
      catch (error) { failures.push(error); }
      try { await this.gateway?.dispose(signal); }
      catch (error) { failures.push(error); }
      if (failures.length > 0) throw new DockerEnvironmentError("CLEANUP_FAILED",
        `failed to remove Docker session ${this.id}`, new AggregateError(failures));
    })();
    return this.disposal;
  }
}

export class DockerEnvironment implements Environment {
  private readonly prepareBuild: DockerEnvironmentOptions["prepareBuild"];
  readonly supportsRuntimeInstallation = true;
  private readonly containerEnv: Record<string, string>;
  private readonly buildPipConstraints: Record<string, string[]>;
  private readonly imageOverrides: Record<string, string>;
  private readonly taskImageCache = new DockerBuildCache<string>();
  private capacity: Promise<DockerCapacity> | undefined;
  private readonly attemptBaseImages = new Map<string, Promise<ResolvedBaseImage>>();
  private readonly dockerExecutable: string;
  private readonly command: DockerCommand;
  private readonly imageInventory: DockerImageInventory;
  private readonly imageConfigFingerprint: string | undefined;
  private readonly network: NetworkAccess;
  private readonly pullImage: DockerImagePull;
  private readonly pullTaskImage: DockerImagePull;
  private readonly taskArchive: DockerTaskArchive | undefined;
  private readonly platformSelection: DockerPlatformSelection;
  private readonly allowEmulation: boolean;
  private readonly capabilities: PlatformCapabilityDetector;
  private readonly nodeImage: string;
  private readonly runtimes = new Map<ContainerPlatform, { runtime: DockerRuntime; solverRuntime: DockerSolverRuntime }>();
  /** Configured model endpoint; required by the "model-api" network policy. */
  private readonly modelEndpoint: string | null;
  /** Base task image used when the benchmark's environment spec has no image. */
  private readonly defaultImage: string | null;
  constructor(options: DockerEnvironmentOptions = {}) {
    this.network = options.network ?? new NetworkRuntime();
    this.prepareBuild = options.prepareBuild;
    this.platformSelection = parseDockerPlatform(options.platform);
    this.allowEmulation = parseDockerEmulation(options.allowEmulation);
    this.containerEnv = parseDockerContainerEnv(options.containerEnv);
    this.buildPipConstraints = parseBuildPipConstraints(options.buildPipConstraints);
    this.imageOverrides = parseDockerImageOverrides(options.imageOverrides);
    this.dockerExecutable = options.dockerExecutable ?? "docker";
    this.command = observeDockerCommand(platformImageCommand(async (args, commandOptions) => {
      try { return await runDockerCommand(this.dockerExecutable, args, commandOptions); }
      catch (cause) {
        const operation = args[0];
        if (operation && ["pull", "build", "create", "start"].includes(operation)) {
          const failure = classifyError(cause, { phase: "environment", component: "docker", operation });
          throw new EvaluatorError(failure.code, failure.message, failure.details, { cause });
        }
        throw cause;
      }
    }));
    this.imageInventory = new DockerImageInventory(this.command);
    this.command = this.imageInventory.command;
    this.imageConfigFingerprint = options.imageConfigFingerprint;
    this.pullImage = createDockerImagePuller(this.command, { network: this.network });
    const acquisition = options.benchmarkName ? this.network.settings.docker.benchmarks[options.benchmarkName] : undefined;
    this.taskArchive = acquisition?.method === "archive" ? new DockerTaskArchive(this.command, acquisition, this.network) : undefined;
    this.pullTaskImage = createDockerImagePuller(this.command, { network: this.network,
      acquisition: acquisition?.method === "archive" ? undefined : acquisition });
    this.nodeImage = new DockerRuntime(this.command, options.nodeImage, DOCKER_PLATFORM, this.pullImage, this.dockerExecutable).nodeImage;
    this.capabilities = new PlatformCapabilityDetector(this.command, options.onWarning);
    this.modelEndpoint = options.modelEndpoint ?? null;
    this.defaultImage = options.image ?? null;
  }
  private async platformContext(spec: Pick<EnvironmentSpec, "platform">, signal: AbortSignal) {
    const native = await this.capabilities.nativePlatform(signal);
    const resolution = resolveDockerPlatform(this.platformSelection, this.taskArchive ? undefined : spec.platform, native, this.allowEmulation);
    let runtimes = this.runtimes.get(resolution.platform);
    if (!runtimes) {
      const runtime = new DockerRuntime(this.command, this.nodeImage, resolution.platform, this.pullImage, this.dockerExecutable);
      runtimes = { runtime, solverRuntime: new DockerSolverRuntime(this.command, runtime, this.network) };
      this.runtimes.set(resolution.platform, runtimes);
    }
    const { runtime, solverRuntime } = runtimes;
    await this.capabilities.ensure(resolution, signal, async active => {
      await runtime.nodeImageDigest(active);
      return runtime.nodeImage;
    });
    return { resolution, platform: resolution.platform, runtime, solverRuntime };
  }
  async installRuntime(installation: RuntimeInstallation, signal: AbortSignal, spec?: EnvironmentSpec, activity?: ActivityListener): Promise<void> {
    return this.imageInventory.use(undefined, signal, () => withDockerActivity(activity, () => this.installRuntimeObserved(installation, signal, spec)));
  }
  acquireImageLease(signal: AbortSignal) { return this.imageInventory.lease(signal); }
  private async installRuntimeObserved(installation: RuntimeInstallation, signal: AbortSignal, spec?: EnvironmentSpec): Promise<void> {
    signal.throwIfAborted();
    const { solverRuntime } = await this.platformContext(spec ?? {}, signal);
    await solverRuntime.install(installation, signal);
  }
  async recoverAttempts(keys: AttemptKey[], signal: AbortSignal): Promise<void> {
    await recoverDockerAttempts(this.command, keys, signal);
    await recoverComposeNetworks(this.command, keys, signal);
    // Gateway containers carry the same attempt labels and are reaped above;
    // their socket volumes need an explicit sweep.
    await cleanupGatewayVolumes(this.command, keys, signal);
  }
  private async taskImage(spec: EnvironmentSpec, platform: ContainerPlatform, signal: AbortSignal, observe?: (source: PreparationCacheSource) => void, useImageOverrides = true, scope?: DockerImageScope): Promise<string> {
    if (spec.image !== null) {
      observe?.("reference");
      const override = useImageOverrides && Object.hasOwn(this.imageOverrides, spec.image) ? this.imageOverrides[spec.image] : undefined;
      return override ?? spec.image;
    }
    if (!spec.build) throw new DockerEnvironmentError("ENV_IMAGE_REFERENCE_INVALID", "Docker environment requires image or build");
    const constraintTaskId = scope && Object.hasOwn(this.buildPipConstraints, scope.taskId) ? scope.taskId : "*";
    const pipConstraints = scope?.service ? [] : this.buildPipConstraints[constraintTaskId] ?? [];
    const context = await validateBuildContext(spec.build.context, spec.build.dockerfile);
    const manifest = await buildFileManifest(context.context, []);
    if (manifest.missing.length)
      throw new DockerEnvironmentError("TRANSFER_UNSAFE", "Docker build context contains an unreadable or unsafe entry");
    const actualSourceHash = fingerprintConfig(manifest.files as unknown as JsonValue);
    if (actualSourceHash !== spec.build.sourceHash)
      throw new DockerEnvironmentError(
        "SOURCE_CHANGED",
        "Docker build context no longer matches its public source hash",
      );
    const sourceModes = await readDirectoryModes(context.context, signal);
    let network;
    try { network = dockerBuildNetwork(this.network); }
    catch (cause) { throw new DockerEnvironmentError("CONFIG_INVALID", "Invalid Docker build network settings", cause); }
    const key = createHash("sha256")
      .update(
        JSON.stringify({
          sourceHash: spec.build.sourceHash,
          permissions: sourceModes,
          mirrorPolicy: "ca-bootstrap-v5-apt-network-defaults",
          platform,
          network: network.identity,
          dockerfile: relative(context.context, context.dockerfile).replaceAll("\\", "/"),
          ...(pipConstraints.length ? { pipConstraints } : {}),
          ...(spec.build.noCache ? { freshBuild: randomUUID() } : {}),
        }),
      )
      .digest("hex");
    const tag = dockerImageName(scope ? "task" : "solve-task", key, scope);
    // Public contexts with identical bytes can contain a large shared corpus.
    // Build and snapshot them once; retain task-specific aliases for inspection.
    const buildTag = spec.build.visibility === "public" ? dockerImageName("solve-task", key) : tag;
    const reference = await this.taskImageCache.getImage(this.dockerExecutable, buildTag, signal, async buildSignal => {
      try {
        await this.command(["image", "inspect", "--platform", platform, buildTag, "--format", "{{.Id}}"], { signal: buildSignal });
        observe?.("image");
        return buildTag;
      } catch {}
      buildSignal.throwIfAborted();
      const staging = await mkdtemp(join(tmpdir(), "ember-docker-context-"));
      try {
        const snapshot = join(staging, "context");
        await cp(context.context, snapshot, {
          recursive: true,
          dereference: false,
          verbatimSymlinks: true,
          force: false,
          errorOnExist: true,
        });
        await assertLinkFree(snapshot, "Docker build context snapshot");
        await restoreDirectoryModes(snapshot, sourceModes, buildSignal);
        const snapshotManifest = await buildFileManifest(snapshot, []);
        if (
          snapshotManifest.missing.length ||
          fingerprintConfig(snapshotManifest.files as unknown as JsonValue) !== spec.build!.sourceHash ||
          fingerprintConfig(await readDirectoryModes(context.context, buildSignal) as unknown as JsonValue) !==
            fingerprintConfig(sourceModes as unknown as JsonValue) ||
          fingerprintConfig(await readDirectoryModes(snapshot, buildSignal) as unknown as JsonValue) !==
            fingerprintConfig(sourceModes as unknown as JsonValue)
        ) {
          throw new DockerEnvironmentError(
            "SOURCE_CHANGED",
            "Docker build context content or permissions changed while its public snapshot was created",
          );
        }
        const dockerfile = resolve(snapshot, relative(context.context, context.dockerfile));
        await this.prepareBuild?.({ ...spec, build: { ...spec.build!, context: snapshot,
          dockerfile: relative(snapshot, dockerfile).replaceAll("\\", "/") } }, buildSignal, dockerActivity());
        buildSignal.throwIfAborted();
        await applyBuildPipConstraints(snapshot, dockerfile, pipConstraints, buildSignal);
        const buildArgs = network.buildArgs;
        await writeFile(dockerfile, network.recipe(await readFile(dockerfile, "utf8")));
        await this.command(["build", "--platform", platform, ...(spec.build?.noCache ? ["--no-cache"] : []), ...buildArgs, "--tag", buildTag, "--file", dockerfile, snapshot], {
          env: network.environment,
          signal: buildSignal,
          maxBuffer: 8 * 1024 * 1024,
        });
        observe?.("built");
        return buildTag;
      } finally {
        await rm(staging, { recursive: true, force: true });
      }
    }, observe);
    if (reference !== tag) await this.command(["image", "tag", reference, tag], { signal });
    return tag;
  }
  private async baseImage(spec: EnvironmentSpec, platform: ContainerPlatform, key: AttemptKey, signal: AbortSignal, observe?: (source: PreparationCacheSource) => void, useImageOverrides = true, scope?: DockerImageScope): Promise<ResolvedBaseImage> {
    if (this.taskArchive && scope) return this.taskArchive.load(scope, platform, signal, observe);
    // Validate the public build context on every phase before consulting the
    // task-image cache, while keeping a mutable image tag pinned per attempt.
    const reference = await this.taskImage(spec, platform, signal, observe, useImageOverrides, scope);
    const pull: DockerImagePull = (image, target, active) => this.pullTaskImage(image, target, active, scope);
    const pinned = await resolvePinnedTaskImage(this.command, reference, platform, scope, signal, observe, pull);
    if (pinned) return pinned;
    const attempt = JSON.stringify([key.runId, key.taskId, key.attemptId, platform, reference, scope]);
    const cached = this.attemptBaseImages.get(attempt);
    if (cached) return await cached;
    const resolution = (async () => {
      let localReference = reference;
      let inspected;
      try {
        inspected = await this.command(["image", "inspect", "--platform", platform, reference, "--format", "{{.Id}}"], { signal });
      } catch (inspectError) {
        try {
          localReference = (await pull(reference, platform, signal)).reference;
        } catch (pullError) {
          throw new DockerEnvironmentError(
            "ENV_IMAGE_PULL_FAILED",
            `cannot inspect or pull Docker image ${reference}`,
            new AggregateError([inspectError, pullError]),
          );
        }
        inspected = await this.command(["image", "inspect", "--platform", platform, localReference, "--format", "{{.Id}}"], { signal });
      }
      const id = inspected.stdout.trim();
      if (!/^sha256:[a-f0-9]{64}$/u.test(id))
        throw new DockerEnvironmentError("ENV_IMAGE_REFERENCE_INVALID", `Docker returned an invalid image ID for ${reference}`);
      const actualPlatform = (await this.command(["image", "inspect", "--platform", platform, localReference,
        "--format", "{{.Os}}/{{.Architecture}}"], { signal })).stdout.trim();
      if (actualPlatform !== platform)
        throw new EvaluatorError("ENV_ARCH_UNSUPPORTED",
          `Task image ${reference} is ${actualPlatform || "unknown"}; resolved target is ${platform}`,
          { component: "docker", operation: "image-inspect" });
      const tagHash = createHash("sha256").update(`${attempt}\0${id}`).digest("hex").slice(0, 24);
      const pinnedReference = dockerImageName(scope ? "base" : key.taskId === "gateway" ? "gateway-base" : "solve-base", tagHash, scope);
      await this.command(["image", "tag", localReference, pinnedReference], { signal });
      return { reference, pinnedReference, id };
    })();
    this.attemptBaseImages.set(attempt, resolution);
    try {
      return await resolution;
    } catch (error) {
      this.attemptBaseImages.delete(attempt);
      throw error;
    }
  }
  private async addressableImage(reference: string, signal: AbortSignal): Promise<string> {
    // containerd may return a platform config ID from --platform that cannot
    // itself be used as an image reference. Use the addressable root ID to launch.
    const id = (await this.command(["image", "inspect", reference, "--format", "{{.Id}}"], { signal })).stdout.trim();
    if (!/^sha256:[a-f0-9]{64}$/u.test(id))
      throw new DockerEnvironmentError("ENV_IMAGE_REFERENCE_INVALID", `Preparation returned an invalid addressable image identity for ${reference}`);
    return id;
  }
  private async admitResources(spec: EnvironmentSpec, signal: AbortSignal): Promise<void> {
    if (spec.resources?.cpus === undefined && spec.resources?.memory === undefined) return;
    this.capacity ??= readDockerCapacity(this.command, signal).catch(error => { this.capacity = undefined; throw error; });
    assertDockerCapacity(spec.resources, await this.capacity);
  }
  private validateTaskNetwork(spec: EnvironmentSpec): void {
    validateNetworkPolicy(spec.network);
    if (Object.keys(spec.services ?? {}).some(name => name !== "main") && (spec.network ?? "bridge") !== "bridge")
      throw new DockerEnvironmentError("ENV_CAPABILITY_UNSUPPORTED", "Multi-container tasks require a task-scoped bridge network; isolated egress policies cannot be weakened");
  }
  async materialize(spec: EnvironmentSpec, signal: AbortSignal, onImageReady?: (timing: EnvironmentImageReady) => void, activity?: ActivityListener, context?: EnvironmentPreparationContext): Promise<EnvironmentSpec> {
    return this.imageInventory.use(context && this.imageConfigFingerprint ? { configFingerprint: this.imageConfigFingerprint, ...context } : undefined,
      signal, async () => {
        const prepared = await withDockerActivity(activity, () => this.materializeObserved(spec, signal, onImageReady, context));
        await this.imageInventory.associatePrepared(prepared.prepared, signal);
        return prepared;
      });
  }
  cleanupImages(request: import("../../core/contracts/image-cleanup.js").ImageCleanupRequest, signal: AbortSignal) {
    return this.imageInventory.cleanup(request, signal);
  }
  private async materializeObserved(spec: EnvironmentSpec, signal: AbortSignal, onImageReady?: (timing: EnvironmentImageReady) => void, context?: EnvironmentPreparationContext): Promise<EnvironmentSpec> {
    this.validateTaskNetwork(spec);
    signal.throwIfAborted();
    await this.admitResources(spec, signal);
    const { resolution, platform, runtime: nodeRuntime, solverRuntime } = await this.platformContext(spec, signal);
    const cache: NonNullable<EnvironmentPreparationTimings["cache"]> = {};
    const imageStarted = performance.now();
    const baseImage = await this.baseImage(
      spec.image === null && !spec.build && this.defaultImage !== null ? { ...spec, image: this.defaultImage } : spec, platform,
      { runId: "preparation", taskId: context?.taskId ?? "shared", attemptId: randomUUID() }, signal, source => { cache.image = source; }, true, context,
    );
    const imageMs = performance.now() - imageStarted;
    signal.throwIfAborted();
    onImageReady?.({ imageMs, ...(cache.image === undefined ? {} : { cache: cache.image }) });
    const runtimeStarted = performance.now();
    const runtime = await nodeRuntime.prepare(baseImage.pinnedReference, spec.runtime, signal, source => { cache.runtime = source; }, context);
    const runtimeMs = performance.now() - runtimeStarted;
    const solverStarted = performance.now();
    const solverImage = spec.installation
      ? await solverRuntime.prepare(runtime.image, runtime.digest, spec.installation, signal, source => { cache.solver = source; }, context)
      : undefined;
    const solverMs = spec.installation ? performance.now() - solverStarted : 0;
    const launchImage = await this.addressableImage(solverImage?.image ?? runtime.image, signal);
    let gatewayImage: string | null = null;
    let gatewayDigest: string | null = null;
    if (spec.network === "model-api" || typeof spec.network === "object") {
      // A task image mapping must never replace the pinned internal gateway.
      gatewayDigest = (await this.baseImage({ ...spec, image: nodeRuntime.nodeImage }, platform, { runId: "preparation", taskId: "gateway", attemptId: randomUUID() }, signal, undefined, false)).id;
      gatewayImage = await this.addressableImage(nodeRuntime.nodeImage, signal);
    }
    const serviceImages: Record<string, string> = {};
    for (const [name, service] of Object.entries(spec.services ?? {})) {
      if (name === "main") continue;
      const sidecar: EnvironmentSpec = { workdir: "/", image: service.image, initialFiles: [], runtime: [],
        ...(service.build ? { build: service.build } : {}) };
      const scope: DockerImageScope = { taskId: context?.taskId ?? "shared", phase: context?.phase ?? "solve", service: name };
      const resolved = await this.baseImage(sidecar, platform, { runId: "preparation", taskId: scope.taskId, attemptId: randomUUID() }, signal, undefined, true, scope);
      serviceImages[name] = await this.addressableImage(resolved.pinnedReference, signal);
    }
    return { ...spec, preparationTiming: { imageMs, runtimeMs, solverMs, cache }, prepared: { kind: "docker", platform, platformResolution: resolution, baseImage, runtime, solverImage: solverImage ?? null, launchImage, gatewayImage, gatewayDigest, serviceImages } };
  }
  async prepare(
    spec: EnvironmentSpec,
    paths: AttemptPaths,
    phase: "solve" | "verify",
    signal: AbortSignal,
    activity?: ActivityListener,
  ): Promise<EnvironmentSession> {
    const { value: session, release } = await this.imageInventory.hold(undefined, signal,
      () => withDockerActivity(activity, () => this.prepareObserved(spec, paths, phase, signal)));
    const dispose = session.dispose.bind(session);
    session.dispose = async active => { try { await dispose(active); } finally { await release(); } };
    return session;
  }
  private async prepareObserved(
    spec: EnvironmentSpec, paths: AttemptPaths, phase: "solve" | "verify", signal: AbortSignal,
  ): Promise<EnvironmentSession> {
    signal.throwIfAborted();
    this.validateTaskNetwork(spec);
    if (spec.services && spec.prepared === undefined) return this.prepare(await this.materialize(spec, signal, undefined, undefined,
      { taskId: (await allocationKey(paths)).taskId, phase }), paths, phase, signal);
    await this.admitResources(spec, signal);
    this.validateTaskNetwork(spec);
    if (phase === "solve" && spec.build?.visibility === "verifier")
      throw new DockerEnvironmentError("CONFIG_INVALID", "Private verifier images cannot be used for solving");
    if (phase === "verify" && spec.installation)
      throw new DockerEnvironmentError("ENV_RUNTIME_INSTALL_FAILED", "verifier environments cannot install solver runtimes");
    if (spec.resources?.cpus !== undefined) cpuCountForBudget(spec.resources.cpus);
    const prepared = spec.prepared;
    if (prepared !== undefined && (!prepared || typeof prepared !== "object" || Array.isArray(prepared) || prepared.kind !== "docker"))
      throw new DockerEnvironmentError("ENV_PREPARATION_FAILED", "Invalid Docker preparation receipt");
    const workdir = containerWorkdir(spec.workdir);
    const { resolution, platform, runtime: nodeRuntime, solverRuntime } = await this.platformContext(spec, signal);
    if (prepared && typeof prepared === "object" && !Array.isArray(prepared)
      && (prepared.platform ?? DOCKER_PLATFORM) !== platform)
      throw new EvaluatorError("ENV_ARCH_UNSUPPORTED", "Prepared Docker platform differs from the resolved task platform");
    // Different container UIDs may write the log mounts; their host parent
    // remains private to the coordinator regardless of its startup umask.
    await chmod(await writable(paths.root, "attempt directory"), 0o700);
    const [agent, verifier, key] = await Promise.all([
      writable(paths.agent, "agent output directory"),
      writable(paths.verifier, "verifier output directory"),
      allocationKey(paths),
    ]);
    const receipt = prepared as { launchImage: string; gatewayImage: string | null; gatewayDigest: string | null; baseImage: ResolvedBaseImage; runtime: PreparedRuntimeImage; solverImage: Awaited<ReturnType<DockerSolverRuntime["prepare"]>> | null; serviceImages?: Record<string, string> } | undefined;
    const scope: DockerImageScope = { taskId: key.taskId, phase };
    const baseImage = receipt?.baseImage ?? await this.baseImage(
      spec.image === null && !spec.build && this.defaultImage !== null ? { ...spec, image: this.defaultImage } : spec, platform,
      key, signal, undefined, true, scope,
    );
    const runtime = receipt?.runtime ?? await nodeRuntime.prepare(baseImage.pinnedReference, spec.runtime, signal, undefined, scope);
    const solverImage = receipt ? receipt.solverImage ?? undefined : spec.installation
      ? await solverRuntime.prepare(runtime.image, runtime.digest, spec.installation, signal, undefined, scope)
      : undefined;
    if (receipt) {
      const id = solverImage?.digest ?? runtime.digest;
      try {
        const images = [{ reference: receipt.launchImage, digest: id }];
        if (receipt.gatewayImage && receipt.gatewayDigest) images.push({ reference: receipt.gatewayImage, digest: receipt.gatewayDigest });
        for (const image of images) {
          const inspected = await this.command(["image", "inspect", "--platform", platform, image.reference, "--format", "{{.Id}}"], { signal });
          if (inspected.stdout.trim() !== image.digest) throw new Error("Image identity changed");
        }
      } catch (cause) {
        signal.throwIfAborted();
        throw new DockerEnvironmentError("ENV_PREPARED_IMAGE_LOST", "Prepared image identity is unavailable; start a new preparation round", cause);
      }
    }
    const labels = [
      ["run", key.runId],
      ["task", key.taskId],
      ["attempt", key.attemptId],
      ["phase", phase],
    ] as const;
    const mounts: { source: string; target: string }[] = [];
    if (spec.sharedLogs === true) {
      // A shared log root lets the agent stage evidence outside /logs/agent
      // (e.g. /logs/artifacts) for the verifier; per-phase mounts shadow their
      // own subdirectories.
      const shared = await writable(join(paths.root, "logs"), "shared log directory");
      mounts.push({ source: shared, target: "/logs" });
    }
    mounts.push(
      phase === "solve" ? { source: agent, target: "/logs/agent" } : { source: verifier, target: "/logs/verifier" },
    );
    // The directory is empty during solve. No hidden grading material is placed
    // here until the Benchmark starts verification in a shared environment.
    if (phase === "solve") mounts.push({ source: verifier, target: "/logs/verifier" });
    // Keep runtime routes explicit. An unavailable proxy is an error, never an implicit direct fallback.
    const runtimeEnvironment = this.network.environment("runtime", {}, "container");
    const forwardedEnv = ["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy"]
      .flatMap(key => ["--env", `${key}=${runtimeEnvironment[key] ?? ""}`]);
    if (runtimeEnvironment.HTTP_PROXY || runtimeEnvironment.HTTPS_PROXY) forwardedEnv.push("--env", "NODE_USE_ENV_PROXY=1");
    // "model-api" keeps the task container itself on --network none; only the
    // gateway container holds external network, and isolated containers must
    // not inherit host proxy settings that could bypass the policy.
    const isolatedGateway = spec.network === "model-api" || typeof spec.network === "object";
    const allowlist = typeof spec.network === "object" ? spec.network : undefined;
    let gateway: GatewayHandle | undefined;
    const volumeMounts: { source: string; target: string }[] = [];
    const modelPolicy = isolatedGateway
      ? typeof this.modelEndpoint === "string" && this.modelEndpoint !== ""
        ? parseModelEndpointPolicy(this.modelEndpoint)
        : null
      : undefined;
    if (spec.network === "model-api" && modelPolicy === null)
      throw new DockerEnvironmentError(
        "CONFIG_INVALID",
        'network "model-api" requires an explicit model endpoint',
      );
    const launchImage = receipt ? receipt.launchImage : solverImage?.image ?? runtime.image;
    const containerEnv = { ...this.containerEnv, ...parseDockerContainerEnv(spec.env) };
    // Apply deployment package mirrors to both standalone and Compose main
    // containers. Explicit task/config values win; model-only isolation stays.
    if (!isolatedGateway) for (const key of ["NPM_CONFIG_REGISTRY", "PIP_INDEX_URL", "PIP_EXTRA_INDEX_URL", "UV_DEFAULT_INDEX"]) {
      const value = this.network.environment("runtime")[key];
      if (containerEnv[key] === undefined && value !== undefined && value !== "") containerEnv[key] = value;
    }
    if (spec.resources?.cpus !== undefined)
      containerEnv.NODE_OPTIONS = await cpuBudgetNodeOptions(this.command, launchImage, containerEnv.NODE_OPTIONS, signal);
    if (isolatedGateway) {
      if (allowlist) Object.assign(containerEnv, EGRESS_PROXY_ENV);
      gateway = await createModelGateway(this.command, {
        platform,
        preparedImage: receipt?.gatewayImage ?? nodeRuntime.nodeImage,
        ...(this.modelEndpoint ? { endpoint: this.modelEndpoint } : {}),
        ...(allowlist ? { allowedHosts: allowlist.allowedHosts } : {}),
        key,
        phase,
        // Only the gateway talks to the outside; it may use the coordinator's
        // proxy for that egress, but never the npm registry variable.
        proxyEnv: gatewayProxyEnv(forwardedEnv.filter(entry => entry !== "--env")),
        signal,
      });
      volumeMounts.push({ source: gateway.volume, target: GATEWAY_SOCKET_TARGET });
    }
    const createArgs = [
      "create",
      // Reap orphaned solver children and forward shutdown through a native
      // PID 1, including when the task's Node runtime is emulated on ARM.
      "--init",
      "--platform",
      platform,
      ...labels.flatMap(([name, value]) => ["--label", `ember.${name}=${value.replace(/[\u0000-\u001f\u007f]/gu, "_")}`]),
      ...Object.entries(containerEnv).flatMap(([key, value]) => ["--env", `${key}=${value}`]),
      "--add-host", "host.docker.internal:host-gateway",
      ...(isolatedGateway ? [] : forwardedEnv),
      ...(spec.extraHosts ?? []).flatMap(host => ["--add-host", host]),
      ...mounts.map(mount => ["--mount", `type=bind,source=${mount.source},target=${mount.target}`]).flat(),
      ...volumeMounts.map(mount => ["--mount", `type=volume,source=${mount.source},target=${mount.target},readonly`]).flat(),
    ];
    if (spec.network === "none" || isolatedGateway) createArgs.push("--network", "none");
    if (spec.network === "host") createArgs.push("--network", "host");
    if (spec.resources?.cpus !== undefined) createArgs.push("--cpus", String(spec.resources.cpus));
    if (spec.resources?.memory !== undefined) createArgs.push("--memory", spec.resources.memory);
    if (receipt) createArgs.push("--pull", "never");
    createArgs.push("--entrypoint", EVALUATOR_NODE_EXECUTABLE, launchImage, PROCESS_HELPER, "idle");
    let containerId: string | null = null;
    let project: DockerComposeProject | undefined;
    try {
      signal.throwIfAborted();
      // Docker create is intentionally allowed to return its ID after an
      // in-flight cancellation so the labeled partial resource can be removed.
      if (spec.services) {
        project = new DockerComposeProject(this.command, this.dockerExecutable, spec, paths, key, phase);
        const labelMap = Object.fromEntries(labels.map(([name, value]) => [`ember.${name}`, value.replace(/[\u0000-\u001f\u007f]/gu, "_")]));
        containerId = await project.create({ image: launchImage, platform, init: true,
          command: [EVALUATOR_NODE_EXECUTABLE, PROCESS_HELPER, "idle"], environment: containerEnv, labels: labelMap,
          ...(spec.network === "none" || isolatedGateway ? { network_mode: "none" } : {}),
          ...(spec.network === "host" ? { network_mode: "host" } : {}),
          volumes: [
            ...mounts.map(mount => ({ type: "bind", source: mount.source, target: mount.target })),
            ...volumeMounts.map(mount => ({ type: "volume", source: mount.source, target: mount.target, read_only: true })),
          ],
          ...(spec.resources?.cpus === undefined ? {} : { cpus: spec.resources.cpus }),
          ...(spec.resources?.memory === undefined ? {} : { mem_limit: spec.resources.memory }) }, receipt?.serviceImages ?? {}, labelMap, signal);
      } else containerId = (await this.command(createArgs)).stdout.trim();
      if (!/^[a-f0-9]{12,64}$/u.test(containerId))
        throw new DockerEnvironmentError("ENV_CONTAINER_START_FAILED", "Docker returned an invalid container ID");
      await this.command(["start", containerId], { signal });
      const logOwners = await captureDockerLogOwnership(this.command, containerId, mounts.map(mount => mount.target), signal);
      await makeDockerLogsWritable(this.command, containerId, logOwners, signal);
      const cpuVisibility = spec.resources?.cpus === undefined ? undefined
        : await constrainDockerCpus(this.command, containerId, spec.resources.cpus, signal);
      const runtimes = await preflightRuntimes(this.command, containerId, spec.runtime, signal, platform);
      if (solverImage?.runtime.stateRoot) {
        await this.command(
          [
            "exec",
            containerId,
            EVALUATOR_NODE_EXECUTABLE,
            PROCESS_HELPER,
            "mkdir",
            solverImage.runtime.stateRoot,
            solverImage.runtime.stateRoot,
            "directory",
          ],
          { signal },
        );
      }
      await this.command(
        ["exec", containerId, EVALUATOR_NODE_EXECUTABLE, PROCESS_HELPER, "mkdir", workdir, `${workdir}/.evaluator-placeholder`],
        { signal },
      );
      for (const file of spec.initialFiles) {
        const requested = resolve(file.source);
        await assertLinkFree(requested, "initial file source");
        const source = await realpath(requested);
        const sourceStat = await lstat(source);
        const destination = containerFileTarget(workdir, file.target);
        await this.command(
          [
            "exec",
            containerId,
            EVALUATOR_NODE_EXECUTABLE,
            PROCESS_HELPER,
            "mkdir",
            destination.root,
            destination.target,
            sourceStat.isDirectory() ? "directory" : "file",
          ],
          { signal },
        );
        await this.command(
          ["cp", sourceStat.isDirectory() ? `${source}${sep}.` : source, `${containerId}:${destination.target}`],
          { signal, maxBuffer: 8 * 1024 * 1024 },
        );
      }
      if (gateway) {
        // The loopback forwarder bridges container-local HTTP to the shared
        // gateway socket; it dies with the container on dispose or recovery.
        await startModelForwarder(this.command, containerId, signal);
      }
      for (const user of new Set(Object.values(spec.executionUsers ?? {}))) {
        if (!/^[a-z_][a-z0-9_-]*$/u.test(user)) throw new TypeError("Invalid environment execution user");
        if (user === "root") continue;
        // Match WorkBuddy ensure_agent_user: create the account and grant its
        // workspace, leaving challenge ownership from the task image intact.
        const setup = 'u="$1"; if ! id "$u" >/dev/null 2>&1; then if command -v useradd >/dev/null 2>&1; then useradd -m -s /bin/bash "$u"; elif command -v adduser >/dev/null 2>&1; then adduser -D -s /bin/sh "$u"; else exit 1; fi; fi; mkdir -p /workspace; chown -R "$u" /workspace; git config --system --add safe.directory /workspace 2>/dev/null || true; git config --system --add safe.directory "*" 2>/dev/null || true';
        await this.command(["exec", "--user", "0", containerId, "sh", "-c", setup, "setup-user", user], { signal });
      }
      if (spec.healthcheck) await waitTaskHealth(this.command, containerId, spec.healthcheck, signal);
      const raw = JSON.parse((await this.command(["inspect", containerId], { signal })).stdout) as Array<{
        HostConfig?: { NanoCpus?: number; Memory?: number };
      }>;
      const host = raw[0]?.HostConfig;
      const metadata: DockerMetadata = {
        ...(spec.executionUsers === undefined ? {} : { executionUsers: spec.executionUsers }),
        kind: "docker",
        phase,
        platform,
        platformResolution: resolution,
        containerId,
        baseImage: { reference: baseImage.reference, id: baseImage.id },
        ...(project ? { services: { project: project.name, containers: project.identities } } : {}),
        derivedImage: { reference: solverImage?.image ?? runtime.image, id: solverImage?.digest ?? runtime.digest },
        runtimes,
        ...(solverImage ? { installation: solverImage.runtime } : {}),
        ...(gateway && modelPolicy
          ? {
              modelEndpoint: {
                baseUrl: `http://127.0.0.1:${MODEL_FORWARDER_PORT}${modelPolicy.pathPrefix}`,
                originEndpoint: this.modelEndpoint!,
                gateway: { containerId: gateway.containerId, image: gateway.image, volume: gateway.volume },
              },
            }
          : !isolatedGateway && spec.network !== "none" && spec.network !== "host" && this.modelEndpoint && dockerHostModelEndpoint(this.modelEndpoint) !== this.modelEndpoint
            ? { modelEndpoint: { baseUrl: dockerHostModelEndpoint(this.modelEndpoint), originEndpoint: this.modelEndpoint } }
            : {}),
        resources: {
          requested: {
            cpus: spec.resources?.cpus ?? null,
            memory: spec.resources?.memory ?? null,
            storage: spec.resources?.storage ?? null,
          },
          effective: {
            cpus: host?.NanoCpus ? host.NanoCpus / 1_000_000_000 : null,
            memoryBytes: host?.Memory || null,
            storage: { enforced: false },
            ...cpuVisibility,
          },
        },
      };
      return new DockerSession(
        containerId,
        workdir,
        "/logs/agent",
        "/logs/verifier",
        this.dockerExecutable,
        this.command,
        metadata,
        logOwners,
        gateway,
        project,
      );
    } catch (error) {
      if (project) {
        try { await project.dispose(AbortSignal.timeout(30_000)); }
        catch (cleanup) { throw new DockerEnvironmentError("CLEANUP_FAILED", "Task service group cleanup could not be confirmed", new AggregateError([error, cleanup])); }
        throw error;
      }
      let failure = error;
      if (containerId) {
        try { await rethrowPreparationFailure(this.command, containerId, error); }
        catch (error) { failure = error; }
      }
      try { await gateway?.dispose(); }
      catch (cleanupError) {
        throw new DockerEnvironmentError("CLEANUP_FAILED", "Failed to release preparation gateway", new AggregateError([failure, cleanupError]));
      }
      throw failure;
    }
  }
}

export async function rethrowPreparationFailure(
  command: DockerCommand,
  containerId: string,
  primary: unknown,
): Promise<never> {
  try {
    await command(["rm", "--force", containerId], { signal: AbortSignal.timeout(10_000) });
  } catch (cleanup) {
    throw new DockerEnvironmentError(
      "CLEANUP_FAILED",
      `Docker container ${containerId} preparation failed and cleanup also failed`,
      new AggregateError([primary, cleanup]),
      containerId,
    );
  }
  const code = declaredErrorCode(primary) ?? "ENV_PREPARATION_FAILED";
  const message = primary instanceof Error ? primary.message : String(primary);
  throw new DockerEnvironmentError(
    code,
    `Docker container ${containerId} preparation failed: ${message}`,
    primary,
    containerId,
  );
}
