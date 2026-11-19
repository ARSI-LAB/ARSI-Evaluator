import type { WorkflowTemplate } from "../../core/contracts/workflow.js";
import { workflowObject } from "../../core/workflow/values.js";
import { expectNonEmptyString, expectPositiveInteger, rejectUnknown } from "../../core/validation/input.js";

export const resultsRescoreTemplate: WorkflowTemplate = {
  type: "results.rescore", version: "1", apiVersion: 1,
  example: { source: "results/source-run-id", judge: { model: "judge-model", endpoint: "https://api.example.com/v1", apiKeyEnv: "JUDGE_API_KEY" },
    rubric: "Assess correctness and usefulness. Score from 0 to 1." },
  expand(parameters) {
    rejectUnknown(parameters, ["source", "output", "judge", "rubric", "concurrency", "report"], "results.rescore");
    const source = expectNonEmptyString(parameters.source, "source"), judge = workflowObject(parameters.judge, "judge");
    const rubric = expectNonEmptyString(parameters.rubric, "rubric");
    const steps: unknown[] = [
      { id: "load", use: "results.responses", config: { directory: source, ...(parameters.output === undefined ? {} : { output: parameters.output }) } },
      { id: "score", forEach: { items: { ref: "load.outputs.cases" }, as: "sample", mode: "units",
        concurrency: expectPositiveInteger(parameters.concurrency ?? 1, "concurrency") }, steps: [
        { id: "identity", use: "data.value", inputs: { value: { ref: "sample.sourceIdentity" } } },
        { id: "grade", use: "judge.model", when: { ref: "sample.available" }, config: { rubric },
          inputs: { response: { ref: "sample.response" } }, resources: { model: "judge" } },
      ], outputs: { sourceIdentity: { ref: "identity.outputs.value" }, scores: { ref: "grade.outputs.scores" } }, required: ["scores"] },
      { id: "identify", use: "results.source-identities", inputs: { results: { ref: "score.outputs.results" } } },
      { id: "aggregate", use: "metrics.aggregate", inputs: { results: { ref: "identify.outputs.results" } } },
    ];
    if (parameters.report !== false) steps.push({ id: "report", use: "report.markdown", inputs: { metrics: { ref: "aggregate.outputs.metrics" } }, onError: "continue" });
    return { schemaVersion: 2, resources: { judge: { use: "model.client", scope: "run", config: { settings: judge } } },
      workflow: { steps, outputs: { metrics: { ref: "aggregate.outputs.metrics" }, source: { ref: "load.outputs.source" } }, required: ["metrics"] } };
  },
};
