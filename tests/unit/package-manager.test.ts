import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { packageManagerCli } from "../../src/infrastructure/network/package-manager.js";

let directory: string;
let bin: string;
const execPathDescriptor = Object.getOwnPropertyDescriptor(process, "execPath")!;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "package manager "));
  bin = join(directory, "bin");
  await mkdir(bin);
  Object.defineProperty(process, "execPath", { ...execPathDescriptor, value: join(bin, "node") });
  vi.stubEnv("PATH", `"${bin}"`);
});

afterEach(async () => {
  Object.defineProperty(process, "execPath", execPathDescriptor);
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

test.skipIf(process.platform === "win32")("resolves Unix npm and pnpm symlinks to their JavaScript entry points, including paths with spaces", async () => {
  for (const [name, entry] of [["npm", "npm-cli.js"], ["pnpm", "pnpm.cjs"]] as const) {
    const target = join(directory, "lib", "node_modules", name, "bin", entry);
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, "console.log('fixture');\n");
    await symlink(target, join(bin, name));
    await expect(packageManagerCli(name)).resolves.toBe(target);
  }
});

test("retains the Node-adjacent package layout", async () => {
  const target = join(bin, "node_modules", "npm", "bin", "npm-cli.js");
  await mkdir(join(target, ".."), { recursive: true });
  await writeFile(target, "console.log('fixture');\n");
  await expect(packageManagerCli("npm")).resolves.toBe(target);
});

test.skipIf(process.platform === "win32")("ignores shell launchers and broken links before finding a valid later PATH entry", async () => {
  const shell = join(directory, "npm-wrapper.sh");
  await writeFile(shell, "#!/bin/sh\nexit 99\n");
  await symlink(shell, join(bin, "npm"));
  const broken = join(directory, "broken");
  await mkdir(broken);
  await symlink(join(directory, "missing"), join(broken, "npm"));
  const last = join(directory, "last");
  const target = join(last, "node_modules", "npm", "bin", "npm-cli.js");
  await mkdir(join(target, ".."), { recursive: true });
  await writeFile(target, "console.log('fixture');\n");
  vi.stubEnv("PATH", [bin, broken, last].join(delimiter));
  await expect(packageManagerCli("npm")).resolves.toBe(target);
});

test("reports missing package managers without invoking a launcher", async () => {
  await expect(packageManagerCli("npm")).rejects.toThrow("Cannot locate installed npm beside Node or on PATH");
});
