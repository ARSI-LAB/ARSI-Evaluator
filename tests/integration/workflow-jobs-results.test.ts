import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import type { WorkflowRunRecord } from "../../src/core/contracts/workflow.js";
import { buildFileManifest, checkedPath } from "../../src/core/artifacts/artifacts.js";
import { JobsClient } from "../../src/infrastructure/ray/jobs-client.js";
import { LocalWorkflowStore } from "../../src/plugins/stores/workflow-local.js";
import { downloadWorkflowResults } from "../../src/application/ray/workflow-jobs-results.js";

test("workflow downloads publish the newer snapshot and reject corrupt evidence before replacing the local result", async () => {
  const root = await mkdtemp(join(tmpdir(), "workflow-jobs-download-"));
  try {
    const runId = randomUUID(), jobId = randomUUID(), server = new LocalWorkflowStore(join(root, "server"));
    const artifact = await server.artifacts("step").write("evidence.txt", "first", { protocol: "arsi.text/v1", mediaType: "text/plain" });
    const record: WorkflowRunRecord = { schemaVersion: 2, runId, fingerprint: "a".repeat(64), implementations: {},
      startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), status: "completed", businessComplete: true,
      outputs: { version: 1 }, units: [], steps: [], resources: [], artifacts: [artifact], errors: [] };
    await server.save(record);
    await mkdir(join(server.directory, "reports", "initial"), { recursive: true });
    await writeFile(join(server.directory, "reports", "initial", "report.md"), "first report");
    await writeFile(join(server.directory, "report.md"), "first report");
    await writeFile(join(server.directory, "plan.json"), JSON.stringify({ fingerprint: record.fingerprint }));
    class Client extends JobsClient {
      override async call(path: string): Promise<unknown> {
        if (path.endsWith("/manifest")) return { runId, ...await buildFileManifest(server.directory, []) };
        const url = new URL(path, "https://unused");
        const bytes = await readFile(await checkedPath(server.directory, url.searchParams.get("path") ?? ""));
        const offset = Number(url.searchParams.get("offset"));
        return { data: bytes.subarray(offset, offset + 1024 * 1024).toString("base64") };
      }
    }
    const client = new Client("https://unused", Buffer.alloc(0), ""), output = join(root, "client"), signal = AbortSignal.timeout(10_000);
    const first = await downloadWorkflowResults(client, jobId, output, record.fingerprint, signal, () => {});
    expect(await new LocalWorkflowStore(first.directory).read()).toEqual(record);
    await writeFile(join(first.directory, "workflow-deployment.json"), "local gateway settings");
    await writeFile(join(first.directory, "workflow-reporting.json"), "local report plugin locations");
    await writeFile(join(server.directory, "workflow-reporting.json"), "coordinator plugin locations");
    const secondArtifact = await server.artifacts("next").write("evidence.txt", "second", { protocol: "arsi.text/v1", mediaType: "text/plain" });
    const second = { ...record, outputs: { version: 2 }, artifacts: [artifact, secondArtifact] };
    await server.save(second);
    await writeFile(join(server.directory, "report.md"), "second report");
    await downloadWorkflowResults(client, jobId, output, record.fingerprint, signal, () => {});
    expect(await new LocalWorkflowStore(first.directory).read()).toEqual(second);
    expect(await readFile(join(first.directory, "report.md"), "utf8")).toBe("second report");
    expect(await readFile(join(first.directory, "reports", "initial", "report.md"), "utf8")).toBe("first report");
    expect(await readFile(join(first.directory, "workflow-deployment.json"), "utf8")).toBe("local gateway settings");
    expect(await readFile(join(first.directory, "workflow-reporting.json"), "utf8")).toBe("local report plugin locations");
    await writeFile(join(server.directory, secondArtifact.path), "corrupted");
    await expect(downloadWorkflowResults(client, jobId, output, record.fingerprint, signal, () => {})).rejects.toThrow();
    expect(await new LocalWorkflowStore(first.directory).read()).toEqual(second);
  } finally { await rm(root, { recursive: true, force: true }); }
});
