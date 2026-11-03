import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { AttemptKey } from "../../core/contracts/result.js";
import { runDockerCommand } from "../../plugins/environments/docker.js";
import { removeDockerContainer } from "../../plugins/environments/docker-cleanup.js";
import { recoverDockerAttempts } from "../../plugins/environments/docker-recovery.js";
import { EvaluatorError } from "../../core/errors/evaluator-error.js";

/** Resolve the local immutable image ID before a task becomes ready. */
export async function materializeVerifierImage(docker: string, image: string, signal: AbortSignal): Promise<string> {
  const inspect = () => runDockerCommand(docker, ["image", "inspect", image, "--format", "{{.Id}}"], { signal });
  let result;
  try { result = await inspect(); }
  catch { signal.throwIfAborted(); await runDockerCommand(docker, ["pull", image], { signal }); result = await inspect(); }
  const id = result.stdout.trim();
  if (!/^sha256:[a-f0-9]{64}$/u.test(id)) throw new Error("Invalid verifier image identity");
  return id;
}

export function recoverVerifierContainers(docker: string, keys: AttemptKey[], signal: AbortSignal): Promise<void> {
  return recoverDockerAttempts((args, options) => runDockerCommand(docker, args, options), keys, signal);
}

/** A created container is owned before its untrusted program is started. */
export async function createVerifierContainer(docker: string, image: string, args: string[], command: string[],
  key: AttemptKey, signal: AbortSignal) {
  if (!/^sha256:[a-f0-9]{64}$/u.test(image)) throw new Error("Verifier requires a materialized image ID");
  const name = `evaluator-verifier-${randomUUID()}`;
  const labels = { run: key.runId, task: key.taskId, attempt: key.attemptId, phase: "verify" };
  const remove = (active: AbortSignal) => removeDockerContainer((argv, options) => runDockerCommand(docker, argv, options), name, active);
  try {
    await runDockerCommand(docker, ["create", "--pull", "never", "--name", name, "--interactive",
      ...Object.entries(labels).flatMap(([field, value]) => ["--label", `ember.${field}=${value.replace(/[\u0000-\u001f\u007f]/gu, "_")}`]),
      ...args, image, ...command], { signal });
    signal.throwIfAborted();
  } catch (error) {
    try { await remove(AbortSignal.timeout(60_000)); }
    catch (cleanup) { throw new EvaluatorError("CLEANUP_FAILED", "Verifier container creation failed and removal could not be confirmed", {},
      { cause: new AggregateError([error, cleanup]) }); }
    throw error;
  }
  let child: ChildProcessWithoutNullStreams | undefined;
  let done: Promise<number | null> | undefined;
  let detach: (() => void) | undefined;
  let disposed = false;
  return {
    metadata: { kind: "docker-verifier", container: name, image },
    start(active: AbortSignal) {
      active.throwIfAborted();
      if (child || disposed) throw new Error("Verifier container cannot be started twice or after disposal");
      const worker = spawn(docker, ["start", "--attach", "--interactive", name], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
      child = worker;
      const closed = new Promise<number | null>((resolve, reject) => { worker.once("error", reject); worker.once("close", resolve); });
      done = closed.then(async code => {
        if (active.aborted) return code;
        const response = await runDockerCommand(docker, ["container", "inspect", name, "--format", "{{json .State}}"], { signal: active });
        const state: unknown = JSON.parse(response.stdout);
        if (!state || typeof state !== "object" || !("Status" in state) || state.Status !== "exited" ||
          !("ExitCode" in state) || state.ExitCode !== code || !("Error" in state) || state.Error !== "" ||
          !("StartedAt" in state) || typeof state.StartedAt !== "string" || state.StartedAt.startsWith("0001-"))
          throw new Error("Verifier container did not complete normally; Docker attachment is not an execution result");
        return code;
      });
      void done.catch(() => {});
      worker.stdin.on("error", () => {});
      const stop = () => { worker.kill(); };
      active.addEventListener("abort", stop, { once: true });
      detach = () => active.removeEventListener("abort", stop);
      if (active.aborted) stop();
      return { worker, done };
    },
    async dispose(active: AbortSignal) {
      if (disposed) return;
      detach?.();
      child?.kill();
      await remove(active);
      if (done) await done.catch(() => {});
      disposed = true;
    },
  };
}
