import { isAbsolute, resolve } from "node:path";
import type { ExecutionConfig } from "../../../core/contracts/config.js";
import { recommendedNetworkConfigPath } from "../../../config/network-paths.js";
import { redactNetwork } from "../../../config/network-schema.js";
import { NetworkRuntime } from "../../../infrastructure/network/runtime.js";
import { diagnoseNetwork, type NetworkProbe } from "../../../infrastructure/network/diagnostics.js";
import { diagnoseRayNetwork } from "../../../infrastructure/ray/network-doctor.js";
import { formatError } from "../../../core/errors/diagnostics.js";
import { networkProbePlan } from "./network-plan.js";

function quoteArgument(value: string): string {
  return process.platform === "win32" ? `'${value.replaceAll("'", "''")}'` : `'${value.replaceAll("'", "'\\''")}'`;
}

export async function diagnoseDownloads(options: { config: ExecutionConfig; configDirectory: string; configPath?: string; patchPath?: string },
  signal: AbortSignal, progress: (message: string) => void, sharedNetwork?: NetworkRuntime) {
  const { config } = options;
  const network = sharedNetwork ?? new NetworkRuntime(config.network);
  const configPath = isAbsolute(network.document.origin) ? network.document.origin : null;
  const location = configPath ?? "saved or inline network template";
  const plan = networkProbePlan(config);
  const recommendedConfigPath = recommendedNetworkConfigPath();
  progress(`Network configuration: ${location}`);
  const report = (probe: NetworkProbe) => {
    progress(`[${probe.status}] ${probe.name} (${probe.location}): ${probe.target}`);
    if (probe.status === "failed" || probe.status === "not-checked") {
      progress(probe.evidence);
      if (probe.guidance?.yamlFields.length) progress(`Edit ${location}: ${probe.guidance.yamlFields.join(", ")}`);
      if (probe.guidance) progress(probe.guidance.action);
    }
  };
  try {
    let probes: NetworkProbe[];
    if (config.experiment.scheduler.name === "ray") {
      try {
        probes = await diagnoseRayNetwork(config.experiment.scheduler.config, network,
          config.benchmarkName ?? config.experiment.benchmark.name, plan, options.configDirectory, signal);
      } catch (error) {
        signal.throwIfAborted();
        probes = [{ name: "ray-network", location: "execution nodes", target: "Ray network probes", route: "Ray",
          status: "failed", elapsedMs: 0, evidence: formatError(error, network.secrets),
          guidance: { yamlFields: [], action: "Check the Ray endpoint and node deployment before changing download sources." } }];
      }
      probes.forEach(report);
    } else {
      const environment = config.experiment.environment;
      probes = await diagnoseNetwork(network, signal, {
        plan,
        benchmark: config.benchmarkName ?? config.experiment.benchmark.name,
        ...(plan.docker && typeof environment.config.dockerExecutable === "string"
          ? { docker: environment.config.dockerExecutable } : {}),
        progress: report,
      });
    }
    const status = probes.some(row => row.status === "failed") ? "failed"
      : probes.some(row => row.status === "not-checked") ? "incomplete" : "passed";
    const experiment = options.configPath ? quoteArgument(resolve(options.configPath)) : undefined;
    const patch = options.patchPath ? ` --patch ${quoteArgument(resolve(options.patchPath))}` : "";
    const retryCommand = experiment ? `arsi-evaluator doctor ${experiment}${patch}${configPath ? ` --network ${quoteArgument(configPath)}` : ""}` : null;
    const recommendedCommand = experiment ? `arsi-evaluator doctor ${experiment}${patch} --network ${quoteArgument(recommendedConfigPath)}` : null;
    if (status !== "passed") {
      if (retryCommand) progress(`Retry after editing the fields above: ${retryCommand}`);
      else progress("Edit the submitting configuration and repeat the original doctor command; this process has no submitting-host file paths.");
      if (recommendedCommand) progress(`To try the bundled mirror configuration: ${recommendedCommand}`);
      progress("The mirror configuration is optional; missing tools, credentials and Docker/Ray deployment failures require their own fixes.");
    }
    const proxy = network.settings.proxy.daemon;
    const dockerAdvice = redactNetwork({
      fields: ["proxy.overrides.daemon", "docker.pull", "docker.mirrors"],
      mergeIntoDaemonJson: { proxies: { "http-proxy": proxy.http ?? "", "https-proxy": proxy.https ?? "", "no-proxy": proxy.noProxy.join(",") } },
      instructions: ["Linux Engine: merge proxy settings into the daemon host's /etc/docker/daemon.json, preserving unrelated settings; validate before an administrator restarts Docker.",
        "Docker Desktop: apply proxies in Desktop Settings. Remote Docker: configure the daemon host, not this client.",
        "docker.mirrors controls explicit downloads; FROM and external COPY use the daemon. No daemon settings were changed or services restarted."] });
    if (status !== "passed" && config.experiment.environment.name === "docker") progress(JSON.stringify(dockerAdvice, null, 2));
    return { configPath, recommendedConfigPath, retryCommand, recommendedCommand, status, probes, dockerAdvice };
  } finally { if (!sharedNetwork) await network.dispose(); }
}
