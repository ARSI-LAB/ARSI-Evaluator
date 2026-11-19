import type { Context } from "@deepseek-ai/cordis";
import { jsonPort, workflowObject, workflowValue } from "arsi-evaluator";
import type { JsonValue, ResourceProvider, StepDefinition, WorkflowObject, WorkflowTemplate } from "arsi-evaluator";
import { httpMemoryProvider } from "./http.js";

type Memory = { ingest(entries: JsonValue[], signal: AbortSignal): Promise<void>; query(key: string, signal: AbortSignal): Promise<JsonValue> };
function memory(value: unknown): Memory {
  if (isMemory(value)) return value;
  throw new TypeError("Expected a memory namespace resource");
}
function isMemory(value: unknown): value is Memory {
  return value !== null && typeof value === "object" && "ingest" in value && typeof value.ingest === "function" && "query" in value && typeof value.query === "function";
}
function empty(value: unknown): WorkflowObject {
  const config = workflowObject(value);
  if (Object.keys(config).length) throw new TypeError("This operation has no configuration");
  return config;
}

/** Reference service for exercising scope and temporal isolation, not a production retrieval engine. */
export const memoryProvider: ResourceProvider = {
  type: "example.memory", version: "1", apiVersion: 1, capabilities: ["example.memory/v1"], resources: {}, validateConfig: empty,
  async create(_config, context) {
    const history = new Map<string, JsonValue>();
    let closed = false;
    const value: Memory = {
      async ingest(entries) {
        if (closed) throw new Error("Memory namespace is closed");
        for (const entry of entries) {
          const record = workflowObject(entry, "history entry");
          if (typeof record.key !== "string" || !Object.hasOwn(record, "value")) throw new TypeError("History entries require key and value");
          history.set(record.key, record.value ?? null);
        }
      },
      async query(key) { if (closed) throw new Error("Memory namespace is closed"); return history.get(key) ?? null; },
    };
    return { value, identity: { namespace: context.attemptId }, async dispose() { closed = true; history.clear(); } };
  },
  async recover() {},
};

export const memorySteps: StepDefinition[] = [
  {
    type: "example.memory.ingest", apiVersion: 1, version: "1", effects: "isolated-write", resources: { memory: { capability: "example.memory/v1" } },
    inputs: { history: jsonPort() }, outputs: { count: jsonPort("arsi.number/v1") }, validateConfig: empty,
    async execute(inputs, _config, context) {
      if (!Array.isArray(inputs.history)) throw new TypeError("history must be an array");
      await memory(context.resource("memory")).ingest(inputs.history, context.signal);
      return { count: inputs.history.length };
    },
  },
  {
    type: "example.memory.query", apiVersion: 1, version: "1", effects: "read", resources: { memory: { capability: "example.memory/v1" } },
    inputs: { key: jsonPort() }, outputs: { response: jsonPort("arsi.application-response/v1") }, validateConfig: empty,
    async execute(inputs, _config, context) {
      if (typeof inputs.key !== "string") throw new TypeError("query key must be a string");
      const result = await memory(context.resource("memory")).query(inputs.key, context.signal);
      return { response: { text: typeof result === "string" ? result : JSON.stringify(result), retrieved: result } };
    },
  },
  {
    type: "example.memory.scores", apiVersion: 1, version: "1", effects: "pure", resources: {},
    inputs: { results: jsonPort("arsi.execution-results/v1") }, outputs: { scores: jsonPort("arsi.score-set/v1") }, validateConfig: empty,
    async execute(inputs) {
      const scores: JsonValue[] = [];
      const collect = (values: JsonValue) => {
        if (!Array.isArray(values)) throw new TypeError("Expected iteration results");
        for (const value of values) {
          const row = workflowObject(value), output = workflowObject(row.outputs);
          if (Array.isArray(output.scores)) scores.push(...output.scores);
          else if (Array.isArray(output.results)) collect(output.results);
        }
      };
      collect(inputs.results ?? []);
      return { scores };
    },
  },
];

export const memoryTemplate: WorkflowTemplate = {
  example: { cases: [{ id: "preference", sessions: [
    { history: [{ key: "language", value: "Chinese" }], questions: [{ key: "language", reference: "Chinese" }] },
    { history: [], questions: [{ key: "language", reference: "Chinese" }] },
  ] }] },
  type: "memory.qa", version: "1", apiVersion: 1,
  expand(parameters) {
    if (Object.keys(parameters).some(key => !["cases", "concurrency", "report", "memory"].includes(key))) throw new TypeError("Unknown memory.qa parameter");
    if (!Array.isArray(parameters.cases)) throw new TypeError("memory.qa requires cases");
    const references: WorkflowObject = {};
    const cases = parameters.cases.map(value => {
      const row = workflowObject(value);
      if (typeof row.id !== "string" || !Array.isArray(row.sessions)) throw new TypeError("Memory cases require id and sessions");
      const sessions = row.sessions.map((value, sessionIndex) => {
        const session = workflowObject(value);
        if (!Array.isArray(session.questions)) throw new TypeError("Each session requires questions");
        return { id: String(sessionIndex), history: session.history ?? [], questions: session.questions.map((value, questionIndex) => {
          const question = workflowObject(value);
          const id = `${row.id}:${sessionIndex}:${questionIndex}`;
          if (typeof question.reference !== "string" || typeof question.key !== "string") throw new TypeError("Questions require key and textual reference");
          references[id] = question.reference;
          return { id, key: question.key };
        }) };
      });
      return { id: row.id, sessions };
    });
    return { schemaVersion: 2, inputs: { cases, references },
      inputProtocols: { references: { protocol: "arsi.json/v1", visibility: "private" } },
      workflow: { steps: [
        { id: "evaluate", forEach: { items: { ref: "inputs.cases" }, as: "sample", mode: "units", concurrency: parameters.concurrency ?? 1 },
          resources: { memory: parameters.memory === undefined ? { use: "example.memory", scope: "attempt" }
            : { ...workflowObject(parameters.memory), scope: "attempt" } },
          steps: [
            { id: "sessions", forEach: { items: { ref: "sample.sessions" }, as: "session" }, steps: [
              { id: "ingest", use: "example.memory.ingest", resources: { memory: "memory" }, inputs: { history: { ref: "session.history" } } },
              { id: "questions", forEach: { items: { ref: "session.questions" }, as: "question" }, steps: [
                { id: "query", use: "example.memory.query", resources: { memory: "memory" }, inputs: { key: { ref: "question.key" } } },
                { id: "reference", use: "data.reference", inputs: { references: { ref: "inputs.references" }, id: { ref: "question.id" } } },
                { id: "grade", use: "judge.exact", inputs: { response: { ref: "query.outputs.response" }, reference: { ref: "reference.outputs.reference" } } },
              ], outputs: { scores: { ref: "grade.outputs.scores" } } },
            ], outputs: { results: { ref: "questions.outputs.results" } } },
            { id: "scores", use: "example.memory.scores", inputs: { results: { ref: "sessions.outputs.results" } } },
          ], outputs: { scores: { ref: "scores.outputs.scores" } } },
        { id: "aggregate", use: "metrics.aggregate", inputs: { results: { ref: "evaluate.outputs.results" } } },
        ...(parameters.report === false ? [] : [{ id: "report", use: "report.markdown", inputs: { metrics: { ref: "aggregate.outputs.metrics" } }, onError: "continue" }]),
      ], outputs: { metrics: { ref: "aggregate.outputs.metrics" } } },
    };
  },
};

export const inject = ["evaluator"];
export function apply(ctx: Context): void {
  ctx.evaluator.registerResource(memoryProvider);
  ctx.evaluator.registerResource(httpMemoryProvider);
  for (const definition of memorySteps) ctx.evaluator.registerStep(definition);
  ctx.evaluator.registerWorkflow(memoryTemplate);
}
