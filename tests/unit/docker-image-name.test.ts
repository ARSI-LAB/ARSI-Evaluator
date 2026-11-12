import { expect, test } from "vitest";
import { dockerImageName, dockerImageReference } from "../../src/infrastructure/containers/image-name.js";

test("readable references use the dataset, relative task, platform and purpose", () => {
  expect(dockerImageReference("linux/amd64", "base")).toBe("ember-evaluator/base:linux-amd64-base");
  for (const dataset of ["terminal-bench@4.0", "terminal-bench@4.0.0"])
    expect(dockerImageReference("linux/amd64", "solver-codex", { dataset, taskPath: "coq-block-bound" }))
      .toBe("ember-evaluator/terminalbench4.0/coq-block-bound:linux-amd64-solver-codex");
  expect(dockerImageReference("linux/arm64", "verify", { dataset: "OfficeQA-Pro-V2" }))
    .toBe("ember-evaluator/officeqa-pro-v2:linux-arm64-verify");
});

test("image names share content across tasks and distinguish phases and kinds", () => {
  const scope = { taskId: "terminal-bench/atrx-vep-crispr", phase: "solve" as const };
  const name = dockerImageName("runtime", "same-content", scope);
  expect(name).toMatch(/^ember-evaluator\/shared:solve-runtime-[a-f0-9]{24}$/u);
  expect(dockerImageName("runtime", "same-content", scope)).toBe(name);
  expect(dockerImageName("runtime", "same-content", { ...scope, taskId: "other/task" })).toBe(name);
  expect(dockerImageName("runtime", "new-content", scope)).not.toBe(name);
  expect(dockerImageName("runtime", "same-content", { ...scope, phase: "verify" }))
    .toMatch(/^ember-evaluator\/shared:verify-runtime-[a-f0-9]{24}$/u);
  expect(dockerImageName("solver-install", "shared"))
    .toMatch(/^ember-evaluator\/shared:solver-install-[a-f0-9]{24}$/u);
});

test("full service IDs disambiguate normalized and truncated names", () => {
  const scope = { taskId: "题目", phase: "verify" as const, service: "Redis_1" };
  expect(dockerImageName("base", "content", scope))
    .toMatch(/^ember-evaluator\/shared:verify-service-redis-1-base-[a-f0-9]{24}$/u);
  expect(dockerImageName("base", "content", { ...scope, service: "redis-1" }))
    .not.toBe(dockerImageName("base", "content", scope));
  const long = dockerImageName("agent-base", "content", { taskId: "a".repeat(1000), phase: "verify", service: "b".repeat(1000) });
  expect(long.split(":")[0]!.length).toBeLessThanOrEqual(255);
  expect(long.split(":")[1]!.length).toBeLessThanOrEqual(128);
});
