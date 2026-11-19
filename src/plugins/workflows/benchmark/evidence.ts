import type { AttemptRecord, FileManifest } from "../../../core/contracts/result.js";
import { readFile } from "node:fs/promises";
import type { WorkflowArtifacts, WorkflowContext, WorkflowObject } from "../../../core/contracts/workflow.js";
import { checkedPath, verifyFileManifest } from "../../../core/artifacts/artifacts.js";
import { workflowObject } from "../../../core/workflow/values.js";
import { benchmarkActions } from "./definition.js";
import type { BenchmarkAttempt } from "./attempt.js";
import { failureMessage } from "../../../core/errors/classify.js";
import { attemptStatus, attemptTimeoutKind, evaluationScore, isAgentTimeout } from "../../../core/results/evaluation-outcome.js";

export function benchmarkAttemptResource(driver: BenchmarkAttempt, context: WorkflowContext, completed?: (record: AttemptRecord) => void) {
  let exported: Promise<WorkflowObject> | undefined;
  const exportEvidence = async () => {
    const evidence = await driver.evidence();
    const record = evidence.record;
    for (const failure of record.errors) context.log(failureMessage(failure), {
      phase: failure.phase, taskId: record.key.taskId, attemptId: record.key.attemptId, failure,
      error: !(isAgentTimeout(record) && (failure.phase === "solve" || failure.code === "ARTIFACT_COLLECTION_INCOMPLETE")),
      message: failureMessage(failure),
    });
    const message = `Finished: ${attemptStatus(record)}${attemptTimeoutKind(record) ? ` (${attemptTimeoutKind(record)})` : ""}; score=${evaluationScore(record) ?? "none"}`;
    if (!completed) context.log(message, { phase: "task", taskId: record.key.taskId, attemptId: record.key.attemptId, message });
    const reference = await exportBenchmarkEvidence(evidence, context.artifacts);
    completed?.(record);
    return reference;
  };
  const evidence = () => exported ??= exportEvidence();
  return { value: { driver, actions: benchmarkActions(driver), evidence }, async dispose() {
    await driver.close();
    const result = await driver.finalize();
    await evidence();
    if (result.cleanupStatus !== "cleaned") throw new Error("Benchmark resource cleanup remains unconfirmed");
  } };
}

export async function exportBenchmarkEvidence(evidence: { record: AttemptRecord; files: FileManifest; root: string }, artifacts: WorkflowArtifacts): Promise<WorkflowObject> {
  await verifyFileManifest(evidence.root, evidence.files);
  const files = [];
  for (const [index, file] of evidence.files.files.entries()) {
    const bytes = await readFile(await checkedPath(evidence.root, file.path));
    const artifact = await artifacts.write(`benchmark-file-${index}.bin`, bytes,
      { mediaType: "application/octet-stream", protocol: "arsi.benchmark-file/v1", visibility: "private" });
    if (artifact.sha256 !== file.sha256 || artifact.size !== file.size) throw new Error(`Benchmark evidence changed while exporting ${file.path}`);
    files.push({ file, artifact });
  }
  const reference = workflowObject(await artifacts.write("benchmark-evidence.json", JSON.stringify({ record: evidence.record, files,
    missing: evidence.files.missing }), { mediaType: "application/json", protocol: "arsi.benchmark-evidence/v1", visibility: "private" }));
  return reference;
}

export function benchmarkScoreOutputs(record: AttemptRecord, evidence: WorkflowObject): WorkflowObject {
  const score = evaluationScore(record);
  return { evidence, scores: score === undefined ? [] : [{ subject: record.key.taskId, metric: "benchmark-score", value: score, valid: true,
    unit: "ratio", direction: "higher", scorer: "benchmark.verify@1", evidence: [evidence] }] };
}
