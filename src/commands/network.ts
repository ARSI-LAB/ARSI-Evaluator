import { loadNetworkConfig, redactNetwork } from "../config/network.js";
import { loadConfig } from "../config/load.js";
import { NetworkRuntime } from "../adapters/network/runtime.js";
import { diagnoseNetwork } from "../adapters/network/doctor.js";
import { runDockerCommand } from "../plugins/environments/docker.js";

export async function networkCommand(action: "inspect" | "doctor" | "docker-config",
  options: { networkConfigPath?: string; configPath?: string }, signal: AbortSignal, output: (text: string) => void): Promise<number> {
  const config = options.configPath ? await loadConfig(options.configPath, {}, process.env, { ...options, allowMissingAuth: true }) : undefined;
  const network = new NetworkRuntime(config?.network ?? await loadNetworkConfig(options.networkConfigPath));
  try {
    if (action === "inspect") {
      output(JSON.stringify({ origin: network.document.origin, digest: network.document.digest, settings: redactNetwork(network.settings),
        locations: { host: "this process", daemon: "Docker context endpoint", build: "Docker RUN", runtime: "installer process / container" } }, null, 2));
      return 0;
    }
    if (action === "docker-config") {
      let context: unknown = "unavailable", info: unknown = "unavailable";
      const docker = typeof config?.experiment.environment.config.dockerExecutable === "string" ? config.experiment.environment.config.dockerExecutable : "docker";
      try { context = JSON.parse((await runDockerCommand(docker, ["context", "inspect"], { signal })).stdout); } catch { signal.throwIfAborted(); }
      try { info = JSON.parse((await runDockerCommand(docker, ["info", "--format", "{{json .}}"], { signal })).stdout); } catch { signal.throwIfAborted(); }
      const proxy = network.settings.proxy.daemon;
      output(JSON.stringify(redactNetwork({ context, daemon: typeof info === "object" && info !== null ? Object.fromEntries(Object.entries(info).filter(([key]) => ["ID", "Name", "OperatingSystem", "OSType", "HTTPProxy", "HTTPSProxy", "NoProxy"].includes(key))) : info,
        mergeIntoDaemonJson: { proxies: { "http-proxy": proxy.http ?? "", "https-proxy": proxy.https ?? "", "no-proxy": proxy.noProxy.join(",") } },
        instructions: ["Linux Engine: merge proxies into the daemon host's /etc/docker/daemon.json, preserving unrelated settings. Validate with dockerd --validate --config-file before an administrator restarts Docker.",
          "Docker Desktop: apply these proxy values in Desktop Settings > Proxies; daemon.json proxies are ignored.",
          "Remote Docker: apply on the daemon host shown by the active context, not on this client.",
          "docker.mirrors rewrites explicit image acquisition only; FROM and external COPY use the daemon. No files were modified and Docker was not restarted.",
          "Credentials are redacted here; use the original environment references when applying settings. Verify with network doctor afterwards."] }), null, 2));
      return 0;
    }
    const results = config?.experiment.scheduler.name === "ray"
      ? await (await import("../adapters/ray/network-doctor.js")).diagnoseRayNetwork(config.experiment.scheduler.config,
        network, config.benchmarkName ?? config.experiment.benchmark.name, options.configPath!, signal)
      : await diagnoseNetwork(network, signal, {
      ...(config?.benchmarkName ? { benchmark: config.benchmarkName } : {}),
      ...(typeof config?.experiment.environment.config.dockerExecutable === "string" ? { docker: config.experiment.environment.config.dockerExecutable } : {}),
    });
    output(JSON.stringify({ status: results.some(row => row.status === "failed") ? "failed" : results.some(row => row.status === "not-checked") ? "incomplete" : "passed", probes: results }, null, 2));
    return results.some(row => row.status === "failed" || row.status === "not-checked") ? 1 : 0;
  } finally { await network.dispose(); }
}
