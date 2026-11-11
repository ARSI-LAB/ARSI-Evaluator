import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const [entry, ...args] = process.argv.slice(2);
const prompt = readFileSync(0, "utf8");
// A task starting with '/' must still be submitted as a prompt, not a CLI command.
const task = prompt.trimStart().startsWith("/") ? "Task:\n\n" + prompt : prompt;
// The pinned CLI reads process.argv when its entry module runs.
process.argv = [process.execPath, entry, ...args, "--prompt=" + task];
await import(pathToFileURL(entry).href);
