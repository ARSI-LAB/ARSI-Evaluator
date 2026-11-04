import { build } from "esbuild";
import { mkdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = join(packageRoot, "dist");
await rm(outputRoot, { recursive: true, force: true });
await mkdir(outputRoot, { recursive: true });

await build({
  entryPoints: [join(packageRoot, "index.ts"), join(packageRoot, "cli.ts")],
  bundle: true,
  packages: "external",
  external: ["ember-evaluator"],
  platform: "node",
  format: "esm",
  target: "node24",
  outdir: outputRoot,
});