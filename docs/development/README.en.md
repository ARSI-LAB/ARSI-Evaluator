# Development Documentation

> English | [中文](./README.md)

These guides are for developers modifying Evaluator or writing plugins. For installation, experiment execution, and troubleshooting, see the [user documentation](../users/README.md).

## Add your first component

| What you want to do | Start here | Further reading |
| --- | --- | --- |
| Write a Solver that answers questions | [Add a Solver](add-solver.en.md) | [Models, runtimes, and cleanup](solver-development.en.md) |
| Add a component role alongside Environment and Scheduler | [Add a built-in component role](add-built-in-plugin.en.md) | [Contract, registration, configuration, and execution](built-in-role-development.en.md) |
| Load a file you wrote through `--patch` | [Add an external plugin](add-external-plugin.en.md) | [TypeScript, package loading, and Ray](external-plugins.en.md) |

## Other development guides

| Goal | Guide |
| --- | --- |
| Add an implementation of an existing role, such as a metric | [Add a built-in implementation for an existing role](plugins.en.md#add-a-built-in-implementation-for-an-existing-role) |
| Integrate datasets: check official requirements, configure images, platforms, resources, and timeouts, and verify acceptance | [Benchmark requirements and acceptance](benchmark-evaluation-requirements.en.md) |
| Write plugins: implement contracts, register profiles, manage resources, and run regression tests | [Benchmark development](benchmarks.en.md) |
| Throw structured errors and preserve diagnostics | [Plugin error handling](diagnostics.en.md) |
| Check Office Ray slots and the AgentX bridge protocol | [Runtime and concurrency validation](runtime-validation.en.md) |
| Find directory responsibilities, dependency rules, execution order, and resource ownership | [Source architecture and execution flow](architecture.en.md) |

Store intermediate designs and implementation records in `docs/design/` and `docs/tasks/` under the [documentation rules](../AGENTS.md). Keep fixture usage and controlled validation here; user guides describe current operations, results, and limitations.
