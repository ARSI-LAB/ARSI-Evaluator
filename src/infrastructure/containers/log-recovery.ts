import { posix } from "node:path";
import type { AttemptKey } from "../../core/contracts/result.js";
import { stopDockerContainer } from "./cleanup.js";
import { DockerEnvironmentError } from "./error.js";
import { restoreLogOwnersSource } from "./log-ownership.js";
import { EVALUATOR_NODE_EXECUTABLE, type DockerCommand } from "./runtime-contract.js";

const logPaths = new Set(["/logs", "/logs/agent", "/logs/verifier"]);
const attemptMount = "/run/evaluator-attempt";
const recoverLogOwnersSource = String.raw`
import { lstat } from "node:fs/promises";
const root = "${attemptMount}";
const committed = await lstat(root + "/result.json").catch(error => {
  if (error.code === "ENOENT") return null;
  throw error;
});
// A committed result already has a checksummed file inventory.
if (committed) process.exit(0);
const { uid, gid } = await lstat(root);
const owners = [];
for (const path of JSON.parse(process.argv[1])) {
  const stat = await lstat(path);
  // Legacy containers do not persist the original mode of an open mount.
  const mode = (stat.mode & 0o7777) === 0o777 ? 0o700 : undefined;
  owners.push({ path, uid, gid, mode });
}
process.argv[1] = JSON.stringify(owners);
` + restoreLogOwnersSource;

type InspectedContainer = {
  Config?: { Labels?: Record<string, string> };
  Image?: string;
  Mounts?: { Type: string; Source: string; Destination: string; RW: boolean }[];
};

function attemptLogMounts(container: InspectedContainer, attemptId: string): { source: string; target: string }[] {
  return (container.Mounts ?? []).flatMap(mount => {
    const target = mount.Destination;
    if (mount.Type !== "bind" || !mount.RW || !logPaths.has(target)) return [];
    const source = mount.Source.replaceAll("\\", "/");
    // Gateways, sidecars and private verifiers can share the attempt labels.
    // Only DockerEnvironment binds these attempt directories as log mounts.
    if (posix.basename(source) !== posix.basename(target) || posix.basename(posix.dirname(source)) !== attemptId) return [];
    return [{ source: mount.Source, target }];
  });
}

function label(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/gu, "_");
}

async function restoreMounts(
  command: DockerCommand, image: string | undefined, mounts: { source: string; target: string }[], signal: AbortSignal,
): Promise<void> {
  if (!image || !/^sha256:[a-f0-9]{64}$/u.test(image)) throw new Error("Invalid Docker recovery image identity");
  const roots = new Set(mounts.map(mount => posix.dirname(mount.source.replaceAll("\\", "/"))));
  const [attemptRoot] = roots;
  if (roots.size !== 1 || !attemptRoot) throw new Error("Docker recovery log mounts disagree on the attempt directory");
  // Use the original image's Node runtime without running the task entrypoint.
  await command(["run", "--rm", "--pull", "never", "--network", "none", "--no-healthcheck", "--read-only",
    "--user", "0:0", "--workdir", "/", "--entrypoint", EVALUATOR_NODE_EXECUTABLE,
    "--mount", `type=bind,source=${attemptRoot},target=${attemptMount},readonly`,
    ...mounts.flatMap(({ source, target }) => ["--mount", `type=bind,source=${source},target=${target}`]),
    image, "--input-type=module", "-e", recoverLogOwnersSource, JSON.stringify(mounts.map(mount => mount.target))], { signal });
}

/** Give interrupted attempts' log mounts back to the host before deleting their containers. */
export async function restoreInterruptedDockerLogs(command: DockerCommand, keys: AttemptKey[], signal: AbortSignal): Promise<void> {
  const runs = new Map<string, Set<string>>();
  for (const key of keys) {
    const run = label(key.runId);
    const attempts = runs.get(run) ?? new Set<string>();
    attempts.add(JSON.stringify([label(key.taskId), label(key.attemptId)]));
    runs.set(run, attempts);
  }
  for (const [run, attempts] of runs) {
    signal.throwIfAborted();
    const output = await command(["ps", "--all", "--quiet", "--filter", `label=ember.run=${run}`], { signal });
    const ids = output.stdout.trim().split(/\s+/u).filter(Boolean);
    const containers = [];
    for (const id of ids) {
      if (!/^[a-f0-9]{12,64}$/u.test(id)) throw new Error("Invalid Docker container identity during log recovery");
      const inspected = JSON.parse((await command(["inspect", id], { signal })).stdout) as InspectedContainer[];
      const container = inspected[0];
      const labels = container?.Config?.Labels;
      const attempt = labels?.["ember.attempt"];
      if (!container || !labels || !attempt || labels["ember.run"] !== run ||
          !["solve", "verify"].includes(labels["ember.phase"] ?? "") ||
          !attempts.has(JSON.stringify([labels["ember.task"], attempt]))) continue;
      const mounts = attemptLogMounts(container, attempt);
      if (mounts.length) containers.push({ id, image: container.Image, mounts });
    }
    for (const { id } of containers) await stopDockerContainer(command, id, signal);
    for (const { id, image, mounts } of containers) {
      try {
        await restoreMounts(command, image, mounts, signal);
      } catch (cause) {
        signal.throwIfAborted();
        // Keep the original container and its mount information for a retry.
        throw new DockerEnvironmentError("CLEANUP_FAILED", `Cannot restore log ownership for interrupted Docker container ${id}`, cause, id);
      }
    }
  }
}
