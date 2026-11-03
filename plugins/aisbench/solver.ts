import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, appendFile } from "node:fs/promises";
import { join, posix } from "node:path";
import { setTimeout } from "node:timers/promises";
import { bindSolverService, fingerprintConfig, redactDiagnostic } from "ember-evaluator";
import type { Solver, AttemptContext, EnvironmentSession, PublicTask, SolveResult, PluginFactoryContext } from "ember-evaluator";
import { expectNonEmptyString, expectRecord } from "./validation.js";
import { AisbenchRemoteClient, aisbenchBaseUrl } from "./ssh/client.js";
import { parseCsv } from "./ssh/csv.js";
import { parseWorkload, type AisbenchSshConfig } from "./config.js";
import { bundleDigest } from "./ssh/bundle.js";
import { parseAisbenchSummary } from "./evidence.js";

export class AisbenchSshSolver implements Solver {
  constructor(private readonly config: AisbenchSshConfig, private readonly runtime: PluginFactoryContext) {}
  requirements() { return []; }
  async provenance() { return { bundleDigest: await bundleDigest(), aisbenchVersion: this.config.remote.aisbenchVersion }; }
  async solve(input: PublicTask, _session: EnvironmentSession, context: AttemptContext): Promise<SolveResult> {
    const payload = expectRecord(input.payload, "aisbench payload"), workload = parseWorkload(payload.workload);
    const digest = await bundleDigest();
    if (payload.kind !== "aisbench" || payload.schemaVersion !== 1 || payload.bundleDigest !== digest) throw new TypeError("Invalid AISBench task bundle");
    const { model, auth } = bindSolverService(this.runtime);
    const endpoint = aisbenchBaseUrl(expectNonEmptyString(model.endpoint, "aisbench service endpoint"));
    const client = new AisbenchRemoteClient(this.config, digest);
    const identity = createHash("sha256").update(JSON.stringify([context.key.runId, context.key.taskId])).digest("hex");
    const jobDir = posix.join(this.config.remote.workRoot, "jobs", identity);
    const config = { workload, endpoint, model: model.name, apiKey: auth.value, tokenizerPath: this.config.tokenizerPath,
      pythonExecutable: this.config.remote.pythonExecutable, aisbenchWorkPath: this.config.remote.aisbenchWorkPath,
      aisbenchVersion: this.config.remote.aisbenchVersion, podInfo: this.config.podInfo };
    // Stable across credentials rotation and attempt retries; remote private config is never persisted locally.
    const fingerprint = fingerprintConfig({ ...config, apiKey: "", bundleDigest: digest });
    const root = join(context.paths.artifacts, "aisbench");
    await mkdir(root, { recursive: true });
    await mkdir(context.paths.agent, { recursive: true });
    await writeFile(join(context.paths.agent, "remote-job.json"), JSON.stringify({ jobDir, fingerprint, bundleDigest: digest }) + "\n");
    let started = false, terminal = false, collected = false;
    const log = async (text: string) => {
      const safe = redactDiagnostic(text, [auth.value]);
      if (safe) { await appendFile(join(context.paths.agent, "remote.log"), safe); context.activity?.({ lines: safe.split(/\r?\n/u).filter(Boolean).slice(-20) }); }
    };
    try {
      context.activity?.({ message: "AISBench: deploying remote runner" });
      await client.deploy(context.signal);
      let status = await client.status(jobDir, fingerprint, 0, context.signal);
      if (["missing", "failed", "cancelled"].includes(status.state)) {
        started = true; // start response can be lost; cancellation must still find the job.
        await client.call("start", jobDir, fingerprint, { config, restartToken: context.key.attemptId }, context.signal);
      } else started = true;
      let offset = 0;
      for (;;) {
        status = await client.status(jobDir, fingerprint, offset, context.signal);
        await log(status.log); offset = status.offset;
        context.activity?.({ message: `AISBench: ${status.phase} (${status.state})`, activity: Boolean(status.log) });
        if (status.state !== "running") break;
        await setTimeout(this.config.remote.pollIntervalSeconds * 1000, undefined, { signal: context.signal });
      }
      terminal = true;
      await client.download(jobDir, fingerprint, root, context.signal); collected = true;
      if (status.state !== "completed" || status.exitCode !== 0) throw new Error(`AISBench remote measurement ${status.state} (exit ${status.exitCode}); see collected artifacts`);
      const rows = parseCsv(await readFile(join(root, "aisbench_result.csv"), "utf8"));
      const observations = parseAisbenchSummary({ schemaVersion: 1, kind: "aisbench", workload, bundleDigest: digest, aisbenchVersion: this.config.remote.aisbenchVersion, rows });
      await writeFile(join(context.paths.agent, "aisbench-summary.json"), JSON.stringify(observations, null, 2) + "\n");
      return { finalText: `AISBench completed ${workload.dataCount} requests at concurrency ${workload.concurrency}`, usage: { inputTokens: null, outputTokens: null, totalTokens: null }, observations };
    } catch (error) {
      if (started && context.signal.aborted && !terminal) {
        try { await client.call("cancel", jobDir, fingerprint, {}, AbortSignal.timeout(30000)); }
        catch { await log("\nRemote cancellation unconfirmed; inspect remote-job.json before restarting.\n"); }
      }
      if (started && !collected) {
        try { await client.download(jobDir, fingerprint, root, AbortSignal.timeout(30000)); }
        catch { await log("\nRemote artifact collection incomplete; remote job retained for recovery.\n"); }
      }
      throw error;
    }
  }
}
