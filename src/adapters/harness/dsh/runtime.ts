import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { RuntimeInstallation } from "../../../core/contracts/environment.js";
import { canonicalJson } from "../../../core/run-manifest.js";
import { agentBundleRuntimeFiles, agentBundleVersionProbe, hashRuntimeSource } from "../../agentbundle/runtime-files.js";
import { AgentBundleError } from "../../agentbundle/cli.js";
import { inspectLocalDsh, type LocalDsh } from "./local-runtime.js";

export type DshBundleRuntime = { installation: RuntimeInstallation; version: string; localDsh?: LocalDsh };

export async function describeDshBundleRuntime(environment: string | undefined, signal: AbortSignal, previous?: DshBundleRuntime): Promise<DshBundleRuntime> {
  if (environment === "docker") {
    return { installation: await dshRuntimeInstallation(signal), version: DSH_VERSION };
  }
  if (environment && environment !== "local")
    throw new AgentBundleError("ENV_RUNTIME_INSTALL_FAILED", "DSH reuse supports local or docker environments");
  const localDsh = previous?.localDsh ?? await inspectLocalDsh(process.env, signal);
  const outputHook = dshOutputRuntimeFile();
  const hash = createHash("sha256");
  await hashRuntimeSource(hash, outputHook.source, signal);
  return { localDsh, version: localDsh.version, installation: {
    id: `external-dsh:${JSON.stringify(localDsh)}:${hash.digest("hex")}`,
    cacheName: "dsh-external",
    files: [...await agentBundleRuntimeFiles(), outputHook], commands: [], probes: [agentBundleVersionProbe()],
  } };
}

export const DSH_VERSION = "0.1.6-alpha.2";
export const PNPM_VERSION = "11.7.0";
export function dshOutputRuntimeFile(): { source: string; target: string } {
  return { source: fileURLToPath(new URL("./assets/output-hook.mjs", import.meta.url)), target: "dsh-output-hook.mjs" };
}

export async function dshRuntimeInstallation(signal: AbortSignal): Promise<RuntimeInstallation> {
  signal.throwIfAborted();
  const files = [
    { source: fileURLToPath(new URL("./assets/package.json", import.meta.url)), target: "package.json" },
    { source: fileURLToPath(new URL("./assets/runtime-lock.json", import.meta.url)), target: "package-lock.json" },
    dshOutputRuntimeFile(),
    ...await agentBundleRuntimeFiles(),
  ];
  const hash = createHash("sha256").update("dsh-runtime-sdk-1");
  for (const file of files) {
    hash.update(file.target);
    await hashRuntimeSource(hash, file.source, signal);
  }
  const recipe = {
    files,
    commands: [
      {
        executable: "npm",
        args: ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"],
        env: {
          NPM_CONFIG_CACHE: "{root}/.npm-cache",
          NPM_CONFIG_USERCONFIG: "{root}/.npmrc",
          NPM_CONFIG_GLOBALCONFIG: "{root}/.npmrc-global",
        },
      },
      { executable: "node", args: ["--eval", "require('node:fs').rmSync('.npm-cache',{recursive:true,force:true})"] },
    ],
    probes: [
      {
        executable: "node",
        args: [
          "--eval",
          `const fs=require('node:fs');for(const [p,v] of [['@deepseek-ai/dsh','${DSH_VERSION}'],['@deepseek-ai/dsh-headless','${DSH_VERSION}'],['pnpm','${PNPM_VERSION}']]){if(JSON.parse(fs.readFileSync('node_modules/'+p+'/package.json','utf8')).version!==v)throw Error('runtime version mismatch: '+p)}`,
        ],
      },
      agentBundleVersionProbe(),
    ],
  };
  hash.update(canonicalJson({ commands: recipe.commands, probes: recipe.probes }));
  return { ...recipe, id: `dsh:${hash.digest("hex")}`, cacheName: `dsh-${DSH_VERSION}` };
}
