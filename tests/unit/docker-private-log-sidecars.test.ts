import { expect, test, vi } from "vitest";
import { restoreInterruptedDockerLogs } from "../../src/infrastructure/containers/log-recovery.js";
import type { DockerCommand } from "../../src/infrastructure/containers/runtime-contract.js";

test.each(["agent", "verifier"])("%s log recovery does not treat inherited sidecar labels as ownership", async kind => {
  const id = "a".repeat(64);
  const command = vi.fn<DockerCommand>(async args => {
    if (args[0] === "ps") return { stdout: id, stderr: "" };
    if (args[0] === "inspect") return { stdout: JSON.stringify([{ Config: { Labels: {
      "ember.run": "run", "ember.task": "task", "ember.attempt": "attempt",
      "ember.phase": kind === "agent" ? "solve" : "verify",
      [`ember.${kind}-logs`]: "container", [`ember.${kind}-log-host`]: "/foreign/path",
      "com.docker.compose.service": "database",
    } }, Mounts: [] }]), stderr: "" };
    throw new Error("A sidecar must not export the main process logs");
  });
  await restoreInterruptedDockerLogs(command, [{ runId: "run", taskId: "task", attemptId: "attempt" }], AbortSignal.timeout(5000));
  expect(command.mock.calls.map(([args]) => args[0])).toEqual(["ps", "inspect"]);
});
