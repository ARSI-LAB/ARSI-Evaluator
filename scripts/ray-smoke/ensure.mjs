import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { readFile, readdir, lstat, mkdir, mkdtemp, cp, realpath, rm } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const bundleDirectory = process.env.EVALUATOR_BUNDLE_DIR?.trim() || null;
const composeFiles = [
  "scripts/ray-smoke/compose.yaml",
  "scripts/ray-smoke/jobs.yaml",
  ...(bundleDirectory === null ? [] : ["scripts/ray-smoke/jobs-agentbundle.yaml"]),
];
const composeArgs = composeFiles.flatMap(file => ["-f", file]);
const imageName = "evaluator-ray-smoke:local";
const fingerprintLabel = "org.ember.evaluator.source-fingerprint";
const appServices = ["head", "worker-a", "worker-b", "gateway", "coordinator"];
const dependencyServices = ["docker-a", "docker-b"];
const requiredServices = [...appServices, ...dependencyServices];

/** Docker contexts cannot follow pnpm workspace links outside the repository. */
export async function stageDeploymentBuildContext(workspace = root) {
  const scratch = join(workspace, ".scratch");
  await mkdir(scratch, { recursive: true });
  const directory = await mkdtemp(join(scratch, "ray-build-"));
  const dispose = async () => {
    const target = await realpath(directory);
    if (dirname(target) !== await realpath(scratch) || basename(target) !== basename(directory))
      throw new Error("Refusing to remove an unexpected Ray build directory");
    await rm(target, { recursive: true, force: true });
  };
  try {
    for (const path of ["dist", "scripts", "tests/fixtures/ray/plugin.mjs"]) {
      const destination = join(directory, path);
      await mkdir(dirname(destination), { recursive: true });
      await cp(join(workspace, path), destination, { recursive: true });
    }
    const sdk = await realpath(join(workspace, "node_modules/agent-bundle-core"));
    const destination = join(directory, "node_modules/agent-bundle-core");
    await mkdir(destination, { recursive: true });
    for (const path of ["package.json", "dist"]) await cp(join(sdk, path), join(destination, path), { recursive: true });
    return { directory, dispose };
  } catch (error) { await dispose(); throw error; }
}

async function collectFiles(path, files) {
  const stat = await lstat(path);
  if (stat.isSymbolicLink()) throw new Error(`Build input is a symlink: ${path}`);
  if (stat.isDirectory()) {
    for (const name of (await readdir(path)).sort()) await collectFiles(join(path, name), files);
  } else if (stat.isFile()) {
    files.push(path);
  } else {
    throw new Error(`Unsupported build input: ${path}`);
  }
}

export async function deploymentFingerprint(packageDigest, workspace = root) {
  if (!/^sha256:[a-f0-9]{64}$/u.test(packageDigest)) throw new Error("Invalid package digest");
  const files = [];
  for (const path of [
    "scripts",
    "tests/fixtures/ray/plugin.mjs",
    "node_modules/agent-bundle-core/package.json",
    "node_modules/agent-bundle-core/dist",
  ]) await collectFiles(join(workspace, path), files);
  files.sort((a, b) => a.localeCompare(b, "en"));
  const hash = createHash("sha256");
  hash.update(`package\0${packageDigest}\n`);
  for (const path of files) {
    const name = relative(workspace, path).split(sep).join("/");
    const digest = createHash("sha256").update(await readFile(path)).digest("hex");
    hash.update(`${name}\0${digest}\n`);
  }
  return hash.digest("hex");
}

async function capture(args, env = process.env, allowFailure = false) {
  try {
    const result = await execFileAsync("docker", args, { cwd: root, env, windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
    return { ok: true, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
  } catch (cause) {
    const stderr = typeof cause.stderr === "string" ? cause.stderr.trim() : "";
    if (allowFailure) return { ok: false, stdout: "", stderr };
    throw new Error(`docker ${args.slice(0, 2).join(" ")} failed: ${stderr || cause.message}`, { cause });
  }
}

async function execute(args, env) {
  const code = await new Promise((resolveCode, reject) => {
    const child = spawn("docker", args, { cwd: root, env, stdio: "inherit", windowsHide: true });
    child.on("error", reject);
    child.on("exit", exitCode => resolveCode(exitCode));
  });
  if (code !== 0) throw new Error(`docker ${args.slice(0, 2).join(" ")} exited with code ${code ?? "unknown"}`);
}

async function imageState() {
  const result = await capture(["image", "inspect", imageName], process.env, true);
  if (!result.ok) {
    if (/No such image|image.*not found/u.test(result.stderr)) return null;
    throw new Error(`Cannot inspect ${imageName}: ${result.stderr}`);
  }
  const image = JSON.parse(result.stdout)[0];
  if (!image || typeof image.Id !== "string") throw new Error("Invalid Docker image inspection result");
  return { id: image.Id, fingerprint: image.Config?.Labels?.[fingerprintLabel] ?? null };
}

async function serviceStates(env) {
  const result = await capture(["compose", ...composeArgs, "ps", "-a", "-q"], env);
  const ids = result.stdout.split(/\s+/u).filter(Boolean);
  if (!ids.length) return {};
  const inspected = JSON.parse((await capture(["inspect", ...ids], env)).stdout);
  const states = {};
  for (const container of inspected) {
    const name = container.Config?.Labels?.["com.docker.compose.service"];
    if (!requiredServices.includes(name)) continue;
    states[name] = {
      id: container.Id,
      networkDigest: container.Config?.Labels?.["org.ember.evaluator.network"] ?? null,
      imageId: container.Image,
      running: container.State?.Running === true,
      health: container.State?.Health?.Status ?? null,
      bundleDirectory: container.Config?.Env?.find(value => value.startsWith("EVALUATOR_BUNDLE_DIR="))?.slice("EVALUATOR_BUNDLE_DIR=".length) ?? null,
    };
  }
  return states;
}

function healthy(state) {
  return state?.running === true && (state.health === null || state.health === "healthy");
}

export function deploymentPlan(fingerprint, image, states, expectedBundleDirectory = null) {
  const build = image?.fingerprint !== fingerprint;
  const bundleMatches = ["head", "worker-a", "worker-b"].every(name =>
    (states[name]?.bundleDirectory ?? null) === expectedBundleDirectory);
  const ready = !build && bundleMatches && requiredServices.every(name =>
    healthy(states[name]) && (!appServices.includes(name) || states[name].imageId === image.id));
  const forceRecreate = !build && !ready && requiredServices.some(name => states[name] && !healthy(states[name]));
  return { build, ready, forceRecreate };
}

async function activeJobs(states, env) {
  if (!states.head?.running) return [];
  const code = [
    "import json",
    "from ray.job_submission import JobSubmissionClient",
    "client = JobSubmissionClient('http://127.0.0.1:8265')",
    "print(json.dumps([job.submission_id for job in client.list_jobs() if job.status.value in ('PENDING', 'RUNNING')]))",
  ].join("; ");
  const result = await capture(["exec", states.head.id, "python", "-c", code], env);
  const line = result.stdout.split(/\r?\n/u).findLast(text => text.startsWith("["));
  const jobs = JSON.parse(line ?? "null");
  if (!Array.isArray(jobs) || jobs.some(id => typeof id !== "string")) throw new Error("Invalid Ray Jobs status response");
  return jobs;
}

async function rayResources(headId, env) {
  const code = [
    "import json, ray",
    "ray.init(address='auto', log_to_driver=False)",
    "nodes = [node for node in ray.nodes() if node['Alive']]",
    "print(json.dumps({'nodes': len(nodes), 'slots': sum(node['Resources'].get('evaluator_slot', 0) for node in nodes)}))",
    "ray.shutdown()",
  ].join("; ");
  const result = await capture(["exec", headId, "python", "-c", code], env);
  const line = result.stdout.split(/\r?\n/u).findLast(text => text.startsWith("{"));
  return JSON.parse(line ?? "null");
}

async function waitForRay(headId, env, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  do {
    try {
      const resources = await rayResources(headId, env);
      if (resources?.nodes >= 3 && resources?.slots >= 2) return;
    } catch {
      // Workers may still be registering after Compose reports running containers.
    }
    if (Date.now() >= deadline) break;
    await delay(2000);
  } while (true);
  throw new Error("Ray did not register both evaluator workers before the readiness deadline");
}

async function main() {
  if (process.argv.length !== 2) throw new Error("Usage: pnpm ray:ensure");
  if (bundleDirectory !== null) {
    const info = await lstat(bundleDirectory);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error(`AgentBundle directory must be a regular directory: ${bundleDirectory}`);
    }
  }
  const manifest = JSON.parse(await readFile(join(root, "dist/package-provenance.json"), "utf8"));
  const { deploymentNetwork } = await import("../network/deployment.mjs");
  const access = await deploymentNetwork();
  try {
  const fingerprint = createHash("sha256").update(await deploymentFingerprint(manifest.digest)).update(access.network.document.digest).digest("hex");
  const override = await access.composeOverride(join(root, ".scratch/ray-smoke"), ["init", ...appServices], AbortSignal.timeout(300_000));
  composeArgs.push("-f", override.path);
  const env = { ...access.build.environment, ...override.env, EVALUATOR_SOURCE_FINGERPRINT: fingerprint };
  await capture(["info", "--format", "{{.ServerVersion}}"], env);
  const image = await imageState();
  const states = await serviceStates(env);
  for (const name of dependencyServices) {
    if (states[name] && states[name].networkDigest !== access.network.document.digest)
      throw new Error(`Network settings changed for ${name}; an administrator must explicitly recreate the Docker-in-Docker services before rerunning ensure. Existing daemons were not restarted.`);
  }
  let plan = deploymentPlan(fingerprint, image, states, bundleDirectory);
  if (plan.ready) {
    try {
      await waitForRay(states.head.id, env, 10_000);
      console.log("Reusing the local Ray Jobs cluster; it matches the current code.");
      return;
    } catch {
      plan = { ...plan, ready: false, forceRecreate: true };
    }
  }
  const jobs = await activeJobs(states, env);
  if (jobs.length) throw new Error(`The cluster still has running jobs (${jobs.join(", ")}); wait for them to finish before updating the environment`);
  if (plan.build) {
    console.log("Deployment inputs changed; building the local Ray image...");
    const context = await stageDeploymentBuildContext();
    try {
      await access.rewriteDockerfile(join(context.directory, "scripts/ray-smoke/Dockerfile"));
      await execute(["build", ...access.build.buildArgs, "--file", join(context.directory, "scripts/ray-smoke/Dockerfile"), "--tag", imageName,
        "--build-arg", `EVALUATOR_SOURCE_FINGERPRINT=${fingerprint}`, context.directory], env);
    } finally { await context.dispose(); }
    const built = await imageState();
    if (built?.fingerprint !== fingerprint) throw new Error("Built image fingerprint does not match current inputs");
  }
  console.log("Creating or updating the local Ray cluster...");
  await execute([
    "compose", ...composeArgs, "up", "-d", "--no-build", "--wait", "--wait-timeout", "120",
    ...(plan.forceRecreate ? ["--force-recreate"] : []),
  ], env);
  const updatedImage = await imageState();
  const updatedStates = await serviceStates(env);
  if (!deploymentPlan(fingerprint, updatedImage, updatedStates, bundleDirectory).ready) {
    throw new Error("Compose finished, but the cluster containers do not match the built image");
  }
  await waitForRay(updatedStates.head.id, env, 60_000);
  console.log("The local Ray Jobs cluster is ready for Jobs experiments from the playbook.");
  } finally { await access.dispose(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(`Ray environment preparation failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
