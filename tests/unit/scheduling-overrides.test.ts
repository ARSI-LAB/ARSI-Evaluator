import { expect, test } from "vitest";
import { applyScheduling } from "../../src/application/scheduling.js";
import { harness } from "../fixtures/engine/fakes.js";
import { fingerprintResumeConfig } from "../../src/core/results/run-manifest.js";
import { planResume } from "../../src/core/recovery/resume.js";
import { storeRun } from "../fixtures/results/store-fixture.js";

function configuration() {
  const config = harness("unused-scheduling-test").config;
  config.experiment.run.preparation = { mode: "batch", concurrency: 1, environmentTimeoutSeconds: 1800, roundTimeoutSeconds: 86400 };
  config.persisted = structuredClone(config.experiment) as unknown as typeof config.persisted;
  return config;
}

test("operational scheduling changes only live limits and retains the immutable resume identity", () => {
  const original = configuration(), before = structuredClone(original), fingerprint = fingerprintResumeConfig(original.persisted);
  const applied = applyScheduling(original, { concurrency: 16, preparationConcurrency: 16, reason: "operator request" });
  expect(original).toEqual(before);
  expect(applied.config.persisted).toEqual(before.persisted);
  expect(applied.config.experiment.scheduler.config.concurrency).toBe(16);
  expect(applied.config.experiment.run.preparation).toEqual({ ...before.experiment.run.preparation, concurrency: 16 });
  expect(applied.config.experiment.run.timeoutSeconds).toBe(before.experiment.run.timeoutSeconds);
  expect(applied.receipt).toMatchObject({ concurrency: 16, preparationConcurrency: 16, baseConfigFingerprint: fingerprint, reason: "operator request" });
  expect(planResume({ ...storeRun, configFingerprint: fingerprint }, [], fingerprintResumeConfig(applied.config.persisted))).toBeDefined();
  const changed = structuredClone(applied.config.persisted) as Record<string, unknown>;
  changed.services = { changed: true };
  expect(() => planResume({ ...storeRun, configFingerprint: fingerprint }, [], fingerprintResumeConfig(changed as never))).toThrow(/configuration differs/);
});

test.each([0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1])("rejects invalid operational concurrency %s", concurrency => {
  expect(() => applyScheduling(configuration(), { concurrency, reason: "operator" })).toThrow();
  expect(() => applyScheduling(configuration(), { concurrency: 16, preparationConcurrency: concurrency, reason: "operator" })).toThrow();
});

test("requires a reason, local execution and an explicit preparation policy", () => {
  const config = configuration();
  expect(() => applyScheduling(config, { concurrency: 16, reason: " " })).toThrow();
  config.experiment.scheduler.name = "ray";
  expect(() => applyScheduling(config, { concurrency: 16, reason: "operator" })).toThrow(/local scheduler/);
  config.experiment.scheduler.name = "local";
  delete config.experiment.run.preparation;
  expect(() => applyScheduling(config, { concurrency: 16, preparationConcurrency: 16, reason: "operator" })).toThrow(/explicit preparation/);
});
