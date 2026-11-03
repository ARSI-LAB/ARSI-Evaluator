import { PhaseTimeoutError } from "../../src/core/phase-timeout.js";
import { expect, test } from "vitest";
import { isManualRetryEligible } from "../../src/core/manual-retry.js";
import { classifyError } from "../../src/core/errors/classify.js";
import { TaskQueue } from "../../src/core/task-queue.js";
import { storeRecord } from "../fixtures/results/store-fixture.js";
const job = { runId: "run-1", taskId: "a", attemptId: "first", ref: { id: "a", recordKey: "a" }, configFingerprint: "config" };
const failure = (error: unknown, context: Parameters<typeof classifyError>[1] = { phase: "solve" }) => ({
  ...storeRecord(job), executionStatus: "failed" as const, scoreStatus: "invalid" as const, solve: null, verdict: null, errors: [classifyError(error, context)],
});
test.each(["APIConnectionError", "APITimeoutError", "TransferEncodingError: 400", "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EAI_AGAIN", "ServerDisconnectedError", "socket hang up", "pi-ai stream idle timeout after 300000ms", "HTTP 503", "HTTP 429"])("recognizes explicit failed model transport: %s", message => {
  expect(isManualRetryEligible(failure(new Error(message)))).toBe(true);
});
test.each(["HTTP 400", "HTTP 403 forbidden", "insufficient_quota", "CONTEXT_WINDOW_EXCEEDED", "SOLVER_OUTPUT_LIMIT", "unknown failure", "process CLI execution timed out"])("rejects non-network outcomes: %s", message => {
  expect(isManualRetryEligible(failure(new Error(message)))).toBe(false);
});
test.each(["prepare", "environment", "install", "verify"] as const)("phase deadline is not a transfer timeout: %s", phase => {
  expect(isManualRetryEligible(failure(new PhaseTimeoutError(phase, "ECONNRESET after phase deadline"), { phase }))).toBe(false);
});
test("build downloads, compilation and echoed recipes never retry the task", () => {
  const context = { phase: "environment" as const, operation: "build" };
  expect(isManualRetryEligible(failure(new Error("pip: ReadTimeout"), context))).toBe(false);
  for (const message of ["make exceeded its time limit", "#7 RUN echo ReadTimeout", "17 | RUN echo ReadTimeout", 'failed to solve: process "ReadTimeout" did not complete successfully'])
    expect(isManualRetryEligible(failure(new Error(message), context))).toBe(false);
});
test("valid zero, forged retryable flag, mixed failure and unconfirmed cleanup never retry", () => {
  const record = failure(new Error("ECONNRESET"));
  expect(isManualRetryEligible({ ...record, verdict: { score: 0, passed: false, details: {} }, scoreStatus: "valid" })).toBe(false);
  expect(isManualRetryEligible({ ...record, errors: [{ ...classifyError(new Error("unknown"), { phase: "solve" }), code: "NETWORK_FAILURE", retryable: true }] })).toBe(false);
  for (const phase of ["cleanup", "collect", "store"] as const)
    expect(isManualRetryEligible({ ...record, errors: [...record.errors, classifyError(new Error("failed"), { phase })] })).toBe(false);
});
test("terminal failures release slots without automatically creating another attempt", async () => {
  const coordinator = new TaskQueue();
  coordinator.add(job); coordinator.add({ ...job, taskId: "b", ref: { id: "b", recordKey: "b" } }); coordinator.initialComplete();
  const seen: string[] = [];
  for await (const next of coordinator) {
    seen.push(next.taskId);
    const record = next.taskId === "a" ? failure(new Error("ECONNRESET")) : storeRecord(next);
    record.key = { runId: next.runId, taskId: next.taskId, attemptId: next.attemptId };
    coordinator.complete(record);
  }
  expect(seen).toEqual(["a", "b"]);
});
test("manual additions deduplicate pending/active work and cancellation clears delayed work", async () => {
  const coordinator = new TaskQueue();
  expect(coordinator.add(job)).toBe(true); expect(coordinator.add(job)).toBe(false);
  const iterator = coordinator[Symbol.asyncIterator](); await iterator.next();
  expect(coordinator.add(job)).toBe(false);
  coordinator.complete(failure(new Error("ECONNRESET")));
  coordinator.close(); expect((await iterator.next()).done).toBe(true);
});

test("a reserved retry prevents shutdown and duplicate admission until committed", async () => {
  const coordinator = new TaskQueue();
  coordinator.initialComplete();
  const reservation = coordinator.reserve(job, "failed-attempt");
  expect(reservation).toBeDefined();
  expect(coordinator.reserve(job, "failed-attempt")).toBeUndefined();
  expect(coordinator.add(job)).toBe(false);
  const iterator = coordinator[Symbol.asyncIterator]();
  const pending = iterator.next();
  reservation?.commit(); reservation?.commit(); reservation?.release();
  expect((await pending).value).toEqual(job);
  expect(coordinator.expectedFailure(job.attemptId)).toBe("failed-attempt");
  coordinator.complete(storeRecord(job));
  expect((await iterator.next()).done).toBe(true);
});

test("a rejected reservation releases shutdown without producing an attempt", async () => {
  const coordinator = new TaskQueue();
  coordinator.initialComplete();
  const reservation = coordinator.reserve(job, "failed-attempt");
  const pending = coordinator[Symbol.asyncIterator]().next();
  reservation?.release(); reservation?.commit();
  expect((await pending).done).toBe(true);
});

test("structured quota/auth/context errors take precedence over a wrapped network signal", () => {
  for (const code of ["insufficient_quota", "PermissionDeniedError", "CONTEXT_WINDOW_EXCEEDED", "SOLVER_OUTPUT_LIMIT"]) {
    const error = Object.assign(new Error("upstream returned error", { cause: new Error("APIConnectionError") }), { code, status: 429 });
    expect(isManualRetryEligible(failure(error))).toBe(false);
  }
});

test("a failed assertion quoting a network error is not verifier network evidence", () => {
  expect(isManualRetryEligible(failure(new Error('AssertionError: assert "ReadTimeout" in output'), { phase: "verify" }))).toBe(false);
  expect(isManualRetryEligible(failure(new Error("ReadTimeout occurred earlier\nmake: *** Error 2"), { phase: "environment", operation: "build" }))).toBe(false);
});

test("verifier dependency transfers differ from an unavailable solver service", () => {
  expect(isManualRetryEligible(failure(new Error("pip install failed: ReadTimeout"), { phase: "verify" }))).toBe(true);
  expect(isManualRetryEligible(failure(new Error("curl: ECONNREFUSED http://127.0.0.1:8000"), { phase: "verify" }))).toBe(false);
  expect(isManualRetryEligible(failure(new Error("ECONNREFUSED"), { phase: "verify" }))).toBe(false);
});

test("a crashing or malformed harness cannot turn incidental stderr into a network retry", () => {
  for (const code of ["SOLVER_PROCESS_CRASHED", "SOLVER_PROTOCOL_INVALID"])
    expect(isManualRetryEligible(failure(Object.assign(new Error("earlier tool output: ReadTimeout"), { code })))).toBe(false);
});
