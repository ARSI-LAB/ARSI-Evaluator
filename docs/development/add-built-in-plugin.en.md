# Add a Built-in Workflow Step

> English | [中文](add-built-in-plugin.md)

Register a step for data checks, preprocessing or grading. Do not add a component role to PluginRole, EffectiveConfig or Engine just to insert an operation.

For example, to limit the case count before model calls:

1. Add a StepDefinition under `src/plugins/steps/`, with cases as its input and `maxCases` as configuration.
2. Return the cases on success; throw an error containing the actual count when the limit is exceeded.
3. Register it in `registerWorkflowSteps`.
4. Export a flow with `inspect --output custom.yaml`, insert the step after case selection, and connect `forEach.items` to its output.

Users can add or remove this check without changing other flows or introducing a new global configuration field. See [workflow plugin development](workflow-plugins.md) and [built-in workflow components](built-in-role-development.en.md). New Solver or Metrics implementations continue to use their Benchmark-domain contracts.
