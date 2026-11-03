import { readFile } from "node:fs/promises";
const pid = Number(await readFile("/results/active-cli.pid", "utf8"));
if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error("Invalid active CLI PID");
const command = await readFile(`/proc/${pid}/cmdline`, "utf8");
if (!command.split("\0").includes("dist/cli.js")) throw new Error("PID no longer belongs to the smoke CLI");
process.kill(pid, "SIGINT");
