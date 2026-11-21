import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { createBundleSdk, harnessNameForKind, isDeepagentsManifest, type VerifyResult } from "agent-bundle-core";
import { satisfies, valid, validRange } from "semver";
import { parse as parseYaml } from "yaml";
import { AgentBundleError, type VerifiedBundle } from "./cli.js";

const require = createRequire(import.meta.url);

export const agentBundleCoreRoot = dirname(dirname(require.resolve("agent-bundle-core")));

const coreRoot = agentBundleCoreRoot;
const coreManifest = JSON.parse(readFileSync(join(coreRoot, "package.json"), "utf8")) as { version?: unknown };

export const AGENT_BUNDLE_CORE_VERSION =
  typeof coreManifest.version === "string" && coreManifest.version !== ""
    ? coreManifest.version
    : (() => {
        throw new Error("agent-bundle-core version is missing");
      })();

/** Same rule as the previous bundled CLI: commas are separators, then semver.satisfies. */
export function assertHarnessVersionCompatible(actualVersion: string, versionRange: string): void {
  const actual = valid(actualVersion);
  if (actual === null) {
    throw new AgentBundleError(
      "SOURCE_CHANGED",
      `harness version must be valid semver, got ${JSON.stringify(actualVersion)}`,
    );
  }
  const range = validRange(versionRange.replaceAll(",", " "));
  if (range === null) {
    throw new AgentBundleError(
      "SOURCE_CHANGED",
      `declared harness version range is not valid semver: ${JSON.stringify(versionRange)}`,
    );
  }
  if (!satisfies(actual, range)) {
    throw new AgentBundleError(
      "SOURCE_CHANGED",
      `harness version ${JSON.stringify(actualVersion)} does not satisfy declared range ${JSON.stringify(versionRange)}`,
    );
  }
}

export function verifiedFromSdk(result: VerifyResult, actualVersion?: string): VerifiedBundle {
  return {
    digest: result.digest,
    harness: {
      name: harnessNameForKind(result.manifest.kind),
      versionRange: result.manifest.harnessVersion,
      ...(actualVersion === undefined ? {} : { actualVersion }),
    },
  };
}

export async function verifyBundleCandidate(bundleDir: string, expectDigest?: string): Promise<VerifiedBundle> {
  const result = await createBundleSdk().verify(
    bundleDir,
    expectDigest === undefined ? {} : { expectDigest },
  );
  const verified = verifiedFromSdk(result);
  const { manifest } = result;
  if (manifest.kind === "pi-agent-bundle" && parseYaml(await readFile(join(bundleDir, "bundle.yaml"), "utf8")).extensionPolicy !== "run-v1") {
    throw new AgentBundleError("CONFIG_INVALID", "Pi bundle.yaml must declare extensionPolicy: run-v1");
  }
  if (!isDeepagentsManifest(manifest)) return verified;
  // The released SDK validates the file path. Check the required callable reference
  // here until consumers can install the AgentBundle release that validates it.
  const entry = JSON.parse(await readFile(manifest.entryPath, "utf8"));
  if (entry.graphs?.agent !== manifest.graphModule + ":build_agent_for_run") {
    throw new AgentBundleError("CONFIG_INVALID", "DeepAgents graphs.agent must reference <module>:build_agent_for_run");
  }
  return { ...verified, factoryModule: relative(bundleDir, resolve(dirname(manifest.entryPath), manifest.graphModule)).split("\\").join("/") };
}
