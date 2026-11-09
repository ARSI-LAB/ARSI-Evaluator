import { expect, test } from "vitest";
import { computeDelta } from "../collector/delta.js";

const population = {
  tasks: 1,
  success_rate: 1,
  p50_latency_ms: null,
  p95_latency_ms: null,
  cost_usd: null,
  steps_mean: 0,
};

const run = {
  maxTasks: null as number | null,
  taskIds: null as string[] | null,
  timeoutSeconds: 7200,
  onError: "continue",
};

const config = {
  model: "fixture",
  api: "openai-completions",
  provider: null,
  hardware: "npu",
  benchmark: "cli-fixture",
  environment: "local",
  solver: "cli-fixture",
  scheduler: "local",
  metrics: ["success-rate", "duration", "usage"],
  reporter: "markdown",
  run,
};

function attributionOf(current: Record<string, unknown>, parent: Record<string, unknown>): unknown {
  const [delta] = computeDelta({ config: current }, population, { config: parent }, population, "parent", "en");
  return delta.attribution;
}

test("identical nested run config is not reported as a benchmark change", () => {
  const current = { ...config, run: { ...run } };
  const parent = { ...config, run: { ...run } };
  expect(attributionOf(current, parent)).toMatchObject({ changed: "none", keys: [] });
});

test("a model-only change is attributed to the model despite the nested run config", () => {
  expect(attributionOf({ ...config, model: "other" }, config)).toMatchObject({
    changed: "model",
    keys: ["model"],
  });
});

test("a real task scope change is still reported as a benchmark change", () => {
  expect(attributionOf({ ...config, run: { ...run, taskIds: ["a"] } }, config)).toMatchObject({
    changed: "benchmark",
    keys: ["run"],
  });
});
