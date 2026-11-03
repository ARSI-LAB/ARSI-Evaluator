import { lstat, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const dist = fileURLToPath(new URL("../dist/", import.meta.url));
if (resolve(dirname(dist)) !== resolve(root)) throw new Error("Refusing to clean outside the repository");
const existing = await lstat(dist).catch(error => {
  if (error.code === "ENOENT") return undefined;
  throw error;
});
if (existing?.isSymbolicLink()) throw new Error("Refusing to clean a linked dist directory");
await rm(dist, { recursive: true, force: true });
