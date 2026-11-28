import { build } from "esbuild";
import { fileURLToPath } from "node:url";

await build({ entryPoints: [fileURLToPath(new URL("../index.ts", import.meta.url))],
  outfile: fileURLToPath(new URL("../dist/index.js", import.meta.url)),
  bundle: true, packages: "external", platform: "node", format: "esm", target: "node24" });
