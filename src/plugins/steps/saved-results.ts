import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { StepDefinition, WorkflowObject } from "../../core/contracts/workflow.js";
import { jsonPort, workflowDigest, workflowObject, workflowValue } from "../../core/workflow/values.js";
import { expectNonEmptyString, rejectUnknown } from "../../core/validation/input.js";
import { LocalWorkflowStore } from "../stores/workflow-local.js";

export const savedResponsesStep: StepDefinition = {
  type: "results.responses", version: "1", apiVersion: 1, effects: "read", resources: {}, inputs: {},
  outputs: { cases: jsonPort("arsi.cases/v1"), source: jsonPort("arsi.source-lock/v1") },
  validateConfig(value) {
    const config = workflowObject(value);
    rejectUnknown(config, ["directory", "output"], "results.responses");
    expectNonEmptyString(config.directory, "results.responses.directory");
    if (config.output !== undefined) expectNonEmptyString(config.output, "results.responses.output");
    return config;
  },
  async execute(_inputs, config, context) {
    const directory = context.runtime.resolvePath(String(config.directory));
    const record = await new LocalWorkflowStore(directory).read();
    if (record.status === "running") throw new TypeError("Finish or cancel the source run before scoring its results");
    const plan = workflowObject(JSON.parse(await readFile(join(directory, "plan.json"), "utf8")));
    if (plan.fingerprint !== record.fingerprint || plan.fingerprint !== workflowDigest({ document: plan.document,
      implementations: plan.implementations, sources: plan.sources, outputs: plan.outputs })) throw new TypeError("Source plan differs from its committed run");
    const field = String(config.output ?? "response"), ports = workflowObject(plan.outputs);
    const blocks = new Set(Object.entries(ports).flatMap(([path, declarations]) => {
      const declaration = workflowObject(declarations)[field];
      if (declaration === undefined) return [];
      const port = workflowObject(declaration);
      return port.visibility === "public" ? [path] : [];
    }));
    const latest = new Map(record.units.map(unit => [unit.key, unit]));
    const cases: WorkflowObject[] = [];
    for (const unit of latest.values()) {
      const path = unit.key.slice(0, unit.key.lastIndexOf(":")).replace(/\[[0-9a-f]{16}\]/g, "");
      if (!blocks.has(path)) continue;
      const response = unit.outputs[field];
      const available = response !== undefined;
      if (available && typeof workflowObject(response).text !== "string") throw new TypeError("Text rescoring requires a response with a text field");
      cases.push({ id: workflowDigest({ key: unit.key, attemptId: unit.attemptId }), available,
        response: available ? { text: workflowObject(response).text ?? "" } : null,
        sourceIdentity: { caseId: unit.caseId, variantId: unit.variantId, repetition: unit.repetition },
        sourceAttempt: unit.attemptId });
    }
    if (!cases.length) throw new TypeError(`Source run has no public execution-unit output named ${field}`);
    return { cases, source: { runId: record.runId, fingerprint: record.fingerprint, recordDigest: workflowDigest(record) } };
  },
  async validateResume(outputs, config, context) {
    const record = await new LocalWorkflowStore(context.runtime.resolvePath(String(config.directory))).read();
    if (workflowObject(outputs.source).recordDigest !== workflowDigest(record)) throw new TypeError("Source results changed; start a new scoring run");
  },
};

/** Preserve model groups and repetitions when a new run scores saved responses. */
export const restoreResultIdentitiesStep: StepDefinition = {
  type: "results.source-identities", version: "1", apiVersion: 1, effects: "pure", resources: {},
  inputs: { results: jsonPort("arsi.execution-results/v1") }, outputs: { results: jsonPort("arsi.execution-results/v1") },
  validateConfig(value) { const config = workflowObject(value); rejectUnknown(config, [], "results.source-identities"); return config; },
  async execute(inputs) {
    if (!Array.isArray(inputs.results)) throw new TypeError("Expected scoring results");
    return { results: inputs.results.map(value => {
      const row = workflowObject(value), outputs = workflowObject(row.outputs), identity = workflowObject(outputs.sourceIdentity);
      expectNonEmptyString(identity.caseId, "source case ID"); expectNonEmptyString(identity.variantId, "source variant ID");
      if (typeof identity.repetition !== "number" || !Number.isSafeInteger(identity.repetition) || identity.repetition < 0) throw new TypeError("Invalid source repetition");
      const scores = Array.isArray(outputs.scores) ? outputs.scores.map(score => ({ ...workflowObject(score), subject: identity.caseId ?? "" })) : [];
      return workflowValue({ ...row, ...identity, outputs: { ...outputs, scores } });
    }) };
  },
};
