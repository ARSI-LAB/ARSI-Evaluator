import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { expectRecord, expectNonEmptyString } from "../../core/validation/input.js";
import { JobsClient } from "./jobs-client.js";

/** Called by the cluster coordinator; values never enter its staged input or Ray runtime_env. */
export async function jobsRuntimeCredentials(jobId: string, scope: string, signal: AbortSignal) {
  const security = process.env.EVALUATOR_JOBS_SECURITY ?? "/security";
  const client = new JobsClient(process.env.EVALUATOR_JOBS_PROGRESS_ORIGIN ?? "https://gateway:9443",
    await readFile(join(security, "cert.pem")), (await readFile(join(security, "jobs-token"), "utf8")).trim());
  const route = `/jobs/${jobId}/credential`;
  const result = expectRecord(await client.call(route, { scope }, signal), "credential names");
  if (!Array.isArray(result.names)) throw new TypeError("Invalid job credential names");
  const names = result.names.map(name => expectNonEmptyString(name, "credential name"));
  return {
    names,
    async resolve(name: string): Promise<string | undefined> {
      if (!names.includes(name)) return undefined;
      const response = expectRecord(await client.call(route, { scope, name }, signal), "job credential");
      return expectNonEmptyString(response.value, "job credential value");
    },
    async close() { await client.call(route, { scope, release: true }, AbortSignal.timeout(5000)); },
  };
}
