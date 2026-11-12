import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { x } from "tar";

const root = import.meta.dirname;
const { commit, sha256 } = JSON.parse(await readFile(join(root, "source-lock.json"), "utf8"));
const archive = join(root, "source.tar.gz");
const source = join(root, "source");
const pnpm = join(root, "node_modules", "pnpm", "bin", "pnpm.cjs");

async function runPnpm(args) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== "PATH"));
  const path = [dirname(process.execPath), join(root, "node_modules", ".bin"), process.env.PATH].filter(Boolean).join(delimiter);
  // Koffi's Windows prebuild installer requires a cache directory in the minimal runtime environment.
  if (process.platform === "win32") env.LOCALAPPDATA = join(root, "build-cache");
  const child = spawn(process.execPath, [pnpm, ...args], {
    cwd: source, env: { ...env, PATH: path, CI: "true", HUSKY: "0" },
    // pnpm reports failures on stdout, but the runtime installer surfaces stderr first.
    stdio: ["ignore", process.stderr, process.stderr], windowsHide: true,
  });
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  if (code !== 0) throw new Error(`ZCode pnpm ${args.join(" ")} failed with exit code ${code}`);
}

try {
  const mirror = process.env.EVALUATOR_GITHUB_MIRROR?.replace(/\/+$/u, "") ?? "https://github.com";
  const url = mirror === "https://github.com" ? `https://codeload.github.com/zai-org/ZCode/tar.gz/${commit}`
    : `${mirror}/zai-org/ZCode/archive/${commit}.tar.gz`;
  const response = await fetch(url, {
    signal: AbortSignal.timeout(600_000),
  });
  if (!response.ok || !response.body) throw new Error(`ZCode source download failed with HTTP ${response.status}`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(archive, { flags: "wx" }));
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(archive)) hash.update(chunk);
  if (hash.digest("hex") !== sha256) throw new Error("ZCode source archive checksum does not match the runtime lock");
  await mkdir(source);
  await x({ file: archive, cwd: source, strip: 1, strict: true, preserveOwner: false });
  // Hoisted installs fetch unrelated desktop packages even with a workspace filter.
  // Keep the two workspace roots for their shared build tools.
  await runPnpm(["--filter", "@zcode/cli...", "--filter", "zcode", "--filter", "zcode-cli",
    "install", "--config.node-linker=isolated", "--frozen-lockfile"]);
  await runPnpm(["--filter", "@zcode/cli...", "build"]);
} finally {
  await rm(archive, { force: true });
}
