"""Apply an explicit service effort to OpenAI-compatible Python requests."""

from functools import wraps


def apply_reasoning_effort(payload, effort):
    body = dict(payload)
    body["reasoning_effort"] = effort
    if isinstance(body.get("reasoning"), dict) and "effort" in body["reasoning"]:
        body["reasoning"] = {**body["reasoning"], "effort": effort}
    if body.get("enable_thinking") is False:
        body["enable_thinking"] = True
    if isinstance(body.get("thinking"), dict) and body["thinking"].get("type") == "disabled":
        body["thinking"] = {**body["thinking"], "type": "enabled"}
    if isinstance(body.get("chat_template_kwargs"), dict):
        template = dict(body["chat_template_kwargs"])
        if "reasoning_effort" in template:
            template["reasoning_effort"] = effort
        if template.get("enable_thinking") is False:
            template["enable_thinking"] = True
        body["chat_template_kwargs"] = template
    return body


def install_openai_reasoning_effort(effort, model_name):
    from openai.resources.chat.completions import AsyncCompletions, Completions

    def parameters(kwargs):
        if kwargs.get("model") != model_name:
            return kwargs
        result = {**kwargs, "reasoning_effort": effort}
        if isinstance(result.get("extra_body"), dict):
            result["extra_body"] = apply_reasoning_effort(result["extra_body"], effort)
        return result

    original_sync = Completions.create
    original_async = AsyncCompletions.create

    @wraps(original_sync)
    def create(self, *args, **kwargs):
        return original_sync(self, *args, **parameters(kwargs))

    @wraps(original_async)
    async def acreate(self, *args, **kwargs):
        return await original_async(self, *args, **parameters(kwargs))

    Completions.create = create
    AsyncCompletions.create = acreate
