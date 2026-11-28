import { mkdtemp, readdir, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { LocalWorkflowStore } from "../../src/plugins/stores/workflow-local.js";
import type { WorkflowRunRecord } from "../../src/core/contracts/workflow.js";

vi.mock("node:fs/promises", async original => {
  const fs = await original<typeof import("node:fs/promises")>();
  return { ...fs, rename: vi.fn(fs.rename) };
});
const roots: string[] = [];
afterEach(async () => { vi.clearAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

test.each(["EPERM", "EBUSY", "EIO"])("snapshot replacement handles %s without exposing partial data or leaving a temporary file", async code => {
  const root = await mkdtemp(join(tmpdir(), "workflow-snapshot-")); roots.push(root);
  const store = new LocalWorkflowStore(root);
  const record: WorkflowRunRecord = { schemaVersion: 2, runId: "run", fingerprint: "a".repeat(64), implementations: {},
    startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), status: "completed", businessComplete: true,
    outputs: {}, units: [], steps: [], resources: [], artifacts: [], errors: [] };
  await store.save(record);
  vi.mocked(rename).mockRejectedValueOnce(Object.assign(new Error("replace failed"), { code }));
  const next = { ...record, outputs: { value: "saved" } };
  if (code === "EIO") {
    await expect(store.save(next)).rejects.toMatchObject({ code });
    expect(await store.read()).toEqual(record);
  } else {
    await store.save(next);
    expect(await store.read()).toEqual(next);
  }
  expect(await readdir(root)).toEqual(["run.json"]);
});
