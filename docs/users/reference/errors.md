# Error Codes and Structured Diagnostics

> English | [中文](./errors.zh-CN.md)

Codes identify causes; `action` gives default handling. Independent result fields determine score validity. Error text/exit codes cannot replace them. Framework codes come only from the [registry](../../../src/core/errors/registry.ts), without legacy aliases/conversion tables.

## Inspect Errors

Ordinary commands show phase, task, standard code, domain, original cause, and guidance without extra log-format arguments. Example:

```text
[42.0s] [error] [verify] Task 2/50 task=example-task ERROR: VERIFY_TIMEOUT: verify exceeded its task-specific time limit [verifier/attempt]
[hint] Verification exceeded its budget. Preserve official verification deadlines; ordinary verification timeouts are not retried.
```

Full diagnostics automatically save in attempt result.json. Preparation diagnostics also appear in manifest preparationRounds[].failure/tasks[].failure. `report.md` summarizes codes/actions/cleanup. `EVALUATOR_DEBUG=1` enables additional details.

`details` permits component, operation, original code/exception, HTTP status, exit/signal, `retryAfterMs`, network phase/cause/redacted evidence, excluding requests/arbitrary headers/environment. Cause chains have bounded depth/count/length and redaction. Plugins must also keep keys/tokens out of raw logs.

## Handling and Scoring

| Field | Meaning |
| --- | --- |
| `executionStatus` | `completed`, `agent_timeout`, `failed`, `cancelled`: execution outcome |
| `scoreStatus` | quality valid/invalid or performance `not-applicable`, independent of cleanup |
| `cleanupStatus` | `cleaned` means no `unconfirmed` resources found; `unconfirmed` means release is uncertain |
| `evaluationKind` | Required: `quality` or `performance` |

New attempts omit status/timeoutKind; CLI/report labels derive from these fields. Legacy results convert at local read boundaries without rewriting files. New submissions/remote uploads reject old fields.

- **Agent timeout**: valid zero in the denominator, no retry, replenish after cleanup. Without verifier, `verdict` remains null; timeout policy supplies zero.
- **System failure**: invalid without a reliable legal score, excluded from scoring denominator. Recoverable networking retries only failed operations; exhaustion records `NETWORK_FAILURE` without new attempts. Explicit Retry-After may extend operation backoff.
- **Preparation failure**: pulls/non-build installs recover only safe network operations. Build failures do not rerun tasks; APT retries within commands. Platforms, permissions, compilation, and ordinary deadlines are ineligible. `run.onError` controls ordinary failures; agents do not execute before batch barriers pass.
- **Global authentication/quota/storage/protocol failures**: stop the run even with continue.
- **Unconfirmed cleanup**: stop dispatch without replacement/overlap. Valid benchmark verdicts survive; pure collection failures retain scores and mark evidence incomplete. Failures without verdicts never fabricate valid zeros.
- **Resume**: first recover unfinished/unconfirmed environments, then unfinished/invalid tasks. Skip valid scores/agent timeouts. Original cleanup diagnostics remain; a run with all tasks valid but old cleanup diagnostics may still show error after recovery, without solving again.

Reported errors have exhausted operation retries and `retryable`:false. Manual recovery separately checks network evidence/scores/cleanup rather than automatically dispatching from that field. `abort_run` and `stop_dispatch` both halt dispatch/cancel active tasks; the latter requires node/resource repair, without background cleanup or reassignment.

CLI exits:`0` completed including wrong answers/valid agent timeouts;`1` runtime/system failure;`2` configuration/arguments;`130` cancellation. One retained valid score does not guarantee run exit 0.

## Error Codes

| Code | Scenario | Default handling |
| --- | --- | --- |
| `NETWORK_FAILURE` | Bounded request/download retries exhausted | Finalize; no automatic rerun; explicit recovery possible |
| `CONFIG_INVALID` | Invalid configuration/arguments/component initialization | Abort run |
| `SOURCE_CHANGED` | Source/selection/plugin/solver version differs from lock | Abort run |
| `DATA_FETCH_FAILED` | Data access failure after downloader retries | Abort run |
| `TASK_DATA_INVALID` | Invalid task metadata/public files | Invalid, no retry |
| `BENCHMARK_UNSUPPORTED` | Unsupported capability/protocol | Unsupported, no retry |
| `ENV_IMAGE_PULL_FAILED` / `ENV_IMAGE_PULL_TIMEOUT` | Pull failure/timeout | Invalid, no retry |
| `ENV_IMAGE_REFERENCE_INVALID` | Invalid image reference/identity | Invalid, no retry |
| `ENV_CAPABILITY_UNSUPPORTED` | Unsupported environment operation | Invalid, no retry |
| `ENV_SESSION_CLOSED` | Closed environment session | Stop using it; clean up |
| `ENV_IMAGE_BUILD_FAILED` / `ENV_IMAGE_BUILD_TIMEOUT` | Build failure/timeout | Invalid, no retry |
| `ENV_ARCH_UNSUPPORTED` | Incompatible platform/architecture/executable | Invalid; no automatic platform switch |
| `ENV_DOCKER_DAEMON_UNAVAILABLE` | Docker unavailable | Stop dispatch |
| `ENV_RESOURCE_EXHAUSTED` | Explicit disk/memory/PID exhaustion | Stop dispatch |
| `ENV_RESOURCE_REQUIREMENTS_UNMET` | CPU/memory exceeds node capacity | Invalid; do not lower requirements |
| `ENV_CONTAINER_START_FAILED` | Create/start failure | Invalid, no retry |
| `ENV_RUNTIME_ASSET_MISSING` | Missing framework runtime files | Repair packaging/rebuild images |
| `ENV_SERVICE_HEALTHCHECK_FAILED` | Failed healthcheck | Invalid; do not bypass |
| `ENV_CONTAINER_EXITED` / `ENV_CONTAINER_OOM` | Early service exit/confirmed Docker OOM | Invalid; inspect logs/limits |
| `ENV_RUNTIME_INSTALL_FAILED` | Agent runtime unready/install failed | Invalid, no retry |
| `ENV_CPU_BUDGET_FAILED` | Cannot apply CPU budget | Invalid, no retry |
| `ENV_PREPARED_IMAGE_LOST` | Receipt image missing/changed | Stop dispatch |
| `ENV_PREPARATION_FAILED` / `ENV_PREPARATION_TIMEOUT` | Other preparation failure/timeout | Invalid, no retry |
| `SOLVER_AGENT_TIMEOUT` | Agent budget exhausted | Valid zero, no retry |
| `SOLVER_PROCESS_CRASHED` | Abnormal agent exit | Invalid, no retry;137 alone does not prove OOM |
| `SOLVER_PROTOCOL_INVALID` | Invalid events/status/output | Invalid, no retry |
| `SOLVER_RESULT_INCOMPLETE` | Agent turn incomplete | Invalid; only explicit network evidence qualifies recovery |
| `SOLVER_OUTPUT_LIMIT` | Token-truncated output | Invalid, no recovery; retain harness truncation error |
| `MODEL_RATE_LIMIT` | HTTP 429/throttling | NETWORK_FAILURE only when explicitly recoverable; no recovery without evidence |
| `MODEL_AUTH_FAILED` | Model401/403 | Abort run |
| `MODEL_QUOTA_EXHAUSTED` | Exhausted quota | Abort run |
| `MODEL_UPSTREAM_TIMEOUT` | Request/stream timeout | NETWORK_FAILURE for explicit transport timeout; ordinary budgets ineligible |
| `MODEL_UNAVAILABLE` | Connection/5xx | NETWORK_FAILURE for explicit transient networking; no recovery without evidence |
| `MODEL_CONTEXT_LIMIT` | Context overflow | Invalid, no retry |
| `MODEL_REQUEST_INVALID` | Invalid model parameters/protocol | Invalid, no retry |
| `TRANSFER_TIMEOUT` / `TRANSFER_FAILED` | Workspace transfer timeout/failure | No automatic rerun; inspect transfer/cleanup |
| `TRANSFER_AUTH_FAILED` | Transfer authentication | Abort run |
| `TRANSFER_PROTOCOL_INVALID` | Invalid message/receipt/identity | Abort run |
| `TRANSFER_CONFLICT` | Transfer ID differs in content/already finished | Reject without overwriting artifacts |
| `TRANSFER_NOT_FOUND` | Missing transfer record | Create upload first |
| `TRANSFER_CHECKSUM_MISMATCH` | Workspace/patch digest mismatch | Reject corruption, not network recovery |
| `TRANSFER_UNSAFE` | Unsafe archive/restore path | Invalid, no retry |
| `VERIFY_TIMEOUT` | Official verifier deadline | No recovery without explicit networking |
| `VERIFY_EXEC_FAILED` | Failed verification/missing score file | Invalid, no retry |
| `VERIFY_RESULT_INVALID` | Malformed score | Invalid; never fabricate zero |
| `ARTIFACT_COLLECTION_INCOMPLETE` | Missing sessions/trajectories/artifacts | Retain valid scores and incomplete-evidence explanation |
| `RAY_WORKER_LOST` | Lost Ray node/process | Confirm exit/cleanup; loss alone is not network evidence |
| `RAY_HEARTBEAT_TIMEOUT` | Heartbeat/coordinated budget timeout | Confirm exit; stop dispatch if uncertain; timeout alone ineligible |
| `RAY_RESULT_UNCOLLECTED` | Execution returned without accepted receipt | Check results/node evidence; explicit networking required for recovery |
| `RAY_PROTOCOL_INVALID` | Protocol/receipt mismatch | Abort run |
| `SCHEDULER_UNAVAILABLE` | Scheduler initialization/communication failure | Abort run |
| `STORE_WRITE_FAILED` | Unreliable persistence | Abort run |
| `STORE_RECORD_INVALID` | Invalid/incomplete records/manifests/trajectories | Reject corruption; abort |
| `STORE_LOCKED` | Other owner/changed lock ownership | Abort; confirm original process |
| `STORE_CONFLICT` | Different existing content for result ID | Preserve result; abort |
| `STORE_STATE_INVALID` | Store unopened/used by another run | Abort; inspect lifecycle |
| `STORE_SNAPSHOT_CHANGED` | Report snapshot changed | Rebuild from current results |
| `REPORT_FAILED` | Report generation failed | Preserve results; fix/rebuild offline |
| `CLEANUP_TIMEOUT` / `CLEANUP_FAILED` | Release timeout/failure | Retain valid scores; stop dispatch |
| `RUN_CANCELLED` | User/controller cancellation | Preserve partial results; stop |
| `INTERNAL_ERROR` | Unclassified exception | Invalid; avoid blind retries |

Model HTTP classification applies only at model/solver boundaries. Registry403 is not model authentication. Unknown external codes/causes remain; no unsupported OOM/network/model conclusions are invented.

See [plugin error handling](../../development/diagnostics.en.md) for structured exceptions.

[User documentation](../README.md) · [Quick start](../quick-start.md)
