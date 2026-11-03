# Plugin Error Handling

> English | [中文](./diagnostics.md)

[Development documentation](README.en.md) · [Error code reference](../users/reference/errors.md)

## Integrating Plugins

New plugins should throw explicit error types rather than rely on string diagnostics:

```typescript
import { EvaluatorError } from "ember-evaluator";

throw new EvaluatorError(
  "VERIFY_RESULT_INVALID",
  "Verifier reward must be a finite number",
  { component: "custom-benchmark", operation: "read-reward" },
  { cause: originalError },
);
```

The package root exports `ErrorCode`, `ERROR_CODES`, `EvaluatorError`, `classifyError`, `normalizeFailure`, and `failureDecision`. Policies are recomputed from the registry, ignoring plugin-supplied retryable/action. `Failure` requires the full version 1 structure; validation rejects short forms, unregistered codes, inconsistent policies, unknown metadata, and arbitrary authentication fields. Local storage converts legacy three-field errors on read; that converter is not for new submissions or remote messages. `Warning` is a separate nonfatal three-field diagnostic with registered codes. Historical results are not rescored.

Framework exceptions and Solver warning `code` fields accept only `ErrorCode`. For errors requiring distinct handling, declare them in `ERROR_CODES` before updating throw sites and consumers. Avoid private framework codes or alias conversion tables. Harbor and other plugins directly use standard codes such as `TASK_DATA_INVALID` and `BENCHMARK_UNSUPPORTED`.

Keep OS errno, external SDK exception names, HTTP statuses, and process exit codes in `cause` or `details`; adapters classify them in operation context. Do not send SDK exception names as Pi/Ray protocol `code`. Owned protocols reject unregistered codes; old framework codes are no longer converted, so new plugins cannot depend on them for policy. Reading historical results does not rewrite records.
