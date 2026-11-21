"""Apply an attempt's tool policy inside the pinned JiuwenSwarm process."""

from __future__ import annotations

import re
from pathlib import Path

_SEARCH_TOOLS = frozenset({
    "web_free_search", "web_paid_search", "free_search", "paid_search", "web_search", "mcp_free_search", "mcp_paid_search",
})
_FETCH_TOOLS = frozenset({"web_fetch_webpage", "fetch_webpage", "web_fetch"})


def install_tool_policy(policy: dict, on_unavailable) -> None:
    from jiuwenswarm.server.runtime.agent_adapter.interface_code import JiuwenSwarmCodeAdapter
    from openjiuwen.core.foundation.llm import ToolMessage
    from openjiuwen.core.single_agent.rail.base import AgentRail

    no_tools = policy.get("tools") == "none"

    def matches(name: str, names: frozenset[str]) -> bool:
        return name in names or any(name.endswith("__" + tool) for tool in names)

    def tool_name(tool) -> str:
        if isinstance(tool, dict):
            return tool.get("name") or tool.get("function", {}).get("name") or ""
        return getattr(tool, "name", "")

    class ToolPolicyRail(AgentRail):
        priority = -1000

        def __init__(self, adapter):
            super().__init__()
            self.adapter = adapter

        def denied(self, name: str) -> bool:
            if no_tools:
                manager = self.adapter._instance.ability_manager
                if policy.get("mcp") == "disabled" or manager._resolve_mcp_tool_scope(name) is None:
                    return True
            return (
                (policy.get("webSearch") == "disabled" and matches(name, _SEARCH_TOOLS))
                or (policy.get("webFetch") == "disabled" and matches(name, _FETCH_TOOLS))
            )

        async def before_model_call(self, ctx):
            available = ctx.inputs.tools or []
            filtered = [tool for tool in available if not self.denied(tool_name(tool))]
            # JiuwenSwarm logs rail exceptions and continues with ctx.inputs.
            ctx.inputs.tools = filtered
            if no_tools:
                return
            for field, names in (("webSearch", _SEARCH_TOOLS), ("webFetch", _FETCH_TOOLS)):
                if policy.get(field) != "enabled":
                    continue
                visible = [tool_name(tool) for tool in filtered]
                if field == "webSearch" and any(re.fullmatch(r"mcp_evaluator-search(?:-fallback)*_web_search", name) for name in visible):
                    continue
                if not any(matches(name, names) for name in visible):
                    reason = f"JiuwenSwarm: {field}: enabled requires a {field} tool in the active Bundle profile."
                    if field == "webSearch" and policy.get("mcp") == "disabled":
                        reason += " With mcp: disabled, supplementary search cannot replace the missing native tool."
                    on_unavailable(reason)
                    ctx.request_force_finish({"output": reason, "result_type": "answer"})
                    return

        async def before_tool_call(self, ctx):
            if not self.denied(ctx.inputs.tool_name) or ctx.extra.get("_skip_tool"):
                return
            message = "Disabled by the Evaluator tool policy"
            call = ctx.inputs.tool_call
            ctx.extra["_skip_tool"] = True
            ctx.inputs.tool_result = {"error": message}
            ctx.inputs.tool_msg = ToolMessage(content=message, tool_call_id=call.id if call else "")

    original_rails = JiuwenSwarmCodeAdapter._build_agent_rails

    def build_rails(adapter, *args, **kwargs):
        return [*original_rails(adapter, *args, **kwargs), ToolPolicyRail(adapter)]

    JiuwenSwarmCodeAdapter._build_agent_rails = build_rails
    if no_tools or policy.get("subagent") == "disabled":
        JiuwenSwarmCodeAdapter._build_configured_subagents = lambda *_args, **_kwargs: ([], False)
    if policy.get("mcp") == "disabled":
        JiuwenSwarmCodeAdapter.merge_member_mcp_configs = lambda *_args, **_kwargs: 0


def install_task_resources(policy: dict, resources: dict) -> None:
    from jiuwenswarm.server.runtime.agent_adapter.interface_code import JiuwenSwarmCodeAdapter
    from jiuwenswarm.server.runtime.agent_adapter.interface_deep import JiuWenSwarmDeepAdapter

    disabled = policy.get("mcp") == "disabled"
    servers = [
        {**server, "enabled": True, "transport": "streamable-http" if server["transport"] == "http" else server["transport"]}
        for server in resources.get("mcpServers", [])
    ]

    def combine(original):
        def entries(config):
            if disabled:
                return []
            merged = {entry["name"]: entry for entry in original(config)}
            for server in servers:
                if server["name"] in merged and merged[server["name"]].get("url") != server["url"]:
                    raise ValueError("Duplicate JiuwenSwarm task MCP server: " + server["name"])
                merged[server["name"]] = server
            return list(merged.values())

        return staticmethod(entries)

    if disabled or servers:
        for name in ("_extract_enabled_mcp_server_entries", "_yaml_enabled_mcp_entries"):
            setattr(JiuWenSwarmDeepAdapter, name, combine(getattr(JiuWenSwarmDeepAdapter, name)))

    paths = resources.get("skillsDirectories", [])
    if policy.get("skills") == "disabled":
        # Suppress both prompt rails and on-demand retrieval before construction.
        JiuWenSwarmDeepAdapter._skill_scan_dirs = lambda self: []
        for method in ("_build_skill_rail", "_build_skill_evolution_rail", "_build_skill_create_rail"):
            setattr(JiuWenSwarmDeepAdapter, method, lambda *args, **kwargs: None)
        JiuwenSwarmCodeAdapter._build_skill_toolkit = lambda *args, **kwargs: None
        JiuwenSwarmCodeAdapter._resolve_skill_retrieval_session_enabled = lambda *args, **kwargs: False
        return

    if paths:
        original_dirs = JiuWenSwarmDeepAdapter._skill_scan_dirs

        def skill_dirs(adapter):
            return list(dict.fromkeys([*original_dirs(adapter), *paths]))

        JiuWenSwarmDeepAdapter._skill_scan_dirs = skill_dirs

    from openjiuwen.core.single_agent.rail.base import AgentRail
    from openjiuwen.harness.rails.skills.skill_use_rail import SkillUseRail

    build_rails = JiuwenSwarmCodeAdapter._build_agent_rails

    def rails_with_skills(adapter, *args, **kwargs):
        rails = list(build_rails(adapter, *args, **kwargs))
        if adapter._skill_rail is None and (
            paths or SkillUseRail._discover_skill_dirs([Path(root) for root in adapter._skill_scan_dirs()])
        ):
            rail = adapter._build_skill_rail_via_config()
            if rail is not None:
                rails.append(rail)
        return rails

    JiuwenSwarmCodeAdapter._build_agent_rails = rails_with_skills

    class ChildSkillRail(AgentRail):
        def __init__(self, adapter):
            super().__init__()
            self.adapter = adapter

        def fork_for_agent(self):
            # The SDK calls this for each delegation. A SkillUseRail holds the
            # current agent's prompt state and must not be shared with siblings.
            rail = self.adapter._build_skill_rail(self.adapter._config_cache, include_tools=False)
            if rail is None:
                raise RuntimeError("JiuwenSwarm could not build the child skill reader")
            return rail

    build_subagents = JiuwenSwarmCodeAdapter._build_configured_subagents

    def subagents_with_skills(adapter, *args, **kwargs):
        specs, flag = build_subagents(adapter, *args, **kwargs)
        if adapter._skill_rail is not None:
            for spec in specs or ():
                spec.rails = [*(spec.rails or ()), ChildSkillRail(adapter)]
        return specs, flag

    JiuwenSwarmCodeAdapter._build_configured_subagents = subagents_with_skills
