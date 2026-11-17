import { expect, test } from "vitest";
import { adaptProviderOutputSource, streamWithProviderOutput } from "../../src/runtimes/dsh/assets/output-hook.mjs";

const selected = { provider: "ember-evaluator", model: "fixture" };
const model = { ...selected, id: "fixture", api: "openai-completions", maxTokens: 32768 };

test("unset output uses the provider default without mutating metadata or payload", async () => {
  const payload = Object.freeze({ model: "fixture", messages: [], max_tokens: 32768, max_completion_tokens: 32768 });
  const owner = { async streamSimple(actual, _context, options) {
    expect(actual).toBe(model);
    return options.onPayload(payload);
  } };
  expect(await streamWithProviderOutput(owner, model, {}, {}, selected)).toEqual({ model: "fixture", messages: [] });
  expect(model.maxTokens).toBe(32768);
  expect(payload.max_completion_tokens).toBe(32768);
});

test.each([
  { chosen: selected, descriptor: model, options: { maxTokens: 1024 } },
  { chosen: undefined, descriptor: model, options: {} },
  { chosen: selected, descriptor: { ...model, provider: "other" }, options: {} },
  { chosen: selected, descriptor: { ...model, id: "other" }, options: {} },
  { chosen: selected, descriptor: { ...model, api: "anthropic-messages" }, options: {} },
])("explicit limits and unselected routes pass through unchanged: %j", async ({ chosen, descriptor, options }) => {
  const owner = { streamSimple(actual, context, received) { expect(actual).toBe(descriptor); expect(received).toBe(options); return context; } };
  const context = {};
  expect(streamWithProviderOutput(owner, descriptor, context, options, chosen)).toBe(context);
});

test("preserves an existing asynchronous payload hook and its other fields", async () => {
  const owner = { streamSimple(_model, _context, options) { return options.onPayload({ max_tokens: 32768 }); } };
  expect(await streamWithProviderOutput(owner, model, {}, { onPayload: async () => ({ max_completion_tokens: 32768, temperature: 0.5 }) }, selected)).toEqual({ temperature: 0.5 });
});

test("only adapts one recognized adapter seam and fails closed on drift", () => {
  const seam = "snapshot.models.streamSimple(model, context, {";
  expect(adaptProviderOutputSource(`before(${seam}signal}));`)).toContain('](snapshot.models, model, context, {signal}));');
  expect(() => adaptProviderOutputSource("unknown adapter")).toThrow("Unsupported DSH pi-ai adapter");
  expect(() => adaptProviderOutputSource(seam + seam)).toThrow("unique");
});
