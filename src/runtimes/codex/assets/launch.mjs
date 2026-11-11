import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";

const [home, entry, ...args] = process.argv.slice(2);
const { apiKey, prompt } = JSON.parse(readFileSync(0, "utf8"));
await mkdir(home, { mode: 0o700 });
try {
  // Docker's process adapter places CommandSpec.env in docker exec arguments.
  // Receive the credential over stdin and set it only in the Codex process.
  const cli = spawn(process.execPath, [entry, ...args], {
    env: { ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: home, EVALUATOR_CODEX_API_KEY: apiKey },
    stdio: ["pipe", "inherit", "inherit"],
    windowsHide: true,
  });
  const exited = new Promise((resolve, reject) => {
    cli.once("error", reject);
    cli.once("close", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
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
