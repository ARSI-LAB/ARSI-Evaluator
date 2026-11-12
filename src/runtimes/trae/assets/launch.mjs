import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { stageAttachments } from "./stage-attachments.mjs";

const [home, ...args] = process.argv.slice(2);
const { apiKey, prompt, media } = JSON.parse(readFileSync(0, "utf8"));
const root = import.meta.dirname;
const entry = join(root, process.platform === "win32" ? "traecli.exe" : "traecli");
await mkdir(home, { mode: 0o700 });
try {
  // This release also discovers ~/.agents/skills on the host outside TRAE_HOME.
  // Disable those paths in the attempt config without reading or copying skill content.
  const hostSkills = join(homedir(), ".agents", "skills");
  const entries = await readdir(hostSkills, { withFileTypes: true }).catch(error => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const config = entries.filter(entry => entry.isDirectory() || entry.isSymbolicLink()).map(entry => {
    const skill = join(hostSkills, entry.name, "SKILL.md");
    const path = process.platform === "win32" ? skill.replaceAll("\\", "/") : skill;
    return `[[skills.config]]\npath = ${JSON.stringify(path)}\nenabled = false\n`;
  });
  await writeFile(join(home, "traecli.toml"), config.join("\n"), { flag: "wx", mode: 0o600 });
  const images = await stageAttachments(home, media);
  if (images.length) args.splice(-1, 0, ...images.map(path => `--image=${path}`));
  // Docker passes CommandSpec.env in docker exec arguments, so receive the key over stdin.
  const env = { ...process.env, HOME: home, USERPROFILE: home, TRAE_HOME: home, CODEX_HOME: home, EVALUATOR_TRAE_API_KEY: apiKey };
  if (process.platform === "linux") {
    env.PATH = [join(root, "traecli-resources"), process.env.PATH].filter(Boolean).join(delimiter);
  }
  const cli = spawn(entry, args, { env, stdio: ["pipe", "inherit", "inherit"], windowsHide: true });
  const exited = new Promise((resolve, reject) => {
    cli.once("error", reject);
    cli.once("close", code => resolve(code ?? 1));
    cli.stdin.on("error", error => {
      if (error.code !== "EPIPE") reject(error);
    });
  });
  const terminate = () => { cli.kill("SIGTERM"); };
  process.once("SIGTERM", terminate);
  try {
    cli.stdin.end(prompt, "utf8");
    process.exitCode = await exited;
  } finally {
    process.removeListener("SIGTERM", terminate);
  }
} finally {
  await rm(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
