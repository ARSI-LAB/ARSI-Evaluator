"""Controlled pinned-Hermes boundaries for the Evaluator output capture runner."""

import importlib.util
import json
import sys
from pathlib import Path
from types import ModuleType, SimpleNamespace

sys.dont_write_bytecode = True
runner, target, scenario = sys.argv[1:]
agent_module = ModuleType("agent")
check = ModuleType("agent.turn_response_check")
truncation = ModuleType("agent.turn_truncation")
oneshot = ModuleType("hermes_cli.oneshot")
cli = ModuleType("hermes_cli")
constants = ModuleType("hermes_constants")
constants.PARTIAL_STREAM_STUB_ID = "partial-stream-stub"
agent_module.turn_response_check = check
agent_module.turn_truncation = truncation
cli.oneshot = oneshot
for module in (agent_module, check, truncation, oneshot, cli, constants):
    sys.modules[module.__name__] = module

result = {"failure_reason": "truncated", "partial": True, "completed": False,
          "messages": [{"role": "assistant", "finish_reason": "length", "content": "partial secret"}]}
message = SimpleNamespace(content="partial secret", finish_reason="length")
response = SimpleNamespace(id="provider-response")
action = "return"
if scenario == "network":
    response.id = constants.PARTIAL_STREAM_STUB_ID
if scenario == "no-reason":
    message.finish_reason = "stop"
if scenario == "auth":
    result["failure_reason"] = "auth"
if scenario == "cancelled":
    result["interrupted"] = True
if scenario == "context":
    result["compression_exhausted"] = True
if scenario == "retry":
    action = "continue"
if scenario == "empty":
    result["messages"] = []
    message.content = ""

calls = []


def recover(*args, **kwargs):
    calls.append(True)
    return SimpleNamespace(action=action, result=result)


def write_usage(path, result, failure=None):
    Path(path).write_text(json.dumps({"output_tokens": 8, "failure": failure,
                                    "interrupted": result.get("interrupted", False)}), encoding="utf-8")


check.recover_from_truncation = recover
truncation.normalize_response_for_agent = lambda *args: message
oneshot._write_usage_file = write_usage
spec = importlib.util.spec_from_file_location("evaluator_hermes_runner", runner)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
module.install_output_capture()
agent = SimpleNamespace(_strip_think_blocks=lambda text: text)
check.recover_from_truncation(agent, response, "length")
assert len(calls) == 1
if scenario == "later-error":
    result["failure_reason"] = "auth"
oneshot._write_usage_file(target, result, "authentication failed" if scenario == "report-error" else None)
print(Path(target).read_text(encoding="utf-8"))
