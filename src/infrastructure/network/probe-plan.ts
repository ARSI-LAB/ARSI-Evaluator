import { expectRecord, rejectUnknown } from "../../core/validation/input.js";
const HOST_PROBES = ["huggingface", "github-api", "github-file", "npm", "python-index"] as const;
export type HostProbe = typeof HOST_PROBES[number];
export type NetworkProbePlan = {
  host: readonly HostProbe[];
  datasetUrl?: string;
  docker: boolean;
  dockerBuild: boolean;
};

/** The Ray worker receives only the probe choices, never experiment credentials. */
export function parseNetworkProbePlan(value: unknown): NetworkProbePlan {
  const plan = expectRecord(value, "network probe plan");
  rejectUnknown(plan, ["host", "datasetUrl", "docker", "dockerBuild"], "network probe plan");
  if (!Array.isArray(plan.host) || typeof plan.docker !== "boolean" || typeof plan.dockerBuild !== "boolean" ||
    (plan.dockerBuild && !plan.docker)) throw new TypeError("Invalid network probe plan");
  const host = plan.host.map(value => {
    const probe = HOST_PROBES.find(name => name === value);
    if (probe === undefined) throw new TypeError("Invalid host download probe");
    return probe;
  });
  let datasetUrl: string | undefined;
  if (plan.datasetUrl !== undefined) {
    if (typeof plan.datasetUrl !== "string") throw new TypeError("Invalid dataset probe URL");
    const url = new URL(plan.datasetUrl);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
      throw new TypeError("Dataset probe requires an HTTP(S) URL without credentials");
    datasetUrl = plan.datasetUrl;
  }
  return { host, ...(datasetUrl === undefined ? {} : { datasetUrl }), docker: plan.docker, dockerBuild: plan.dockerBuild };
}
