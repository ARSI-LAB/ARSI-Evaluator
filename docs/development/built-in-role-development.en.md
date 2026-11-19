# Built-in Workflow Components

> English | [中文](built-in-role-development.md)

Choose the contract according to the operation:

| Behavior | Contract | Registration |
| --- | --- | --- |
| Validate or transform data, call an application, grade results | StepDefinition | registerStep |
| Own a client, browser or memory session | ResourceProvider | registerResource |
| Expand a few user parameters into ordered steps | WorkflowTemplate | registerWorkflow |
| Add a Solver, Verifier or Metrics implementation for Benchmark evaluation | Domain-specific contract | registerNativeResource |

Ordinary workflow extensions do not modify PluginRole, RunComponents or the execution kernel. The kernel reads nodes, ports and scopes, without branches based on plugin names.

Steps belong under src/plugins/steps, resources under src/plugins/resources, and templates under src/plugins/workflows. Repository source imports relative modules; only third-party plugins import the package root. Template expansion performs no I/O. An example parameter object enables init --workflow. Users can export and edit expanded YAML without a dedicated CLI option for every plugin.

Validate unknown fields, broken references after removing steps, semantic ports and private data boundaries. Resource tests also cover concurrency, cancellation, late-instance cleanup and crash recovery. Persist ownership before external allocation. Run dependency checks, typechecking, builds and affected behavioral tests. See [workflow plugin development](workflow-plugins.md) for contracts and lifecycle details.
