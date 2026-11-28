import type { EffectiveConfig } from "../../../core/contracts/config.js";
import type { Deployment } from "../../../config/deployment.js";

/** The Benchmark knows which solver assets its groups need; deployment only sees directories. */
export function benchmarkDeployment(deployment: Deployment, experiments: readonly EffectiveConfig[]): Deployment {
  if (!deployment.managedLocal) return deployment;
  const bundles: Record<string, string> = {};
  for (const { solver } of experiments) {
    if (solver.name !== "agentbundle") continue;
    const path = solver.config.path;
    const match = typeof path === "string" ? /^\.\/bundles\/([a-zA-Z0-9][a-zA-Z0-9_-]*)$/u.exec(path) : null;
    if (!match?.[1]) throw new TypeError("Managed local Ray AgentBundle path must be ./bundles/<bundle-name>");
    bundles[match[1]] = String(path);
  }
  if (!Object.keys(bundles).length && deployment.bundles === undefined) return deployment;
  return { ...deployment, bundles: { ...bundles, ...deployment.bundles } };
}
