import { readFile, writeFile, rm, access } from "node:fs/promises";
import { join } from "node:path";
import { createJobsProgressPublisher, workflowProgressLine } from "../../../../dist/infrastructure/ray/jobs-progress.js";
import { openPluginRegistry } from "../../../../dist/application/plugins/open-registry.js";
import { resolvePluginPatchPath } from "../../../../dist/infrastructure/ray/node-config.js";
import { jobsRuntimeCredentials } from "../../../../dist/infrastructure/ray/jobs-runtime-credentials.js";
import { executeWorkflowJob, executeWorkflowMaintenanceJob } from "../../../../dist/application/ray/workflow-job.js";

const id = process.argv[2];
if (!/^[0-9a-f-]{36}$/u.test(id ?? "")) throw new Error("Invalid job ID");
const dir = join(process.env.EVALUATOR_JOBS_ROOT ?? "/jobs", id);
// The gateway and coordinator share this short directory, including the Unix Socket.
process.env.EVALUATOR_RETRY_SOCKET_DIR = dir;
const security = process.env.EVALUATOR_JOBS_SECURITY ?? "/security";
const inputPath = join(dir, "input.json");
const controller = new AbortController();
let progress;
process.on("SIGTERM", () => controller.abort());
process.on("SIGINT", () => controller.abort());
const timer = setInterval(() => {
  access(join(dir, "cancel")).then(
    () => controller.abort(),
    () => {},
  );
}, 500);
let registry;
let credentialSession;
const credentials = [];
const patchSetting = process.env.EVALUATOR_PLUGIN_PATCH_PATH;
const pluginPatchPath = resolvePluginPatchPath(patchSetting, process.cwd());
try {
  const input = JSON.parse(await readFile(inputPath, "utf8"));
  if (input.kind !== "workflow") throw new Error("Unsupported job submission format");
  registry = await openPluginRegistry(pluginPatchPath);
  credentialSession = await jobsRuntimeCredentials(id, "run", controller.signal);
  if (JSON.stringify(credentialSession.names) !== JSON.stringify(input.credentialNames)) throw new Error("Job credential names changed");
  process.env.EVALUATOR_TRANSFER_TOKEN = (await readFile(join(security, "token"), "utf8")).trim();
  progress = await createJobsProgressPublisher(id, credentials);
  const runtime = {
    root: process.env.EVALUATOR_JOBS_ROOT ?? "/jobs",
    configDirectory: process.env.EVALUATOR_WORKER_PROFILE === "builtin" ? "/builtin-experiment" : "/experiment",
    signal: controller.signal,
    async credential(name) {
      const value = process.env[name] || await credentialSession.resolve(name);
      if (value) credentials.push(value);
      return value;
    }, onEvent: event => {
      const detail = event.progress ?? { phase: "workflow", message: `${event.path}: ${event.message}`, error: event.status === "failed" };
      progress?.observe(detail);
      const line = workflowProgressLine(detail, credentials);
      if (line) process.stdout.write(line);
    },
  };
  if (input.operation === "maintenance") {
    const results = await executeWorkflowMaintenanceJob(input, registry, runtime);
    await writeFile(join(dir, "maintenance.json"), JSON.stringify(results), { mode: 0o600 });
  } else {
    const outcome = await executeWorkflowJob(id, input, registry, runtime);
    process.exitCode = outcome.record.status === "completed" ? 0 : outcome.record.status === "cancelled" ? 130 : 1;
    process.stdout.write(outcome.directory + "\n");
  }

} catch (error) {
  // Never print the staged input or raw credential-bearing configuration.
  console.error(
    "Cluster coordinator failed:",
    credentials.reduce((message, value) => message.replaceAll(value, "[redacted]"), String(error.message)),
  );
  process.exitCode = 1;
} finally {
  await credentialSession?.close().catch(() => {});
  await progress?.close();
  clearInterval(timer);
  await registry?.dispose();
  await rm(inputPath, { force: true });
}
