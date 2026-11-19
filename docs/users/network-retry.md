# Network Operation Retries and Manual Recovery

> English | [中文](./network-retry.zh-CN.md)

`arsi-evaluator retry` creates new attempts for failed or interrupted workflow samples without changing cases, sources, models, steps, or scoring. Valid scores, including valid zeros, are reused. Network recovery is a common use, not the only eligible failure category.

## Automatic Network Retries

Network operations have their own request-level retries:

| Operation | Retry location |
| --- | --- |
| Model calls | SDK/adapter retries current request in the same session without replaying completed tools |
| APT downloads | APT retries failed downloads, up to three retries by default |
| Data file downloads | Downloader retries current file, retaining completed files |
| Metadata/registry requests | Retry request/response reads without re-preparing sources or downloading whole images |
| Docker pulls | Bounded retries reuse downloaded content |
| Artifact transfers | Retry requests under the original upload ID without solving/verifying/collecting again |

Framework network operations default to three attempts including the first. Model retry support and configuration depend on the Harness; `services.<name>.retry.maxAttempts` only affects adapters that consume it. Cancellation or the current phase deadline stops further request-level retries.

Evaluator also provides whole-task recovery for explicit model response truncation. When a Harness reports a solve failure containing evidence such as `Response payload is not completed`, insufficient transfer length, or `incomplete chunked read`, Evaluator saves the failed attempt, confirms cleanup, and creates a new attempt. Each task permits at most two automatic reruns. Resume counts saved truncation failures toward this budget instead of resetting it. After exhaustion, `run.onError` controls whether other tasks continue; the failed task remains unscored.

Each new attempt starts with a fresh workspace and a full task deadline. Earlier model requests and tools run again, adding time and cost; external tool side effects are not undone. Normal model output remains streamed without buffering the entire SSE response or patching the Harness. This fallback cannot detect truncation that the Harness swallows as success or reports without specific truncation evidence.

A bare `APIConnectionError`, ordinary SSE error, HTTP 400, authentication or quota failure, valid zero, cancellation, or collection/cleanup failure does not trigger this automatic recovery. Model request timeouts are also outside this rule. Image builds use `ENV_IMAGE_BUILD_FAILED` and do not automatically rerun the task. Third-party plugins and task scripts control their own retries.

Remove `run.taskRetry` from old YAML. Configure model request limits as above and recover failed tasks manually with the commands below. See [resume requirements](usage.md#resume-and-rebuild-reports).

## Commands

```bash
arsi-evaluator retry --run <run-id>
arsi-evaluator retry --run <run-directory> --task-id failed-case --request-id network-fix-1 --reason "network restored"
```

Repeat `--task-id` to select failed or interrupted workflow samples; omission selects all. Valid completed samples are reused. Requests to active runs go to the existing coordinator. Ended runs reopen the saved workflow. Repeating a request ID does not dispatch duplicate work.

Retry keeps the saved network template and rejects `--network` replacement. Repair referenced variables or node connectivity, for example HF_ENDPOINT, then retry. Active processes retain their already-open clients. Supply current credential variables; saved files contain names, not values. Changed plans or implementations require a new run.

## Manual Recovery and Execution Location

Each manual request adds one attempt per eligible task. If that attempt reports explicit model truncation and the task still has automatic recovery budget, the fallback above also applies. Resending the same `requestId` does not create duplicates; tasks already preparing or running are not queued again.

Recovery is blocked while a task is still running or resource release is unconfirmed, to prevent overlapping execution. Local and Ray support recovery; Ray Jobs still operates through the original gateway and writes new results into the original run.

## Eligible Failures

Manual retry selects failed or interrupted workflow samples and validates plans, business inputs, and resource cleanup. The following table describes repairable Benchmark network failures; it does not restrict manual retry to NETWORK_FAILURE. Low valid scores do not trigger reruns.

| Operation | Often fixed by restoring connectivity | Requires checking configuration or business behavior |
| --- | --- | --- |
| Docker Pull | DNS, disconnects, transfer timeouts, temporary 5xx | Missing images, authentication, incompatible platforms |
| Runtime installation | Explicit download diagnostics outside image builds | Image build failure, dependency conflict, ordinary deadline |
| Model API | APIConnectionError, read timeout, temporary 5xx, recoverable throttling | Exhausted quota, refusal, invalid parameters, context/output limits, agent deadline |
| Data sources | Explicit GitHub/HF/HTTP connection/download failures | Version, format, digest, permanent authentication errors |
| Verifier | No reward and explicit dependency-download network failure | Official zero, verifier logic error, ordinary total verification timeout |

Image build download failures retain `ENV_IMAGE_BUILD_FAILED` and do not trigger automatic whole-task retries. After fixing the cause, retry failed samples manually. APT retries downloads inside its command; exhaustion fails the build without replaying the attempt.

Network errors inside model tools do not qualify a task that ultimately completes with a score. Unresolved collection/storage/cleanup errors also block reruns despite other network evidence.

## Latest Results and History

Each task uses one valid result, never the highest score. If an initial pull fails and recovery receives official zero, the latest report shows normal completion/zero and omits the old network error. Once all tasks have valid results and no unresolved cleanup/run faults remain, workflow status changes from `failed` to `completed`.

- `benchmark-evidence/<run-id>/tasks/.../attempts/` retains original failures, trajectories, logs, and new attempts.
- `benchmark-evidence/<run-id>/manifest.json` retains Benchmark initialization failures and preparation history; root `run.json` records workflow state.
- `retry` updates root reports and, after prior resume, the report referenced by `reports/current.json`, without a new directory.
- Explicit resume creates `reports/resume-N/`, preserving initial reports under `reports/initial/` and previous resume reports. If report generation was interrupted, rebuild it with the command below.

```bash
arsi-evaluator report <run-directory>
```

The latest report counts current results and unresolved run failures. Historical failures remain in attempt directories. `attempt-accounting` totals known tokens, time, and cost across attempts; missing usage is marked separately, so known costs are not a complete bill.

A Run ID is retained even when the first data download fails. Task counts remain undetermined until recovery succeeds and the actual task set is available.
