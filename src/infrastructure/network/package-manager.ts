import { lstat, realpath } from "node:fs/promises";
import { basename, delimiter, dirname, join } from "node:path";

/** Resolve JavaScript entry points without passing installer arguments through cmd.exe. */
export async function packageManagerCli(name: "npm" | "pnpm"): Promise<string> {
  const paths = [dirname(process.execPath), ...(process.env.PATH ?? "").split(delimiter)]
    .map(path => path.replace(/^"|"$/gu, "")).filter(Boolean);
  for (const path of new Set(paths)) {
    const candidates = [join(path, "node_modules", name, "bin", name === "npm" ? "npm-cli.js" : "pnpm.cjs"),
      ...(name === "pnpm" ? [join(path, "node_modules/corepack/dist/pnpm.js")] : [])];
    for (const candidate of candidates) {
      try { if ((await lstat(candidate)).isFile()) return await realpath(candidate); }
      catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
    }
    // Unix installations commonly expose bin/npm -> ../lib/node_modules/npm/bin/npm-cli.js.
    // Resolve the JavaScript target, never a shell or native launcher passed to Node.
    try {
      const executable = join(path, name);
      if ((await lstat(executable)).isSymbolicLink()) {
        const target = await realpath(executable);
        const entrypoints = name === "npm" ? ["npm-cli.js", "npm.js"] : ["pnpm.cjs", "pnpm.js"];
        if (entrypoints.includes(basename(target)) && (await lstat(target)).isFile()) return target;
      }
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
  }
  throw new Error(`Cannot locate installed ${name} beside Node or on PATH`);
}
