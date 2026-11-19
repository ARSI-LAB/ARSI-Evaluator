"""Apply the configured service effort in every pinned AgentX worker process."""

import os

effort = os.environ.get("EVALUATOR_AGENTX_REASONING_EFFORT")
if effort:
    try:
        from aiperf.endpoints.openai_chat import ChatEndpoint
        from reasoning_effort import apply_reasoning_effort

        original = ChatEndpoint.format_payload

        def format_payload(self, request_info):
            return apply_reasoning_effort(original(self, request_info), effort)

        ChatEndpoint.format_payload = format_payload
    except Exception as error:
        raise SystemExit(f"Cannot apply AgentX service reasoning effort: {error}") from error
