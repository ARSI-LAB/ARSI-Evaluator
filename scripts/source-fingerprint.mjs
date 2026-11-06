import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const buildInputs = [
  "src",
  "scripts",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "package-lock.json",
  "tsconfig.json",
  "tsconfig.build.json",
];

async function filesAt(path, files) {
  const stat = await lstat(path);
  if (stat.isSymbolicLink()) throw new Error(`Build input is a symlink: ${path}`);
  if (stat.isDirectory()) {
    for (const name of (await readdir(path)).sort()) {
      // Python imports can create bytecode during tests without changing build inputs.
      if (name === "__pycache__" || /\.py[co]$/u.test(name)) continue;
      await filesAt(join(path, name), files);
    }
  } else if (stat.isFile()) {
    files.push(path);
  } else {
    throw new Error(`Unsupported build input: ${path}`);
  }
}

export async function sourceFingerprint(workspace = root) {
  const files = [];
  for (const input of buildInputs) await filesAt(join(workspace, input), files);
  files.sort((a, b) => a.localeCompare(b, "en"));
  const digest = createHash("sha256");
  for (const path of files) {
    const name = relative(workspace, path).split(sep).join("/");
    const fileDigest = createHash("sha256").update(await readFile(path)).digest("hex");
    digest.update(`${name}\0${fileDigest}\n`);
  }
  return `sha256:${digest.digest("hex")}`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stdout.write((await sourceFingerprint()) + "\n");
}
