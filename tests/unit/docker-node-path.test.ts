import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { prepareSolverLayer } from "../../src/infrastructure/containers/solver-runtime.js";

const exec = promisify(execFile);

test("runtime probes inherit the trusted installer Node even without node on PATH", async () => {
  const root = await mkdtemp(join(tmpdir(), "runtime-node-path-"));
  try {
    const source = join(root, "package.json");
    await writeFile(source, "{}");
    const signal = new AbortController().signal;
    const layer = await prepareSolverLayer({ id: "node-path-regression", files: [{ source, target: "package.json" }],
      commands: [], probes: [{ executable: "node", args: ["-e", "console.log(process.execPath)"] }] }, "linux/amd64", signal);
    await layer.write(root, signal);
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== "PATH"));
    const result = await exec(process.execPath, [join(root, "install-runtime.mjs"), root, join(root, "probes.json")], {
      env: { ...env, PATH: "" },
    });
    expect(result.stdout.trim()).toBe(process.execPath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
