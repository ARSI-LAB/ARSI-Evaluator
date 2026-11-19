import { expect, test } from "vitest";
import { parseMaintenanceResults } from "../../src/core/workflow/maintenance.js";

const result = { path: "workflow.resources.images", provider: "fixture.images", status: "passed",
  output: { ready: ["a"], placements: [{ taskId: "a", nodeId: "node" }] }, summary: "Prepared 1/1", details: [] };

test("maintenance transport preserves plugin statistics, summaries and failure lines", () => {
  expect(parseMaintenanceResults([result])).toEqual([result]);
  const failed = { ...result, status: "failed", output: { ready: [] }, details: ["a: download failed"] };
  expect(parseMaintenanceResults([failed])).toEqual([failed]);
});

test.each([
  { ...result, status: "ready" }, { ...result, status: "deferred" }, { ...result, status: "not-required" },
  { ...result, output: null }, { ...result, output: { ready: undefined } }, { ...result, summary: 1 },
  { ...result, details: "failed" }, { ...result, details: [null] }, { ...result, unexpected: true },
])("malformed maintenance responses cannot be presented as successful warmup", value => {
  expect(() => parseMaintenanceResults([value])).toThrow();
});
