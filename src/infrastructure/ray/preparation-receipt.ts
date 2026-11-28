import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AttemptKey } from "../../core/contracts/result.js";
import type { PreparedTask, SourceLock } from "../../core/contracts/task.js";
import { safeTaskKey } from "../../core/artifacts/artifacts.js";
import { fingerprintConfig } from "../../core/results/run-manifest.js";
import { workflowValue } from "../../core/workflow/values.js";

/** Trust private local paths only after checking the whole preparation worker receipt. */
export async function readPreparedTask(outputRoot: string, key: AttemptKey, preparation: { roundId: string; digest: string | null },
  expected: { packageDigest: string; source: SourceLock; configFingerprint: string }): Promise<PreparedTask> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(key.runId) || key.runId.endsWith(".") ||
      !/^[A-Za-z0-9_-]+$/.test(preparation.roundId)) throw new TypeError("Unsafe preparation receipt identity");
  const file = join(outputRoot, "preparations", key.runId, preparation.roundId, `${safeTaskKey(key.taskId)}.json`);
  const raw: unknown = JSON.parse(await readFile(file, "utf8"));
  if (fingerprintConfig(workflowValue(raw)) !== preparation.digest) throw new TypeError("Node preparation receipt differs from the ready barrier");
  // The digest was returned by the installed preparation worker before dispatch.
  const receipt = raw as { task: PreparedTask; packageDigest: string; source: SourceLock; configFingerprint: string };
  if (receipt.packageDigest !== expected.packageDigest || receipt.configFingerprint !== expected.configFingerprint ||
      fingerprintConfig(receipt.source) !== fingerprintConfig(expected.source) || receipt.task.input.id !== key.taskId)
    throw new TypeError("Node preparation receipt differs from dispatch");
  return receipt.task;
}
