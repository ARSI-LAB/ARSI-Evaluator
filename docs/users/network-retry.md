# Network Operation Retries and Manual Recovery

> English | [中文](./network-retry.zh-CN.md)

`ember-evaluator retry` creates full new attempts for invalid tasks with explicit network failures in the original run. It preserves task set, sources, model, Solver, official limits, and scoring. Zeros, wrong answers, valid agent timeouts, and failures without network evidence are ineligible.

## Automatic Network Retries

Automatic recovery retries the network operation, not the whole attempt:

| Operation | Retry location |
| --- | --- |
| Model calls | SDK/adapter retries current request in the same session without replaying completed tools |
| APT downloads | APT retries failed downloads, up to three retries by default |
| Data file downloads | Downloader retries current file, retaining completed files |
| Metadata/registry requests | Retry request/response reads without re-preparing sources or downloading whole images |
| Docker pulls | Bounded retries reuse downloaded content |
| Artifact transfers | Retry requests under the original upload ID without solving/verifying/collecting again |

Unspecified framework operations default to three attempts including the first. Model calls use `services.<name>.retry.maxAttempts` or SDK settings. Already-retrying SDKs/downloaders receive no outer retry layer. Backoff respects cancellation and phase deadlines.

Exhaustion returns `NETWORK_FAILURE` with `retryable: false`, `action: finalize`, without automatic new attempts. Image builds retain `ENV_IMAGE_BUILD_FAILED`; whole `docker build`, install/compile scripts, and verifier scripts are not replayed. The framework cannot safely replay arbitrary scripts' or third-party plugins' internal networking.

`run.taskRetry` was removed. Remove it from old YAML; it no longer budgets source initialization/task reruns. Historical results read offline, while resume still requires configuration/version validation.

## Commands

```bash
ember-evaluator retry --run <run-id>
ember-evaluator retry --run <run-directory> --task-id terminal-bench/example --request-id network-fix-1 --reason "registry network restored"
```

`ember-evaluator` remains an alias for the same CLI. Repeat `--task-id` for multiple tasks. Without selection, all current network failures are considered. No eligible tasks returns normally without creating attempts.

Run creation saves ID/location under `~/.ember/runs/`; override with `EVALUATOR_RUN_INDEX_DIR`. The index contains no authentication. After moving results across machines, pass the result directory. Ray Jobs local indexes retain original gateway, configuration reference, and job ID; commands operate through that gateway, not downloaded copies.

During execution, commands submit control requests to the original coordinator while other tasks continue. Ended runs acquire the original write lock and open recovery under the same ID, selecting only current network failures rather than ordinary resume's unfinished set. Replaying `--request-id` does not duplicate attempts; tasks already preparing/running are not enqueued twice.

IPC directly notifies active processes: Windows named pipes, Unix sockets, and Ray Jobs gateways through shared Job directories. Idle processes do not poll/rewrite `retry-control.json`. Requests during source/environment preparation return `pending` until scheduling is ready; scheduling returns `accepted`/`rejected`.

Control files persist acceptance before queueing; failed persistence does not enqueue or cancel other tasks. `EPERM`, `EACCES`, and `EBUSY` receive up to seven file-operation attempts with approximately 1.12 seconds total backoff. Persistent errors preserve originals. IPC startup/final-record persistence failures warn while normal scheduling continues.

For unconfirmed requests, resend the original `requestId` from the error using `--request-id`. Disconnect may follow acceptance; new IDs lose deduplication. If the coordinator is exiting, wait and resend the same ID. Old control files remain readable, but recovery retains configuration/plugin/package digest checks. Upgrades cannot bypass them; old active processes do not gain IPC automatically.

Authentication is rebound from original service variable references. Restore those variables first. Configuration, model, plugin, or package changes reject recovery. Literal/CLI keys without variable references cannot be recovered from saved results and produce explicit errors. Credentials enter neither control mailboxes nor reports.

## Manual Recovery and Execution Location

Only explicit `retry` or `--resume` reruns tasks. Each accepted manual request creates at most one attempt per eligible idle task, with new directories/preparation records. Failure does not append automatic attempts. Repeated `requestId` is deduplicated.

Unconfirmed process exit/cleanup blocks retries to prevent overlap. Engine handles requests for Local/Ray; Ray handles placement, capacity, retirement confirmation, and upload receipts. Ray Jobs connects through the original authenticated gateway/queue or launches recovery with access to the original run directory, still writing that run.

## Eligible Failures

Manual retries require `NETWORK_FAILURE` plus phase, cause, and redacted evidence. Eligibility rechecks evidence, score, and cleanup; it does not trust remote `retryable` or automatically accept requests.

| Operation | Eligible evidence | Ineligible evidence |
| --- | --- | --- |
| Docker Pull | DNS, disconnects, transfer timeouts, temporary 5xx | Missing images, authentication, incompatible platforms |
| Runtime installation | Explicit download diagnostics outside image builds | Image build failure, dependency conflict, ordinary deadline |
| Model API | APIConnectionError, read timeout, temporary 5xx, recoverable throttling | Exhausted quota, refusal, invalid parameters, context/output limits, agent deadline |
| Data sources | Explicit GitHub/HF/HTTP connection/download failures | Version, format, digest, permanent authentication errors |
| Verifier | No reward and explicit dependency-download network failure | Official zero, verifier logic error, ordinary total verification timeout |

Image build download failures retain `ENV_IMAGE_BUILD_FAILED` and trigger neither automatic nor manual task retries. APT retries downloads inside its command; exhaustion fails the build without replaying the attempt.

Network errors inside model tools do not qualify a task that ultimately completes with a score. Unresolved collection/storage/cleanup errors also block reruns despite other network evidence.

## Latest Results and History

Each task uses one valid result, never the highest score. If an initial pull fails and recovery receives official zero, the latest report shows normal completion/zero and omits the old network error. Once all tasks have valid results and no unresolved cleanup/run faults remain, run status changes from `error` to completed.

- `tasks/.../attempts/` retains original failures, trajectories, logs, and new attempts.
- `manifest.json` retains initialization failures and preparation history.
- `retry` updates root reports and, after prior resume, the report referenced by `reports/current.json`, without a new directory.
- Explicit resume creates `reports/resume-N/`, preserving initial reports under `reports/initial/` and previous resume reports. Offline reporting detects/rebuilds report/metric digest mismatches from interrupted publication.

```bash
ember-evaluator report <run-directory>
```

Latest errors include current task results and unresolved run faults, excluding historical errors. `attempt-accounting` separately sums known tokens, execution time, and cost across attempts; failures retain received partial usage. `partialAttempts` and unknown-cost counts mark incomplete observation. Known costs are not complete server costs, and unknown values are not fabricated as zero.

Run ID is saved before initial data download. On download failure, task set remains undetermined and selected/valid/coverage are null until successful recovery locks sources/tasks.
