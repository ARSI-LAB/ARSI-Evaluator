import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../../../scripts/ray-smoke/ensure.mjs", import.meta.url));
const builtInPlaybook = fileURLToPath(new URL("../../../playbook/", import.meta.url));
const builtInBundles = fileURLToPath(new URL("../../../tests/fixtures/agentbundle/", import.meta.url));
const arsiPiBundle = fileURLToPath(
  new URL("../../../../pi/bundles/pi", import.meta.url),
);

export function resolveManagedLocalBundlePath(configDirectory: string, configuredPath: string): string {
  if (!/^\.\/bundles\/[a-zA-Z0-9][a-zA-Z0-9_-]*$/u.test(configuredPath)) {
    throw new Error("Managed local Ray AgentBundle path must be ./bundles/<bundle-name> relative to the playbook");
  }
  // Built-in playbooks use fixture bundles, mounted at the same container path as user bundles.
  const location = relative(builtInPlaybook, resolve(configDirectory));
  const builtin = location === "" || (!isAbsolute(location) && location !== ".." && !location.startsWith(`..${sep}`));
  return builtin
    ? basename(configuredPath) === "pi"
      ? arsiPiBundle
      : join(builtInBundles, basename(configuredPath))
    : resolve(configDirectory, configuredPath);
}

export function resolveManagedLocalBundles(configDirectory: string, bundles: Readonly<Record<string, string>> = {}): Record<string, string> {
  return Object.fromEntries(Object.entries(bundles).map(([name, path]) => [name,
    /^\.\/bundles\/[a-zA-Z0-9][a-zA-Z0-9_-]*$/u.test(path) ? resolveManagedLocalBundlePath(configDirectory, path) : resolve(configDirectory, path)]));
}

export async function ensureManagedLocalCluster(
  signal: AbortSignal,
  log: (text: string) => void,
  bundles: Readonly<Record<string, string>> = {},
): Promise<void> {
  signal.throwIfAborted();
  try {
    await access(script);
  } catch (cause) {
    throw new Error("This managed local Ray playbook requires the repository checkout and scripts/ray-smoke/ensure.mjs", { cause });
  }
  log("Checking the local Ray Jobs cluster...");
  const code = await new Promise<number | null>((resolve, reject) => {
    const child = spawn(process.execPath, [script], {
      cwd: dirname(dirname(dirname(script))),
      stdio: "inherit",
      windowsHide: true,
      signal,
      env: { ...process.env, EVALUATOR_BUNDLE_MOUNTS: JSON.stringify(bundles) },
    });
    child.on("error", reject);
    child.on("exit", resolve);
  });
  if (code !== 0) throw new Error(`Local Ray environment setup failed with exit code ${code ?? "unknown"}`);
}
