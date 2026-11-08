# Runtime and Concurrency Validation

> English | [中文](./runtime-validation.md)

For developers modifying Evaluator. Record controlled tests separately from manual capacity tests; fixtures are not ordinary user defaults. Run commands from the repository root.

[Development documentation](README.en.md) · [User concurrency guide](../users/concurrency.md)

## SimpleAgent Controlled Integration Tests

After building, run:

```bash
pnpm test --run tests/integration/simpleagent.test.ts --maxWorkers=1
```

Suite setup installs packaged Pi and dependencies using the runtime lock. Cases reuse content-addressed local caches and run the runner in real subprocesses. Initial setup requires npm cache or download access and has a separate installation budget. For source on Windows-mounted WSL paths, runtime dependencies still load from host cache.

Model requests go to a test-local mock service. Cases cover output truncation, context compaction, missing usage, cancellation, trajectory write failure, and extension loading. Existing execution/cancellation timeouts and behavioral assertions remain enforced; setup installation time is not model processing time. These tests do not use the high-level SDK. See [sdk.test.ts](../../tests/integration/sdk.test.ts) for SDK regression coverage.

Pi readiness resolves dependencies through ESM, supports package-local and parent `node_modules`, and checks pinned versions. See [pi-runtime-probe.test.ts](../../tests/integration/pi-runtime-probe.test.ts) for nested, hoisted, and mismatched versions.

## Manual Office Ray Multi-Slot Checks

The regular [Office Ray Playbook](../../playbook/workbuddy/workbuddy-office-ray.yaml) retains main-repository defaults: concurrency 2, four tasks, and 4500 seconds per task. Default Ray Compose provides one slot per worker across two workers. The separate [test YAML](../../tests/fixtures/workbuddy-office-ray-20/experiment.yaml) uses 20 tasks, concurrency 20, build budget multiplier 20, and 9000 seconds per task. Configuration unit tests load this fixture without starting a real evaluation.

For manual concurrency-20 execution, set `MODEL_NAME`, `MODEL_ENDPOINT`, and `MODEL_API_KEY`, then run from the repository root:

```bash
ember-evaluator run tests/fixtures/workbuddy-office-ray-20/experiment.yaml --dry-run
pnpm ray:ensure
docker compose -f scripts/ray-smoke/compose.yaml -f scripts/ray-smoke/jobs.yaml -f tests/fixtures/workbuddy-office-ray-20/compose.yaml up -d --no-deps --no-build worker-a worker-b
ember-evaluator run tests/fixtures/workbuddy-office-ray-20/experiment.yaml
```

The [slot override](../../tests/fixtures/workbuddy-office-ray-20/compose.yaml) sets each worker to 10 slots. Test YAML uses `managedLocal: false` to reuse the explicitly prepared cluster rather than resetting slots through runtime setup. Wait for existing evaluations before changing workers. Restore defaults by omitting the override after testing:

```bash
docker compose -f scripts/ray-smoke/compose.yaml -f scripts/ray-smoke/jobs.yaml up -d --no-deps --no-build worker-a worker-b
```

## AgentX Bridge and Metrics Checks

Set `AGENTX_TEST_PYTHON` to an isolated Python with the harness/bridge installed, then run `pnpm test --run tests/integration/agentx-bridge.test.ts`. This uses controlled SSE/Prometheus services and covers counter resets. Default `agentx-telemetry.test.ts` tests configuration, reports, device queries, stale snapshots, and exit behavior without NPUs.

## Recording Validation Results

Formal experiments belong in `docs/experiments/`; temporary logs/probes go in `.scratch/`, outside user guides.
