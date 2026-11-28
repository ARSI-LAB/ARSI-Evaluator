import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { StepDefinition, WorkflowObject } from "../../core/contracts/workflow.js";
import { collectionPort } from "../../core/workflow/collections.js";
import { jsonPort, workflowObject, workflowValue } from "../../core/workflow/values.js";
import { expectNonEmptyString, rejectUnknown } from "../../core/validation/input.js";

const digest = (content: Uint8Array) => createHash("sha256").update(content).digest("hex");

export const casesJsonlStep: StepDefinition = {
  type: "data.cases-jsonl", version: "1", apiVersion: 1, effects: "read", resources: {}, inputs: {},
  outputs: { cases: collectionPort(), references: { ...jsonPort(), visibility: "private" }, source: jsonPort("arsi.source-lock/v1") },
  validateConfig(value) {
    const config = workflowObject(value);
    rejectUnknown(config, ["path"], "data.cases-jsonl");
    expectNonEmptyString(config.path, "data.cases-jsonl.path");
    return config;
  },
  async execute(_inputs, config, context) {
    const content = await readFile(context.runtime.resolvePath(String(config.path)), { signal: context.signal });
    const rows = new TextDecoder("utf-8", { fatal: true }).decode(content).split(/\r?\n/);
    const references: WorkflowObject = {}, cases: WorkflowObject[] = [], ids = new Set<string>();
    for (const [index, line] of rows.entries()) {
      if (!line.trim()) continue;
      const row = workflowObject(JSON.parse(line), `case on line ${index + 1}`);
      rejectUnknown(row, ["id", "request", "reference"], `case on line ${index + 1}`);
      const id = expectNonEmptyString(row.id, "case.id");
      if (ids.has(id)) throw new TypeError(`Duplicate case ${id}`);
      ids.add(id);
      Object.defineProperty(references, id, { value: row.reference ?? null, enumerable: true, configurable: true });
      cases.push({ id, request: workflowObject(row.request, "case.request") });
    }
    const artifact = await context.artifacts.write("cases.jsonl", cases.map(row => JSON.stringify(row) + "\n").join(""),
      { mediaType: "application/x-ndjson", protocol: "arsi.collection-jsonl/v1" });
    return { cases: workflowValue({ kind: "collection", artifact, count: cases.length }), references,
      source: { sha256: digest(content), size: content.length } };
  },
  async validateResume(outputs, config, context) {
    const content = await readFile(context.runtime.resolvePath(String(config.path)), { signal: context.signal });
    const source = workflowObject(outputs.source);
    if (source.sha256 !== digest(content) || source.size !== content.length)
      throw new TypeError(`Dataset changed since this run: ${config.path}; start a new run for different data`);
  },
};
