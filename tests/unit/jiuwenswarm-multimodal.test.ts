import { expect, test } from "vitest";
import { parse } from "yaml";
import { mergeJiuwenswarmModelConfig } from "../../src/runtimes/jiuwenswarm/prepare.js";

test("JiuwenSwarm keeps candidate model settings while enabling native input and tool images", () => {
  const config = parse(mergeJiuwenswarmModelConfig(`react:
  max_iterations: 7
models:
  defaults:
    - model_client_config:
        model_name: \${MODEL_NAME}
      model_config_obj:
        temperature: 0.2
`, true));
  expect(config.react).toEqual({ max_iterations: 7, enable_read_image_multimodal: true });
  expect(config.models.defaults[0]).toMatchObject({ model_client_config: { model_name: "${MODEL_NAME}", supports_vision: true }, model_config_obj: { temperature: 0.2 } });
});

test("JiuwenSwarm overrides native output, loop and compaction settings without dropping model or engine options", () => {
  const original = "react:\n  max_iterations: 40\n  context_engine_config: { enabled: false, enable_reload: true }\nmodels:\n  defaults:\n    - model_config_obj: { temperature: 0.2, max_tokens: 8192 }";
  const limits = { maxTurns: 3, maxTokens: 512, contextWindow: 100000 };
  const config = parse(mergeJiuwenswarmModelConfig(original, false, undefined, limits));
  expect(config.react).toEqual({ max_iterations: 3, context_engine_config: {
    enabled: true, enable_reload: true, context_window_tokens: 100000,
  } });
  expect(config.models.defaults[0].model_config_obj).toEqual({ temperature: 0.2, max_tokens: 512, context_window: 100000 });
  expect(parse(mergeJiuwenswarmModelConfig(original)).react).toEqual(parse(original).react);
});

test.each([
  "react:\n  enable_read_image_multimodal: false\n",
  "models:\n  defaults:\n    - model_client_config:\n        supports_vision: false\n",
])("JiuwenSwarm refuses candidate settings that disable native images", config => {
  expect(() => mergeJiuwenswarmModelConfig(config, true)).toThrow(/disables native image/);
});

test("text-only JiuwenSwarm does not enable vision or erase an explicit opt-out", () => {
  const config = parse(mergeJiuwenswarmModelConfig("react:\n  enable_read_image_multimodal: false\n"));
  expect(config.react.enable_read_image_multimodal).toBe(false);
  expect(config.models.defaults[0].model_client_config.supports_vision).toBeUndefined();
});
