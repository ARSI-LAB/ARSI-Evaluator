import { parseTaskAttachments } from "../../../core/validation/multimodal.js";
import { join } from "node:path";
import type { StepDefinition, WorkflowBlock, WorkflowDocument, WorkflowObject } from "../../../core/contracts/workflow.js";
import type { TaskJob } from "../../../core/contracts/scheduler.js";
import type { PublicTask } from "../../../core/contracts/task.js";
import { assertSolveResult, assertVerifyResult } from "../../../core/results/record-validation.js";
import { WorkflowDefinitions } from "../../../core/workflow/catalog.js";
import { compileWorkflow } from "../../../core/workflow/compile.js";
import { executeWorkflow } from "../../../core/workflow/execute.js";
import { booleanPort, jsonPort, workflowObject, workflowValue } from "../../../core/workflow/values.js";
import { LocalWorkflowStore } from "../../stores/workflow-local.js";
import type { BenchmarkAttempt, RunTaskOptions } from "./attempt.js";
import { DEFAULT_TASK_TIMEOUT_SECONDS } from "../../../core/policies/timeouts.js";

type Action = (inputs: Readonly<WorkflowObject>, signal: AbortSignal) => Promise<WorkflowObject>;
type Facet = { invoke: Action };
function facet(value: unknown): Facet {
  if (isFacet(value)) return value;
  throw new TypeError("Benchmark step requires its declared attempt capability");
}
function isFacet(value: unknown): value is Facet {
  return !!value && typeof value === "object" && "invoke" in value && typeof value.invoke === "function";
}
function empty(value: unknown): WorkflowObject {
  const config = workflowObject(value);
  if (Object.keys(config).length) throw new TypeError("Benchmark operation has no configuration");
  return config;
}

function publicTask(value: unknown): PublicTask {
  const input = workflowObject(value);
  if (Object.keys(input).some(key => !["id", "prompt", "attachments", "payload", "skillsDirectories", "mcpServers"].includes(key)) ||
      typeof input.id !== "string" || !input.id || typeof input.prompt !== "string") throw new TypeError("Invalid public task input");
  const task: PublicTask = { id: input.id, prompt: input.prompt };
  if (input.attachments !== undefined) task.attachments = parseTaskAttachments(input.attachments);
  if (input.payload !== undefined) task.payload = input.payload;
  if (input.skillsDirectories !== undefined) {
    if (!Array.isArray(input.skillsDirectories)) throw new TypeError("skillsDirectories must be a string array");
    task.skillsDirectories = input.skillsDirectories.map(value => { if (typeof value !== "string") throw new TypeError("Invalid skill directory"); return value; });
  }
  if (input.mcpServers !== undefined) {
    if (!Array.isArray(input.mcpServers)) throw new TypeError("mcpServers must be an array");
    task.mcpServers = input.mcpServers.map(value => {
      const server = workflowObject(value);
      if (typeof server.name !== "string" || typeof server.url !== "string" || server.transport !== "sse" && server.transport !== "http") throw new TypeError("Invalid MCP server");
      return { name: server.name, url: server.url, transport: server.transport };
    });
  }
  return task;
}

export const benchmarkOperations = ["prepare", "begin", "solve", "transfer", "verify", "finish"] as const;
const operations = benchmarkOperations;
export function benchmarkAttemptBlock(): WorkflowBlock {
  const node = (id: typeof operations[number]) => ({
    kind: "step" as const, id, use: `benchmark.${id}`, config: {}, inputs: {}, resources: { operation: id },
  });
  return {
    resources: Object.fromEntries(operations.map(operation => [operation, {
      use: `benchmark.${operation}`, scope: "attempt" as const, config: {}, resources: {},
    }])),
    steps: [node("prepare"), {
      kind: "forEach", id: "parts", items: { ref: "prepare.outputs.parts" }, as: "part", mode: "sequence", concurrency: 1,
      matrix: { variants: [{ id: "default" }], repetitions: 1 }, stopWhen: { ref: "stop" },
      body: { resources: {}, steps: [
        { ...node("begin"), inputs: { index: { ref: "part.index" } } },
        { ...node("solve"), inputs: { task: { ref: "begin.outputs.task" } } }, node("transfer"),
        { ...node("verify"), inputs: { solve: { ref: "solve.outputs.solve" } } },
        { ...node("finish"), inputs: { verdict: { ref: "verify.outputs.verdict" } } },
      ], outputs: { stop: { ref: "finish.outputs.stop" } }, required: ["stop"] },
    }], outputs: { results: { ref: "parts.outputs.results" } }, required: ["results"],
  };
}

/** Distinct resource facades prevent the solve step from inspecting verifier state. */
export function benchmarkActions(attempt: BenchmarkAttempt): Record<typeof operations[number], Facet> {
  const actions: Record<typeof operations[number], Action> = {
    prepare: async () => ({ parts: workflowValue(await attempt.prepare()) }),
    begin: async inputs => {
      if (typeof inputs.index !== "number" || !Number.isSafeInteger(inputs.index) || inputs.index < 0) throw new TypeError("Invalid part index");
      return { task: workflowValue(await attempt.begin(inputs.index)) };
    },
    solve: async inputs => ({ solve: workflowValue(await attempt.solve(publicTask(inputs.task))) }),
    transfer: async () => { await attempt.transfer(); return {}; },
    verify: async inputs => { assertSolveResult(inputs.solve); return { verdict: workflowValue(await attempt.verify(inputs.solve)) }; },
    finish: async inputs => { if (inputs.verdict !== null) assertVerifyResult(inputs.verdict); return { stop: await attempt.finishStep(inputs.verdict) }; },
  };
  return Object.fromEntries(operations.map(operation => [operation, { async invoke(inputs: Readonly<WorkflowObject>, signal: AbortSignal) {
    try { return await attempt.operate(signal, () => actions[operation](inputs, signal)); }
    catch (error) { attempt.fail(error); throw error; }
  } }])) as Record<typeof operations[number], Facet>;
}

export const benchmarkOperationSteps: StepDefinition[] = operations.map(operation => {
    const capability = `benchmark.${operation}/v1`;
    const inputs: StepDefinition["inputs"] = operation === "begin" ? { index: jsonPort("arsi.number/v1") }
      : operation === "solve" ? { task: { protocol: "arsi.public-task/v1", validate: value => workflowValue(publicTask(value)) } }
        : operation === "verify" ? { solve: { protocol: "arsi.solve-result/v1", validate(value) { assertSolveResult(value); return workflowValue(value); } } }
          : operation === "finish" ? { verdict: { ...jsonPort("arsi.verdict/v1"), visibility: "private" } } : {};
    const outputs: StepDefinition["outputs"] = operation === "prepare" ? { parts: jsonPort("arsi.cases/v1") }
      : operation === "begin" ? { task: jsonPort("arsi.public-task/v1") }
      : operation === "solve" ? { solve: jsonPort("arsi.solve-result/v1") }
        : operation === "verify" ? { verdict: { ...jsonPort("arsi.verdict/v1"), visibility: "private" } }
          : operation === "finish" ? { stop: booleanPort() } : {};
    return { type: `benchmark.${operation}`, apiVersion: 1, version: "1", inputs, outputs,
      effects: "isolated-write", resources: { operation: { capability } }, validateConfig: empty,
      async execute(inputs, _config, context) {
        return await facet(context.resource("operation")).invoke(inputs, context.signal);
      },
    };
});

export function benchmarkAttemptDefinitions(attempt: BenchmarkAttempt): WorkflowDefinitions {
  const catalog = new WorkflowDefinitions();
  const actions = benchmarkActions(attempt);
  for (const operation of operations) {
    catalog.registerResource({ type: `benchmark.${operation}`, apiVersion: 1, version: "1", capabilities: [`benchmark.${operation}/v1`], resources: {}, validateConfig: empty,
      async create() { return { identity: {}, value: actions[operation] }; },
    });
  }
  for (const definition of benchmarkOperationSteps) catalog.registerStep(definition);
  return catalog;
}

export async function runBenchmarkAttemptWorkflow(attempt: BenchmarkAttempt, job: TaskJob, signal: AbortSignal, options: RunTaskOptions): Promise<void> {
  const catalog = benchmarkAttemptDefinitions(attempt);
  const document: WorkflowDocument = { schemaVersion: 2, inputs: {}, inputProtocols: {}, workflow: benchmarkAttemptBlock(),
    output: { directory: join(attempt.paths.root, "workflow") },
    run: { timeoutSeconds: (options.timeoutSeconds ?? DEFAULT_TASK_TIMEOUT_SECONDS) + (options.cleanupTimeoutMs ?? 60_000) / 1000 + 1,
      cleanupTimeoutSeconds: (options.cleanupTimeoutMs ?? 60_000) / 1000, onError: "stop" } };
  const plan = compileWorkflow(document, catalog);
  await executeWorkflow(plan, catalog, { store: new LocalWorkflowStore(document.output.directory), runId: job.attemptId, signal,
    ...(options.sensitiveValues ? { secrets: options.sensitiveValues } : {}) });
}
