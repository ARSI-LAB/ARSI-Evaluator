function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function applyReasoningEffort(payload, api, effort) {
  if (!record(payload)) throw new TypeError("Model request body must be a JSON object");
  const body = { ...payload };
  switch (api) {
    case "openai-completions":
      body.reasoning_effort = effort;
      // Several OpenAI-compatible clients emit both the standard field and
      // provider extensions. Keep every supplied effort and toggle consistent.
      if (record(body.reasoning) && Object.hasOwn(body.reasoning, "effort"))
        body.reasoning = { ...body.reasoning, effort };
      if (body.enable_thinking === false) body.enable_thinking = true;
      if (body.thinking?.type === "disabled") body.thinking = { type: "enabled" };
      if (record(body.chat_template_kwargs)) {
        const template = { ...body.chat_template_kwargs };
        if (Object.hasOwn(template, "reasoning_effort")) template.reasoning_effort = effort;
        if (template.enable_thinking === false) template.enable_thinking = true;
        body.chat_template_kwargs = template;
      }
      break;
    case "openai-responses":
      body.reasoning = { ...(record(body.reasoning) ? body.reasoning : {}), effort };
      delete body.reasoning_effort;
      break;
    case "anthropic-messages":
      body.output_config = { ...(record(body.output_config) ? body.output_config : {}), effort };
      body.thinking = { type: "adaptive",
        ...(body.thinking?.display === undefined ? {} : { display: body.thinking.display }) };
      break;
    default:
      throw new TypeError(`Cannot set reasoning effort for model protocol ${api}`);
  }
  return body;
}
