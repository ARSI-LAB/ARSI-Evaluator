import type { WorkflowObject, WorkflowTemplate } from "../../core/contracts/workflow.js";
import { workflowObject } from "../../core/workflow/values.js";
import { expectNonEmptyString, expectPositiveInteger, rejectUnknown } from "../../core/validation/input.js";
import { workflowScheduling } from "./scheduling.js";

/** Small user-facing parameters expand to the same inspectable nodes as handwritten workflows. */
export const applicationEvaluationTemplate: WorkflowTemplate = {
  type: "application.evaluate", version: "1", apiVersion: 1,
  example: { model: { model: "your-model", endpoint: "https://api.example.com/v1", apiKeyEnv: "MODEL_API_KEY" },
    cases: [{ id: "addition", request: { question: "What is 2 + 2?" }, reference: "4" }] },
  expand(parameters) {
    rejectUnknown(parameters, ["model", "variants", "cases", "casesFile", "judge", "report", "concurrency", "repetitions", "scheduler"], "application.evaluate parameters");
    const scheduling = workflowScheduling(parameters.scheduler);
    if (parameters.casesFile !== undefined) expectNonEmptyString(parameters.casesFile, "casesFile");
    if (parameters.casesFile !== undefined && parameters.cases !== undefined) throw new TypeError("Choose cases or casesFile");
    if (parameters.casesFile === undefined && !Array.isArray(parameters.cases)) throw new TypeError("application.evaluate requires cases or casesFile");
    if (parameters.model !== undefined && parameters.variants !== undefined) throw new TypeError("Choose model or variants, not both");
    const references: WorkflowObject = {};
    const cases = (Array.isArray(parameters.cases) ? parameters.cases : []).map(entry => {
      const item = workflowObject(entry, "case");
      rejectUnknown(item, ["id", "request", "reference"], "case");
      const id = expectNonEmptyString(item.id, "case.id");
      if (Object.hasOwn(references, id)) throw new TypeError(`Duplicate case ${id}`);
      Object.defineProperty(references, id, { value: item.reference ?? null, enumerable: true, configurable: true });
      return { id, request: workflowObject(item.request, "case.request") };
    });
    const variants = parameters.variants ?? [{ id: "default", config: workflowObject(parameters.model, "model") }];
    if (!Array.isArray(variants)) throw new TypeError("variants must be an array");
    for (const item of variants) {
      const variant = workflowObject(item, "variant");
      expectNonEmptyString(variant.id, "variant.id");
      workflowObject(variant.config, "variant.config");
    }
    const judge = parameters.judge === undefined ? undefined : workflowObject(parameters.judge, "judge");
    if (judge) { rejectUnknown(judge, ["model", "rubric"], "judge"); workflowObject(judge.model, "judge.model"); expectNonEmptyString(judge.rubric, "judge.rubric"); }
    const steps: unknown[] = [{ id: "evaluate", forEach: {
      ...scheduling.forEach,
      items: { ref: parameters.casesFile === undefined ? "inputs.cases" : "load.outputs.cases" }, as: "sample", mode: "units",
      concurrency: expectPositiveInteger(parameters.concurrency ?? 1, "concurrency"),
      matrix: { variants, repetitions: expectPositiveInteger(parameters.repetitions ?? 1, "repetitions") },
    },
    resources: { target: { use: "model.client", scope: "attempt", config: { settings: { ref: "variant.config" } } } },
    steps: [
      { id: "invoke", use: "application.invoke", inputs: { request: { ref: "sample.request" } }, resources: { application: "target" } },
      { id: "reference", use: "data.reference", inputs: { references: { ref: parameters.casesFile === undefined ? "inputs.references" : "load.outputs.references" }, id: { ref: "sample.id" } } },
      { id: "grade", use: judge ? "judge.model" : "judge.exact", inputs: {
        response: { ref: "invoke.outputs.response" }, reference: { ref: "reference.outputs.reference" },
      }, ...(judge ? { resources: { model: "judge" }, config: { rubric: judge.rubric } } : {}) },
    ], outputs: { response: { ref: "invoke.outputs.response" }, scores: { ref: "grade.outputs.scores" } } },
    { id: "aggregate", use: "metrics.aggregate", inputs: { results: { ref: "evaluate.outputs.results" } } }];
    if (parameters.casesFile !== undefined) steps.unshift({ id: "load", use: "data.cases-jsonl", config: { path: parameters.casesFile } });
    if (parameters.report !== false) steps.push({ id: "report", use: "report.markdown", inputs: { metrics: { ref: "aggregate.outputs.metrics" } }, onError: "continue" });
    return {
      schemaVersion: 2, ...scheduling.deployment, inputs: { cases, references }, inputProtocols: { references: { protocol: "arsi.json/v1", visibility: "private" } },
      resources: { ...scheduling.resources, ...(judge ? { judge: { use: "model.client", scope: "worker", config: { settings: judge.model } } } : {}) },
      workflow: { steps, outputs: { metrics: { ref: "aggregate.outputs.metrics" } }, required: ["metrics"] },
    };
  },
};
