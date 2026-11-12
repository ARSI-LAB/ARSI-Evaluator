export const name = "evaluator-tool-policy";
export const inject = ["tools", "systemPrompt"];

export function apply(ctx, policy) {
  const tools = ctx.tools;
  const denied = name => policy.tools === "none" ||
    name === "web_search" && policy.webSearch === "disabled" ||
    name === "web_fetch" && policy.webFetch === "disabled";
  const originalResolve = tools.resolve;
  const resolve = async function (activation) {
    const resolved = await originalResolve.call(this, activation);
    try {
      const visible = resolved.view(activation.agent);
      for (const [field, name] of [["webSearch", "web_search"], ["webFetch", "web_fetch"]]) {
        if (policy[field] === "enabled" && !visible.has(name)) {
          throw new Error(`DSH ${name} is unavailable for the selected Profile and model service`);
        }
      }
      return {
        dispose: () => resolved.dispose(),
        view: scope => new Map([...resolved.view(scope)].filter(([name]) => !denied(name))),
      };
    } catch (error) {
      resolved.dispose();
      throw error;
    }
  };
  tools.resolve = resolve;

  // Scoped PTC executors can synthesize run_code even with an empty registry view.
  const prompt = ctx.systemPrompt;
  const originalAssemble = prompt.assemble;
  const assemble = async function (...args) {
    const result = await originalAssemble.apply(this, args);
    return { ...result, tools: [] };
  };
  if (policy.tools === "none") prompt.assemble = assemble;

  const disposeGuard = tools.guard(call => denied(call.name) ? "Disabled by the Evaluator tool policy" : undefined);
  ctx.on("dispose", () => {
    disposeGuard();
    if (tools.resolve === resolve) tools.resolve = originalResolve;
    if (prompt.assemble === assemble) prompt.assemble = originalAssemble;
  });
}
