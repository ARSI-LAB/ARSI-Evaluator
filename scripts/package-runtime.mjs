import { createHash } from "node:crypto";
import { readFile, readdir, writeFile, cp, mkdir, rm, rename } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { sourceFingerprint } from "./source-fingerprint.mjs";

async function normalizeRuntimeFile(file) {
  const content = await readFile(file, "utf8");
  await writeFile(file, content.replace(/\r\n?/gu, "\n"));
}

async function normalizeRuntimeText(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = new URL(entry.name + (entry.isDirectory() ? "/" : ""), directory);
    if (entry.isDirectory()) await normalizeRuntimeText(path);
    else if (entry.isFile() && (entry.name === "Dockerfile" || /\.(?:m?js|json|py|txt|ya?ml)$/u.test(entry.name))) await normalizeRuntimeFile(path);
  }
}

// Local development uses pnpm, while container installation still uses npm ci.
// Fail at build time instead of shipping a stale npm runtime lock to workers.
const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const lock = JSON.parse(await readFile(new URL("../package-lock.json", import.meta.url), "utf8"));
const lockedManifest = lock.packages?.[""];
for (const field of ["dependencies", "devDependencies", "optionalDependencies"]) {
  if (!lockedManifest || !isDeepStrictEqual(manifest[field] ?? {}, lockedManifest[field] ?? {})) {
    throw new Error(`package-lock.json is out of sync with package.json (${field}); run npm install --package-lock-only --ignore-scripts to update the container runtime lock`);
  }
}

// The Pi runtime installs registry dependencies with npm ci. Git subdirectory
// packages are copied into their own runtime layer and must not be resolved by npm.
const runtimeManifest = structuredClone(manifest);
const runtimeLock = structuredClone(lock);
for (const field of ["dependencies", "devDependencies", "optionalDependencies"]) {
  for (const [name, specifier] of Object.entries(manifest[field] ?? {})) {
    if (typeof specifier !== "string" || !/^(?:git\+|git@|workspace:|link:)/u.test(specifier)) continue;
    delete runtimeManifest[field]?.[name];
    delete runtimeLock.packages[""][field]?.[name];
    delete runtimeLock.packages[`node_modules/${name}`];
  }
}
await writeFile(new URL("../dist/adapters/harness/pi/runtime-package.json", import.meta.url),
  JSON.stringify(runtimeManifest, null, 2) + "\n");
await writeFile(new URL("../dist/adapters/harness/pi/runtime-lock.json", import.meta.url),
  JSON.stringify(runtimeLock, null, 2) + "\n");

const root = new URL("../dist/adapters/harness/pi/", import.meta.url);
await cp(new URL("../src/adapters/harness/pi/model-defaults.json", import.meta.url), new URL("model-defaults.json", root));
// The standalone Pi runner must carry the same error classifier as the coordinator.
// Copy only its runtime dependencies and rewrite imports before hashing the Pi bundle.
const errorAssets = new Map([
  ["../../../core/errors/classify.js", "runtime-classify.js"],
  ["../../../core/errors/network-failure.js", "runtime-network-failure.js"],
  ["../../../core/errors/evaluator-error.js", "runtime-evaluator-error.js"],
  ["../../../core/errors/registry.js", "runtime-error-registry.js"],
  ["../../../core/diagnostics.js", "runtime-diagnostics.js"],
  ["../../../core/live-progress.js", "runtime-live-progress.js"],
]);
for (const [relative, name] of errorAssets) {
  let contents = await readFile(new URL(relative, root), "utf8");
  for (const [reference, target] of [
    ["./network-failure.js", "runtime-network-failure.js"], ["./evaluator-error.js", "runtime-evaluator-error.js"],
    ["./registry.js", "runtime-error-registry.js"], ["../diagnostics.js", "runtime-diagnostics.js"],
    ["./diagnostics.js", "runtime-diagnostics.js"],
  ]) contents = contents.replaceAll(`"${reference}"`, `"./${target}"`);
  await writeFile(new URL(name, root), contents);
}
for (const name of (await readdir(root)).filter(name => name.endsWith(".js"))) {
  let contents = await readFile(new URL(name, root), "utf8");
  for (const [relative, target] of errorAssets) contents = contents.replaceAll(`"${relative}"`, `"./${target}"`);
  await writeFile(new URL(name, root), contents);
}
await normalizeRuntimeText(root);
const names = (await readdir(root)).filter(name => name === "runtime-lock.json" || name === "runtime-package.json" || name === "model-defaults.json" || name.endsWith(".js")).sort();
const files = {};
for (const name of names) {
  files[name] = `sha256:${createHash("sha256").update(await readFile(new URL(name, root))).digest("hex")}`;
}
const body = { schemaVersion: 1, algorithm: "sha256", files };
const digest = `sha256:${createHash("sha256").update(JSON.stringify(body)).digest("hex")}`;
await writeFile(new URL("builtin-provenance.json", root), JSON.stringify({ ...body, digest }, null, 2) + "\n");

// Python is an explicit distributed runtime asset, not generated from a JS closure.
const python = new URL("../src/adapters/ray/python/", import.meta.url);
const verifierPython = new URL("../dist/adapters/verifiers/python/", import.meta.url);
await mkdir(verifierPython, { recursive: true });
for (const name of ["worker.py", "workbuddy.py", "Dockerfile", "build-runtime.py"]) {
  await cp(new URL(`../src/adapters/verifiers/python/${name}`, import.meta.url), new URL(name, verifierPython));
  await normalizeRuntimeFile(new URL(name, verifierPython));
}
try {
  await mkdir(new URL("../dist/adapters/ray/python/", import.meta.url), { recursive: true });
  await cp(python, new URL("../dist/adapters/ray/python/", import.meta.url), { recursive: true, filter: source => !source.includes("__pycache__") });
} catch (error) { if (error.code !== "ENOENT") throw error; }
// Normalize copied text assets before hashing so Windows and Linux builds
// reproduce the fixed hashes embedded in the AgentBundle CLI provenance.
await normalizeRuntimeText(new URL("../dist/adapters/ray/python/", import.meta.url));
const distribution = new URL("../dist/", import.meta.url);
// Keep third-party notices with the copied scoring templates and ports.
await cp(new URL("../src/plugins/benchmarks/definitions/scoring/LICENSE-MIT", import.meta.url),
  new URL("plugins/benchmarks/definitions/scoring/LICENSE-MIT", distribution));
const officeqaAssets = new URL("adapters/verifiers/officeqa/", distribution);
await mkdir(officeqaAssets, { recursive: true });
for (const name of ["reward.py", "LICENSE-APACHE", "NOTICE"]) {
  await cp(new URL(`../src/adapters/verifiers/officeqa/${name}`, import.meta.url), new URL(name, officeqaAssets));
}
// kernel verification and profiling assets ride with the compiled protocol.
const kernelKernelAssets = new URL("../dist/adapters/kernel/", import.meta.url);
await mkdir(kernelKernelAssets, { recursive: true });
for (const name of ["precision.py", "timing.py", "msprof_replay.py"]) {
  await cp(new URL(`../src/adapters/kernel/${name}`, import.meta.url), new URL(name, kernelKernelAssets));
  await normalizeRuntimeFile(new URL(name, kernelKernelAssets));
}
await cp(new URL("../src/plugins/benchmarks/profiles/", import.meta.url),
  new URL("plugins/benchmarks/profiles/", distribution), { recursive: true });
// Keep the checkout entrypoint stable so it can refresh stale compiled code.
await rename(new URL("cli.js", distribution), new URL("cli-runtime.js", distribution));
await writeFile(new URL("cli.js", distribution), await readFile(new URL("./cli-bootstrap.mjs", import.meta.url)));
await writeFile(new URL("source-provenance.json", distribution),
  JSON.stringify({ schemaVersion: 1, digest: await sourceFingerprint() }, null, 2) + "\n");
// Fixed standalone upstream CLI and locked harness recipes travel with npm packs.
  for (const directory of ["harness/dsh", "harness/deepagents", "harness/dify", "harness/jiuwenswarm", "harness/hermes", "harness/agentx"]) {
  const target = new URL(`../dist/adapters/${directory}/assets/`, import.meta.url);
  await mkdir(target, { recursive: true });
  await cp(new URL(`../src/adapters/${directory}/assets/`, import.meta.url), target, { recursive: true });
  await normalizeRuntimeText(target);
}
const agentBundleAssets = new URL("../dist/adapters/agentbundle/assets/", import.meta.url);
await mkdir(agentBundleAssets, { recursive: true });
await cp(new URL("../src/adapters/agentbundle/assets/run.mjs", import.meta.url),
  new URL("run.mjs", agentBundleAssets));
// Cluster Jobs runtime is shipped and hashed with the same package as the CLI.
for (const name of ["jobs-entry", "jobs-gateway", "jobs-retry-entry"]) {
  const code = await readFile(new URL(`../src/adapters/ray/runtime/${name}.mjs`, import.meta.url), "utf8");
  await writeFile(new URL(`adapters/ray/${name}.js`, distribution), code.replaceAll("../../../../dist/", "../../"));
}
// Source checkouts may use CRLF on Windows while Docker builds from LF files.
// Canonicalize every packaged text file before computing byte-level provenance.
await normalizeRuntimeText(distribution);
const distributionFiles = {};
async function scan(directory, prefix = "") {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix + entry.name;
    if (entry.isDirectory()) await scan(new URL(entry.name + "/", directory), relative + "/");
    else if (/(?:\.(?:m?js|json|py|txt|ya?ml)$|(?:^|\/)Dockerfile$)/.test(relative) && relative !== "package-provenance.json") distributionFiles[relative] = `sha256:${createHash("sha256").update(await readFile(new URL(entry.name, directory))).digest("hex")}`;
  }
}
await scan(distribution);
const sortedFiles = Object.entries(distributionFiles).sort(([a], [b]) => {
  if (a === b) return 0;
  return a < b ? -1 : 1;
});
const distributionBody = { schemaVersion: 1, algorithm: "sha256", files: Object.fromEntries(sortedFiles) };
await writeFile(new URL("package-provenance.json", distribution), JSON.stringify({ ...distributionBody, digest: `sha256:${createHash("sha256").update(JSON.stringify(distributionBody)).digest("hex")}` }, null, 2) + "\n");
