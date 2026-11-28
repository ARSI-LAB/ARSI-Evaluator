import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { pelicanRenderer, pelicanSteps, pelicanTemplate } from "../../plugins/workflow-pelican/index.js";
import { WorkflowDefinitions } from "../../src/core/workflow/catalog.js";
import { workflowBuiltinSteps } from "../../src/plugins/steps/workflow-builtins.js";
import { compileWorkflow } from "../../src/core/workflow/compile.js";
import { parseWorkflowDocument } from "../../src/config/workflow-schema.js";
import { executeWorkflow } from "../../src/core/workflow/execute.js";
import { LocalWorkflowStore } from "../../src/plugins/stores/workflow-local.js";
import { workflowObject } from "../../src/core/workflow/values.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

test.skipIf(!process.env.EMBER_TEST_CHROMIUM)("pelican template renders a real PNG and sends its pixels to a visual judge", async () => {
  const root = await mkdtemp(join(tmpdir(), "arsi-pelican-flow-")); roots.push(root);
  const definitions = new WorkflowDefinitions();
  for (const step of [...workflowBuiltinSteps, ...pelicanSteps]) definitions.registerStep(step);
  definitions.registerResource(pelicanRenderer);
  let generated = 0, judged = 0;
  definitions.registerResource({ type: "model.client", apiVersion: 1, version: "1", capabilities: ["application.invoke/v1"], sharing: "shared", resources: {}, validateConfig: workflowObject,
    async create(config) {
      const judge = workflowObject(config.settings).model === "judge";
      return { identity: {}, value: { async invoke(request: unknown) {
        if (!judge) {
          generated++;
          return { text: '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300"><rect width="300" height="300" fill="white"/><circle cx="80" cy="220" r="40" fill="none" stroke="black" stroke-width="5"/><circle cx="220" cy="220" r="40" fill="none" stroke="black" stroke-width="5"/><path d="M80 220 L130 150 L220 220 Z" fill="none" stroke="blue" stroke-width="5"/><ellipse cx="150" cy="115" rx="50" ry="30" fill="gray"/><circle cx="185" cy="65" r="20" fill="gray"/><path d="M200 65 L260 80 L200 80Z" fill="orange"/></svg>' };
        }
        judged++;
        const payload = JSON.stringify(request);
        expect(payload).toContain("data:image/png;base64,iVBOR");
        return { text: JSON.stringify({ score: 0.75, reason: "Controlled judge response" }) };
      } } };
    },
  });
  const plan = compileWorkflow(parseWorkflowDocument(pelicanTemplate.expand({ model: { model: "target" }, judge: { model: "judge" },
    browser: { executable: process.env.EMBER_TEST_CHROMIUM ?? "", width: 300, height: 300 }, report: false })), definitions);
  const storage = new LocalWorkflowStore(root);
  const record = await executeWorkflow(plan, definitions, { store: storage, signal: new AbortController().signal });
  expect(record.status, JSON.stringify(record.steps.filter(step => step.errors.length))).toBe("completed");
  expect(generated).toBe(1); expect(judged).toBe(1);
  expect(record.outputs.metrics).toMatchObject({ scores: { "default:pelican-visual": { count: 1, mean: 0.75 } } });
  const screenshot = record.artifacts.find(artifact => artifact.mediaType === "image/png");
  expect(screenshot?.size).toBeGreaterThan(1000);
  expect(record.resources.every(resource => resource.state === "released")).toBe(true);
}, 30_000);

test.each(['<image href="https://example.com/tracker.svg"/>', '<image href=https://example.com/tracker.svg/>', '<script>alert(1)</script>', '<rect fill="url(https://example.com/asset)"/>'])("pelican extraction rejects external or active SVG content: %s", async content => {
  const root = await mkdtemp(join(tmpdir(), "arsi-pelican-invalid-")); roots.push(root);
  const definitions = new WorkflowDefinitions();
  for (const step of pelicanSteps) definitions.registerStep(step);
  const document = parseWorkflowDocument({ schemaVersion: 2, workflow: { steps: [{ id: "extract", use: "pelican.extract",
    inputs: { response: { value: { text: `<svg>${content}</svg>` } } } }], outputs: { source: { ref: "extract.outputs.source" } } } });
  const record = await executeWorkflow(compileWorkflow(document, definitions), definitions, { store: new LocalWorkflowStore(root), signal: new AbortController().signal });
  expect(record.status).toBe("failed");
  expect(record.steps[0]?.errors[0]?.message).toContain("external resources");
  expect(record.artifacts).toHaveLength(0);
});

test("pelican extraction preserves local SVG gradients with quoted URL references", async () => {
  const root = await mkdtemp(join(tmpdir(), "arsi-pelican-gradient-")); roots.push(root);
  const definitions = new WorkflowDefinitions();
  for (const step of pelicanSteps) definitions.registerStep(step);
  const svg = '<svg><defs><linearGradient id="sky"/></defs><rect fill="url(\'#sky\')"/></svg>';
  const document = parseWorkflowDocument({ schemaVersion: 2, workflow: { steps: [{ id: "extract", use: "pelican.extract",
    inputs: { response: { value: { text: svg } } } }], outputs: { source: { ref: "extract.outputs.source" } } } });
  const record = await executeWorkflow(compileWorkflow(document, definitions), definitions, { store: new LocalWorkflowStore(root), signal: new AbortController().signal });
  expect(record.status).toBe("completed");
  expect(record.artifacts).toHaveLength(1);
});
