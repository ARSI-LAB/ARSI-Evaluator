import type { ExecutionConfig } from "../../../core/contracts/config.js";
import type { HostProbe, NetworkProbePlan } from "../../../infrastructure/network/probe-plan.js";
import { DEFINED_BENCHMARKS } from "../../benchmarks/agent-harness/definitions/index.js";
import { DROP_ARCHIVE_URL } from "../../benchmarks/agent-harness/definitions/drop.js";

const npmSolvers = new Set(["claudecode", "codex", "codebuddy", "zcode"]);

/** Plan probes from resolved selections without materializing tasks or installing runtimes. */
export function networkProbePlan({ experiment }: ExecutionConfig): NetworkProbePlan {
  const { benchmark, environment, solver, verifier } = experiment;
  const configuredSource = benchmark.config.source;
  const source = configuredSource && typeof configuredSource === "object" && !Array.isArray(configuredSource)
    ? configuredSource : undefined;
  const kind = source && "kind" in source ? source.kind : undefined;
  const localDataset = typeof benchmark.config.localPath === "string" || kind === "local";
  const host: HostProbe[] = [];
  let datasetUrl: string | undefined;
  if (!localDataset) {
    if (kind === "archive" && source && "url" in source && typeof source.url === "string") datasetUrl = source.url;
    else if (kind === "github" || (benchmark.name === "harbor" && kind === undefined)) host.push("github-api", "github-file");
    else if (benchmark.name === "drop") datasetUrl = DROP_ARCHIVE_URL;
    else if (benchmark.name === "agentx" || benchmark.name === "officeqa-pro-v2" ||
      DEFINED_BENCHMARKS.some(({ definition }) => definition.name === benchmark.name)) host.push("huggingface");
  }

  const docker = environment.name === "docker";
  const pythonVerifier = docker && verifier?.name === "harbor-python";
  const dockerBuild = pythonVerifier || (docker && benchmark.name === "officeqa-pro-v2");
  if ((docker && solver.name === "simpleagent") || npmSolvers.has(solver.name)) host.push("npm");
  if (pythonVerifier) host.push("python-index");
  return { host, ...(datasetUrl === undefined ? {} : { datasetUrl }), docker, dockerBuild };
}
