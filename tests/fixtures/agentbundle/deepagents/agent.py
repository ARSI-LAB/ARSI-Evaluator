"""Controlled composition entry for the evaluator deepagents bundle fixture.

Mirrors the real Ember-LangGraph delivery contract with zero third-party
dependencies: ``build_agent(extra_middleware=())`` returns a deterministic
graph that records assembled system prompts through the caller's middleware
(same ``wrap_model_call`` request shape deepagents uses), performs one write
tool round-trip against the task workspace, and finishes with a final answer
carrying ``usage_metadata``. The runner protocol maps these onto the evaluator
harness event stream.

Expose:
- ``agent`` — the composed graph (import: ``from agent import agent``)
- ``AGENT_NAME`` / ``SYSTEM_PROMPT`` / ``build_agent(extra_middleware=())``
"""

from __future__ import annotations

import os
from pathlib import Path

AGENT_NAME = "evaluator-fixture"
SYSTEM_PROMPT = "FIXTURE_SYSTEM_PROMPT: evaluator deepagents composition contract"
TOOL_NAME = "write_file"


class Message:
    """Minimal langchain-shaped message for the runner protocol mapping."""

    def __init__(self, role: str, content, *, tool_calls=None, tool_call_id=None,
                 status: str = "success", usage_metadata=None) -> None:
        self.type = role
        self.content = content
        self.tool_calls = tool_calls
        self.tool_call_id = tool_call_id
        self.status = status
        self.usage_metadata = usage_metadata


class Request:
    """Minimal middleware request carrying the assembled system message."""

    def __init__(self, system_message) -> None:
        self.system_message = system_message


class FakeGraph:
    def __init__(self, middleware) -> None:
        self.middleware = list(middleware)

    def invoke(self, state) -> dict:
        task = ""
        for message in state.get("messages", []):
            content = message[1] if isinstance(message, tuple) else getattr(message, "content", "")
            if content:
                task = str(content)
        for middleware in self.middleware:
            middleware.wrap_model_call(Request(Message("system", SYSTEM_PROMPT)), lambda request: request)
        # Deterministic one-round script: one write tool call, then the final
        # answer — mirrors the real office bundle's keyless fake-model script.
        call = {"name": TOOL_NAME, "args": {"file_path": "marker.txt", "content": task}, "id": "call_fixture_0"}
        target = Path(os.getcwd()) / os.path.basename(str(call["args"]["file_path"]))
        target.write_text(str(call["args"]["content"]), encoding="utf-8")
        return {"messages": [
            Message("human", task),
            Message("ai", "", tool_calls=[dict(call, type="tool_call")], usage_metadata={
                "input_tokens": 5, "output_tokens": 4, "total_tokens": 9,
            }),
            Message("tool", f"Wrote {target.name}", tool_call_id=call["id"]),
            Message("ai", f"Answer: {task}", usage_metadata={
                "input_tokens": 11, "output_tokens": 7, "total_tokens": 18,
                "input_token_details": {"cache_read": 3, "cache_write": 2},
            }),
        ]}


def build_agent(extra_middleware=(), checkpointer=None):
    return FakeGraph(extra_middleware)


agent = build_agent()
