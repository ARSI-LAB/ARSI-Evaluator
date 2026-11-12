"""Apply an attempt's tool policy inside the pinned JiuwenSwarm process."""

from __future__ import annotations

_SEARCH_TOOLS = frozenset({
    "web_free_search", "web_paid_search", "web_search", "mcp_free_search", "mcp_paid_search",
})
_FETCH_TOOLS = frozenset({"web_fetch_webpage", "web_fetch"})


def install_tool_policy(policy: dict) -> None:
    from jiuwenswarm.server.runtime.agent_adapter.interface_code import JiuwenSwarmCodeAdapter
    from openjiuwen.core.foundation.llm import ToolMessage
    from openjiuwen.core.single_agent.rail.base import AgentRail

    no_tools = policy.get("tools") == "none"

    def matches(name: str, names: frozenset[str]) -> bool:
        return name in names or any(name.endswith("__" + tool) for tool in names)

    def denied(name: str) -> bool:
        return (
            no_tools
            or (policy.get("webSearch") == "disabled" and matches(name, _SEARCH_TOOLS))
            or (policy.get("webFetch") == "disabled" and matches(name, _FETCH_TOOLS))
        )

    def tool_name(tool) -> str:
        if isinstance(tool, dict):
            return tool.get("name") or tool.get("function", {}).get("name") or ""
        return getattr(tool, "name", "")

    class ToolPolicyRail(AgentRail):
        priority = -1000

        async def before_model_call(self, ctx):
            if no_tools:
                ctx.inputs.tools = []
                return
            available = ctx.inputs.tools or []
            filtered = [tool for tool in available if not denied(tool_name(tool))]
            for field, names in (("webSearch", _SEARCH_TOOLS), ("webFetch", _FETCH_TOOLS)):
                if policy.get(field) == "enabled" and not any(matches(tool_name(tool), names) for tool in filtered):
                    raise RuntimeError(f"JiuwenSwarm {field} is unavailable for the selected model and tool configuration")
            ctx.inputs.tools = filtered

        async def before_tool_call(self, ctx):
            if not denied(ctx.inputs.tool_name) or ctx.extra.get("_skip_tool"):
                return
            message = "Disabled by the Evaluator tool policy"
            call = ctx.inputs.tool_call
            ctx.extra["_skip_tool"] = True
            ctx.inputs.tool_result = {"error": message}
            ctx.inputs.tool_msg = ToolMessage(content=message, tool_call_id=call.id if call else "")

    original_rails = JiuwenSwarmCodeAdapter._build_agent_rails

    def build_rails(adapter, *args, **kwargs):
        return [*original_rails(adapter, *args, **kwargs), ToolPolicyRail()]

    JiuwenSwarmCodeAdapter._build_agent_rails = build_rails
    if no_tools:
        JiuwenSwarmCodeAdapter._build_configured_subagents = lambda *_args, **_kwargs: ([], False)
        JiuwenSwarmCodeAdapter.merge_member_mcp_configs = lambda *_args, **_kwargs: 0
