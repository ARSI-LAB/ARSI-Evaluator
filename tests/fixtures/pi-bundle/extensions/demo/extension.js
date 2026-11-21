// Minimal pi extension for evaluator tests. It exercises the three integration
// points the simpleagent bundle support relies on: an LLM-callable tool, a
// contributed skill directory and a system-prompt injection, so tests can
// observe all of them from the wire-level request bodies.
export default function demoExtension(pi) {
  const policy = JSON.parse(process.env.PI_BUNDLE_RUN_POLICY ?? "{}");
  if (policy.tools !== "none") pi.registerTool({
    name: "demo_bundle_echo",
    label: "Demo bundle echo",
    description: "Echoes text back so tests can verify extension tools reach the model.",
    parameters: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
      additionalProperties: false,
    },
    execute: async (_toolCallId, params) => ({
      content: [{ type: "text", text: `demo-bundle:${params.text}` }],
    }),
  });

  if (policy.skills !== "disabled") pi.on("resources_discover", async () => {
    const { fileURLToPath } = await import("node:url");
    const { dirname, join } = await import("node:path");
    return { skillPaths: [join(dirname(fileURLToPath(import.meta.url)), "skills")] };
  });

  pi.on("before_agent_start", async (event) => ({
    systemPrompt: `${event.systemPrompt}\n\nDemo bundle extension active: DEMO_BUNDLE_INSTRUCTIONS`,
  }));
}
