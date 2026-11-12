import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ContainerPlatform, RuntimeInstallation, RuntimeLocation } from "../../core/contracts/environment.js";
import { EVALUATOR_NODE_EXECUTABLE } from "./runtime-contract.js";
import { copyRuntimeInventory, runtimeInventory } from "../runtime-installation/install.js";

const root = "/opt/evaluator-agent";
const installer = String.raw`import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { resolve, relative, isAbsolute } from "node:path";
const root = process.argv[2] ?? "/opt/evaluator-agent";
const manifest = JSON.parse(await readFile(process.argv[3] ?? "/opt/evaluator/installation.json", "utf8"));
for (const command of [...manifest.commands, ...manifest.probes]) {
  const expand = value => value.replaceAll("{root}", root);
  const cwd = resolve(root, command.cwd ?? ".");
  const rel = relative(root, cwd);
  if (rel === ".." || rel.startsWith("../") || isAbsolute(rel)) throw new Error("unsafe runtime cwd");
  // Probes must use the Node running this trusted installer, even when a task PATH shadows it.
  const executable = command.executable === "node" ? process.execPath : expand(command.executable);
  const child = spawn(executable, command.args.map(expand), {
    cwd, env: { ...process.env, ...Object.fromEntries(Object.entries(command.env ?? {}).map(([key, value]) => [key, expand(value)])) },
    stdio: "inherit", shell: false,
  });
  const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", (code, signal) => resolve(signal ? null : code)); });
  if (code !== 0) throw new Error("runtime command failed: " + command.executable + " (" + code + ")");
}
`;
/** The install stage uses only the pinned Node image and the solver inventory. */
export async function prepareSolverLayer(installation: RuntimeInstallation, platform: ContainerPlatform, signal: AbortSignal) {
  const inventory = await runtimeInventory(installation, platform, signal);
  return {
    identity: inventory.identity,
    installer,
    runtime: { root, stateRoot: `${root}/state`, persistent: false, identity: inventory.identity } satisfies RuntimeLocation,
    installStage: [
      "FROM evaluator_node AS solver_runtime",
      `COPY inputs/ ${root}/`,
      "COPY install-runtime.mjs /opt/evaluator/install-runtime.mjs",
      "COPY installation.json /opt/evaluator/installation.json",
      "ARG NPM_CONFIG_REGISTRY",
      "ARG PIP_INDEX_URL",
      `RUN ${EVALUATOR_NODE_EXECUTABLE} /opt/evaluator/install-runtime.mjs && chmod -R a+rX ${root} && mkdir -p ${root}/state && chmod 1777 ${root}/state`,
    ].join("\n"),
    copy: [
      `COPY --from=solver_runtime ${root} ${root}`,
      "COPY --chmod=0444 install-runtime.mjs /opt/evaluator/install-runtime.mjs",
      "COPY --chmod=0444 probes.json /opt/evaluator/installation.json",
    ].join("\n"),
    probe: `RUN ["${EVALUATOR_NODE_EXECUTABLE}", "/opt/evaluator/install-runtime.mjs"]`,
    async write(context: string, active: AbortSignal) {
      const inputs = join(context, "inputs");
      await mkdir(inputs);
      await copyRuntimeInventory(inventory, inputs, active);
      await Promise.all([
        writeFile(join(context, "install-runtime.mjs"), installer),
        writeFile(join(context, "installation.json"), JSON.stringify({ commands: inventory.commands, probes: inventory.probes })),
        writeFile(join(context, "probes.json"), JSON.stringify({ commands: [], probes: inventory.probes })),
      ]);
    },
  };
}
