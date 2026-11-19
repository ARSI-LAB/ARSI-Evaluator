import asyncio
import importlib.util
import os
from pathlib import Path
import sys
import types

root = Path(sys.argv[1])


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


helper = load("reasoning_effort", root / "src/runtimes/shared/assets/reasoning_effort.py")
source = {"reasoning_effort": "high", "thinking": {"type": "disabled"}}
assert helper.apply_reasoning_effort(source, "low") == {
    "reasoning_effort": "low", "thinking": {"type": "enabled"}
}
assert source["reasoning_effort"] == "high"
assert source["thinking"]["type"] == "disabled"


class Completions:
    def create(self, **kwargs):
        return kwargs


class AsyncCompletions:
    async def create(self, **kwargs):
        return kwargs


sdk = types.ModuleType("openai.resources.chat.completions")
sdk.Completions = Completions
sdk.AsyncCompletions = AsyncCompletions
sys.modules["openai.resources.chat.completions"] = sdk
helper.install_openai_reasoning_effort("low", "target")
for result in (
    Completions().create(model="target", reasoning_effort="high", extra_body=source),
    asyncio.run(AsyncCompletions().create(model="target", reasoning_effort="max", extra_body=source)),
):
    assert result["reasoning_effort"] == "low"
    assert result["extra_body"]["reasoning_effort"] == "low"
    assert result["extra_body"]["thinking"]["type"] == "enabled"
assert Completions().create(model="other", reasoning_effort="high")["reasoning_effort"] == "high"


class ChatEndpoint:
    def format_payload(self, request):
        return request


endpoint = types.ModuleType("aiperf.endpoints.openai_chat")
endpoint.ChatEndpoint = ChatEndpoint
sys.modules["aiperf.endpoints.openai_chat"] = endpoint
sys.modules["reasoning_effort"] = helper
os.environ["EVALUATOR_AGENTX_REASONING_EFFORT"] = "low"
load("controlled_agentx_startup", root / "src/runtimes/agentx/assets/sitecustomize.py")
assert ChatEndpoint().format_payload(source)["reasoning_effort"] == "low"
assert source["reasoning_effort"] == "high"
print("Python reasoning overrides passed")
