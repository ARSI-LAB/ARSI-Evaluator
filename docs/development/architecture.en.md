# Source Architecture and Execution Flow

> English | [中文](./architecture.md)

This guide describes current module responsibilities, calls, and resource ownership. Update it with the implementation. See [AGENTS.md](../../AGENTS.md) for repository rules, [plugin development](plugins.en.md) for component contracts and loading, and [Benchmark development](benchmarks.en.md) for adding workloads.

## Directory Responsibilities

Declarative workflows enter through application/workflow.ts and compile/execute under core/workflow. Templates, steps and resources are registered with Cordis. Plans pin implementations and block-output protocols; LocalWorkflowStore saves run.json and immutable artifacts. Independent units retain case/variant/repetition identities and input digests. Resume recovers resources, validates sources and reuses completed units. results.rescore grades saved public text outputs in a new run.

Native Benchmark orchestration now resides under plugins/workflows/benchmark. Its declarative entry supports local execution, direct Ray, and Ray Jobs. Preparation and sample execution share ray.connection; credentials are fetched over authenticated HTTPS, and Jobs resume transfers complete evidence with digest verification. CLI and SDK now use the workflow entry; the previous Engine, bootstrap, and configuration loading entry points have been removed. See [workflow plugin development](workflow-plugins.md).

The application adds network templates as `network.runtime` resources through `workflow-network.ts`. Models and Benchmarks borrow clients; the network resource creates and closes them. Plans retain unresolved templates, and execution nodes resolve proxy, source and credential values. Warmup opens only dependencies explicitly marked safe without evaluation state; recovery creates temporary clients from saved templates.

| Location | Behavior and entry points |
| --- | --- |
| [src/index.ts](../../src/index.ts) | Explicit public API and type exports; internal modules import their implementations directly |
| [src/cli.ts](../../src/cli.ts), [cli/](../../src/cli) | Process signals, command definitions and dispatch, terminal progress, and exit codes |
| [application/](../../src/application) | Run, report, warmup, retry, and diagnostic operations; component creation and disposal; local execution or Ray Jobs deployment |
| [config/](../../src/config) | YAML loading, environment and Profile expansion, validation, and redaction; no Cordis Context or runtime component creation |
| [core/](../../src/core) | Workflow contracts, compilation, resource scopes, execution, recovery, and result validation; remaining Benchmark contracts and helpers |
| [plugins/](../../src/plugins) | Steps, resources, templates, workflow storage, and Benchmark-specific components |
| [runtimes/](../../src/runtimes) | Installation recipes, bridges, protocols, and assets for specific programs such as Pi, DSH, AgentBundle, and AgentX |
| [infrastructure/](../../src/infrastructure) | Process, shell, container, network, download, installation lock, IPC, transfer, and provenance I/O |

Within core, `contracts/` defines interfaces, `workflow/` compiles and executes declarative flows, `execution/` retains Benchmark queue helpers, `preparation/` prepares tasks, `recovery/` handles resume and retry eligibility, `selection/` selects tasks, `results/` owns result/source rules, and `artifacts/` handles file manifests and trajectories. See the [repository directory tree](../../AGENTS.md#仓库目录结构).

Config reads and parses configuration without loading plugin modules. [plugin-patch.ts](../../src/config/plugin-patch.ts) reads and validates patches and computes their digests; [load-module.ts](../../src/application/plugins/load-module.ts) resolves modules relative to the patch directory, reads package versions or hashes local files, and performs dynamic imports. Configuration file reads still involve I/O, so config is not entirely pure. Core also performs file I/O and invokes component I/O through contracts; its boundary excludes application assembly and concrete component dependencies. Infrastructure can use Evaluator contracts but does not decide scores, retry eligibility, or scheduling policy.

Resource providers declare maintenance operations. `workflow-maintenance.ts` opens only the non-evaluation dependencies listed by the operation. The Benchmark plugin invokes its diagnostics and image cleanup; shared network probes live in infrastructure/network and Ray network probes in infrastructure/ray. Jobs forwards the same maintenance request and returns separate results. Benchmark templates collect bundle names into deployment.bundles; deployment code validates directories and creates read-only named mounts.

## Allowed Source Dependencies

This table covers repository source dependencies, not Node built-ins or third-party packages.

| Importing layer | Allowed directories |
| --- | --- |
| core | core |
| config | config, core |
| infrastructure | infrastructure, core, allowlisted config modules |
| runtimes | runtimes, infrastructure, core, allowlisted config modules |
| plugins | plugins, runtimes, infrastructure, core, allowlisted config modules |
| application | application, config, core, plugins, runtimes, infrastructure |
| cli | cli, application, core |

`src/index.ts` and `src/cli.ts` are public export/process entries exempt from the directory table. Other internal modules cannot import the package root or self-import `arsi-evaluator` to bypass the rules. Config, infrastructure, and runtimes also cannot import `core/execution/`.

Run `pnpm check:dependencies`. Rules and the config allowlist live in [check-dependencies.mjs](../../scripts/check-dependencies.mjs); [dependency-baseline.json](../../scripts/dependency-baseline.json) must remain empty. Adding a config file does not automatically permit other layers to import it.

The checker covers static/type imports, re-exports, string-literal dynamic imports, resolvable require calls, missing relative modules, and executable import cycles. Type-only edges obey directory rules but do not form initialization cycles. Additional review is required because:

- Cross-role imports within plugins are allowed; the checker cannot establish whether they serve a valid purpose.
- The config allowlist does not prove freedom from side effects.
- Computed module addresses, code under `assets/`, Python dependencies, and resource URLs are not fully covered.
- Asset copying, process startup, cancellation, and cleanup require build, integration, and distribution checks; zero dependency violations do not establish those behaviors.

## Execution and Resource Ownership

CLI `run` and SDK `Evaluator.run()` call [application/workflow.ts](../../src/application/workflow.ts).

1. `openPluginRegistry` creates the Cordis context and loads built-in, bundled, and explicitly patched plugins. The operation reuses this registry.
2. `readWorkflowConfiguration` expands template parameters into steps and resources, binds network dependencies, and calls `compileWorkflow`. Templates determine ordering; the kernel has no Benchmark-name branches.
3. [workflow-execution.ts](../../src/application/workflow-execution.ts) locks the run directory, opens the workflow store and retry control, and invokes the kernel. Jobs deployments submit the plan through the application layer; workers never read submitting-host paths.
4. [execute.ts](../../src/core/workflow/execute.ts) executes ordered steps and bounded concurrent `forEach` units. Resources are accessed through declared ports and scoped to run, worker, attempt, or step. Outputs must satisfy their declared protocols.
5. After completion, failure, or cancellation, the application rebuilds the offline report and closes the registry and write lock. Application errors retain persisted partial results.

Persistence, cancellation, cleanup, protocol validation, redaction, and recovery records are kernel services that users cannot remove. Data loading, application calls, memory operations, rendering, scoring, and business reports are replaceable steps. Removing a producer of required downstream data requires updating those bindings; otherwise compilation fails.

The Benchmark template keeps selection, preparation, native components, and its Store in `benchmark.runtime`. Attempt resources own public tasks, private verifier material, and environments. Solvers receive public tasks only. Existing components register through `registerNativeResource`; their Cordis effects are released after successful work or factory failure.

The workflow directory contains `plan.json`, `run.json`, artifacts, and `report.md`. Native Benchmark evidence lives under `benchmark-evidence/<run-id>`; model variants and repetitions have separate `benchmark-groups` directories. A native manifest is not the workflow completion record.

[workflow-report.ts](../../src/application/workflow-report.ts) loads saved report steps and their declared rendering dependencies, validates source/version identity, and reads saved evidence. It creates no model or evaluation resources. Benchmark reports retain Metrics/Reporter behavior; workflows without a reporting step receive a generic summary.

## Retry, Ray, and Docker

[application/retry-control/mailbox.ts](../../src/application/retry-control/mailbox.ts) handles request files, locks, transactions, and IPC. The kernel reserves units and persists bindings before committing queue admission. Repeated requests do not dispatch duplicates; shutdown stops admissions and waits for in-flight transactions.

A resource plugin decides automatic retry eligibility; the kernel bounds attempts and requires confirmed cleanup. Benchmark preparation runs again before retry dispatch, refreshing receipts and placement. Dispatch parameters are revalidated while the business-input fingerprint remains stable. Admission failure signals stop dispatch and cancel the execution block.

Resume first recovers resources, then validates business inputs and sources, then reuses completed units. If native scoring committed before workflow outputs were saved, `admission.reconcile` validates the original attempt and artifacts before restoring outputs. Recovery uses the saved network template with current runtime environment variables and credentials; it does not reload a modified local network YAML.

Scheduler handles Benchmark preparation, capacity, and maintenance. `executor.ray` dispatches execution blocks to the workflow worker. Preparation and execution share `ray.connection`; workers verify retained preparation receipts and complete dispatch parameters.

| Operation | Implementation |
| --- | --- |
| Submit/follow Ray Jobs and download remote results | `application/ray/`, using `infrastructure/ray/` clients |
| Dispatch attempts to Ray nodes | `plugins/resources/ray-executor.ts`, using ray.connection and the Python driver |
| Load node plugins and execute tasks | `application/ray/workflow-worker.ts`; node-worker.ts handles Benchmark preparation and maintenance only |
| Prepare Docker images, runtimes, and sessions | `plugins/environments/docker/environment.ts` |
| Execute, transfer, switch phases, and close a session | `plugins/environments/docker/session.ts` |
| Shared Docker commands, image operations, and build tools | `infrastructure/containers/` |

Ray Jobs deployment and workflow sample dispatch operate at different levels. Jobs entries call application operations directly rather than going through CLI argument parsing. Docker preparation still contains several image strategies; they are not each implemented as separate modules.

Docker's `materialize()` and on-demand `prepare()` share `prepareDependencies()` to resolve images and runtimes for the main container, gateway, and Compose services. With a receipt, `prepare()` checks the local images before passing the resolved images to `startSession()`. Main and gateway containers start with `--pull never`. Compose also uses `--no-build`. On startup failure, the startup code cleans up containers, the Compose project, and the gateway before the image lease is released. On success, `DockerSession.dispose()` owns that cleanup and lease release.

Docker reads the build directory's files and permissions to compute the image cache key. On a cache miss, `taskImage()` copies the directory to a snapshot and verifies its contents and permissions before building. AgentX uses the packaged bridge directory, which includes the shared `reasoning_effort.py` module.

When `taskImage()` builds a local task snapshot, it starts a [package relay](../../src/infrastructure/containers/build-package-relay.ts) and supplies build arguments for recognized public PyPI or npm mirrors. The relay retries and falls back by request. `taskImage()` closes it on completion or cancellation. A cached or downloaded image skips this step.

## Benchmarks and Plugin Registration

Benchmarks use `agent-harness/`, `inference-engine/`, and `operator/`, each with its own Profiles and registration `index.ts`. These categories add no YAML category field and no category branches to core execution. See [where to add behavior](benchmarks.en.md#where-to-add-new-behavior).

[plugins/index.ts](../../src/plugins/index.ts) composes registration entries. Benchmark, Solver, Environment, Verifier, Store, and Scheduler have their own entries; Metrics and Reporter use [metrics/index.ts](../../src/plugins/metrics/index.ts) and [reporters/index.ts](../../src/plugins/reporters/index.ts) respectively. External plugins use explicit `--patch` loading; omitting it does not scan a default directory. See [plugin development](plugins.en.md).

A feature can span roles. AgentX input/evidence lives in `plugins/benchmarks/inference-engine/agentx/`, execution calls in `plugins/solvers/agentx-replay.ts`, installation/bridging in `runtimes/agentx/`, and metrics/reporting in their respective roles. `evidence/` parses saved results directly without importing registration entries, installers, or samplers; shared versions come from the I/O-free `runtimes/agentx/versions.ts`.

At build time, [build-plugins.mjs](../../scripts/build-plugins.mjs) scans `plugins/*/arsi-evaluator-plugin.json` at the repository root, installs the build output and patches under `dist/plugins/<id>/`, and writes the default plugin list to `dist/bundled-plugins.patch.yaml`. The registry loads that list at runtime. The host defines CLI commands.

## Build, Distribution, and Maintenance

After TypeScript compilation, [package-runtime.mjs](../../scripts/package-runtime.mjs) copies Profiles, Python, runtime assets, and licenses, then generates process entries and integrity manifests. Source has no `adapters/`; a few legacy paths in the package are generated for existing deployments. See [published process entries](plugins.en.md#published-process-entries) for supported paths and installed-package checks.

Pi packaging rewrites only the runner's dependency copies. Preparation modules retain their canonical dependencies and resource locations. The compatibility directory contains standalone dependencies and its own manifest. The packaging script explicitly copies built-in Benchmark Profiles and assets. Compatibility files and repository plugin output are in place before the package digest is calculated.

For cross-module changes, run dependency checks, type checks, and relevant tests. Build/runtime asset changes also require a build and actual installed-package validation. See [plugin development](plugins.en.md), [runtime validation](runtime-validation.en.md), and [repository development rules](../../AGENTS.md#开发流程) for component and real-environment checks.

Update both language versions when responsibilities, calls, or ownership change. Component details belong in plugin/Benchmark guides; user operations belong in user guides. Dated design/task records retain decisions and validation evidence, but must not be the only architecture reference.

## Multimodal input

Benchmarks declare public attachments and stage their locked files through the environment. Core checks attachment declarations and Solver capabilities. Runtime adapters read environment-local files, verify digests, render explicit PDF pages, and construct Harness messages. See [multimodal development](multimodal.md).
