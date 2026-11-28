import { randomUUID } from "node:crypto";
import type { WorkflowArtifact, WorkflowRunRecord, WorkflowStore, WorkflowUnitRequest } from "../../core/contracts/workflow.js";
import { artifactReference, parseWorkflowRun } from "../../core/workflow/record.js";
import { workflowObject, workflowDigest } from "../../core/workflow/values.js";
import { expectNonEmptyString, expectRecord } from "../../core/validation/input.js";
import type { TransferClient } from "../transfer/client.js";
import type { ProgressListener } from "../../core/progress/progress.js";
import { parseProgressEvent, parseProgressSnapshot } from "../../core/progress/progress-wire.js";

const CHUNK_BYTES = 512 * 1024;
const MAX_ARTIFACT_BYTES = 256 * 1024 * 1024;
type ArtifactOptions = Parameters<ReturnType<WorkflowStore["artifacts"]>["write"]>[2];

/** Per-attempt authenticated channel; retries of one RPC never allocate a second artifact. */
export class WorkflowTransferSession {
  readonly replies = new Map<string, { digest: string; value: Promise<unknown> }>();
  readonly uploads = new Map<string, { producer: string; name: string; options: ArtifactOptions; chunks: Buffer[]; size: number }>();
  lastSnapshot: WorkflowRunRecord | undefined;
  lastHeartbeat = Date.now();
  constructor(readonly request: WorkflowUnitRequest, readonly nodeId: string, readonly packageDigest: string,
    readonly store: WorkflowStore, readonly signal: AbortSignal,
    readonly credentials: { names: readonly string[]; resolve(name: string): Promise<string | undefined> } = { names: [], resolve: async () => undefined },
    readonly onProgress?: ProgressListener) {}

  handle(value: unknown): Promise<unknown> {
    const body = expectRecord(value, "workflow transfer");
    if (body.attemptId !== this.request.unit.attemptId || body.nodeId !== this.nodeId) throw new TypeError("Workflow transfer placement mismatch");
    this.lastHeartbeat = Date.now();
    if (body.op === "progress" || body.op === "event") {
      const events = body.op === "progress" ? parseProgressSnapshot(body.snapshot).events : [parseProgressEvent(body.event)];
      for (const event of events) {
        if (event.taskId !== undefined && event.taskId !== this.request.unit.caseId || event.attemptId !== undefined && event.attemptId !== this.request.unit.attemptId)
          throw new TypeError("Progress does not belong to the assigned workflow unit");
        this.onProgress?.({ ...event, taskId: this.request.unit.caseId, attemptId: this.request.unit.attemptId });
      }
      return Promise.resolve({ accepted: true });
    }
    const id = expectNonEmptyString(body.requestId, "workflow request ID");
    const digest = workflowDigest(body);
    const previous = this.replies.get(id);
    if (previous) {
      if (previous.digest !== digest) throw new TypeError("Workflow RPC ID reused with different content");
      return previous.value;
    }
    const operation = this.perform(body);
    this.replies.set(id, { digest, value: operation });
    return operation;
  }

  private async perform(body: Record<string, unknown>): Promise<unknown> {
    if (body.op === "assignment") return { request: this.request, packageDigest: this.packageDigest };
    if (body.op === "heartbeat") return { cancelled: this.signal.aborted };
    if (body.op === "credential") return readWorkflowCredential(body, this.credentials.names, this.credentials.resolve);
    if (body.op === "checkpoint") {
      const snapshot = parseWorkflowRun(body.snapshot);
      await this.store.save(snapshot);
      this.lastSnapshot = snapshot;
      return { accepted: true };
    }
    if (body.op === "write-start") {
      const metadata = workflowObject(body.options);
      if (metadata.visibility !== "public" && metadata.visibility !== "private" || typeof metadata.complete !== "boolean")
        throw new TypeError("Invalid workflow artifact metadata");
      const id = randomUUID();
      this.uploads.set(id, { producer: expectNonEmptyString(body.producer, "artifact producer"), name: expectNonEmptyString(body.name, "artifact name"),
        options: { mediaType: expectNonEmptyString(metadata.mediaType, "media type"), protocol: expectNonEmptyString(metadata.protocol, "artifact protocol"),
          visibility: metadata.visibility, complete: metadata.complete }, chunks: [], size: 0 });
      return { id };
    }
    if (body.op === "write-chunk" || body.op === "write-commit") {
      const id = expectNonEmptyString(body.id, "upload ID"), upload = this.uploads.get(id);
      if (!upload) throw new TypeError("Unknown workflow upload");
      if (body.op === "write-commit") {
        const artifact = await this.store.artifacts(upload.producer).write(upload.name, Buffer.concat(upload.chunks), upload.options);
        this.uploads.delete(id);
        return artifact;
      }
      const chunk = decodeChunk(body.content);
      if (body.index !== upload.chunks.length || upload.size + chunk.length > MAX_ARTIFACT_BYTES) throw new TypeError("Invalid workflow artifact chunk or size limit exceeded");
      upload.chunks.push(chunk); upload.size += chunk.length;
      return { accepted: true };
    }
    if (body.op === "read") {
      const artifact = artifactReference(body.artifact);
      if (typeof body.offset !== "number" || !Number.isSafeInteger(body.offset) || body.offset < 0 || body.offset > artifact.size)
        throw new TypeError("Invalid workflow read offset");
      const bytes = await this.store.artifacts(artifact.producer).read(artifact);
      return { content: Buffer.from(bytes.subarray(body.offset, body.offset + CHUNK_BYTES)).toString("base64") };
    }
    throw new TypeError("Unknown workflow transfer operation");
  }
}

export async function readWorkflowCredential(body: Record<string, unknown>, names: readonly string[], resolve: (name: string) => Promise<string | undefined>) {
  const name = expectNonEmptyString(body.name, "credential name");
  if (!names.includes(name)) throw new TypeError("Workflow credential was not declared by a dispatched resource");
  return { value: await resolve(name) ?? null };
}

function decodeChunk(value: unknown): Buffer {
  if (typeof value !== "string" || value.length > Math.ceil(CHUNK_BYTES / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value))
    throw new TypeError("Invalid workflow artifact chunk");
  return Buffer.from(value, "base64");
}

export function workflowTransferClient(client: TransferClient, attemptId: string, nodeId: string, signal: AbortSignal) {
  const call = (payload: Record<string, unknown>, active = signal) => client.control("control", {
    ...payload, attemptId, nodeId, requestId: randomUUID(),
  }, active);
  const store: WorkflowStore = {
    async save(snapshot) { await call({ op: "checkpoint", snapshot }); },
    artifacts(producer) {
      return {
        async write(name, content, options): Promise<WorkflowArtifact> {
          const bytes = typeof content === "string" ? Buffer.from(content) : content;
          if (bytes.length > MAX_ARTIFACT_BYTES) throw new TypeError("Workflow artifact exceeds 256 MiB transfer limit");
          const upload = workflowObject(await call({ op: "write-start", producer, name,
            options: { ...options, visibility: options.visibility ?? "public", complete: options.complete ?? true } }));
          for (let offset = 0, index = 0; offset < bytes.length; offset += CHUNK_BYTES, index++)
            await call({ op: "write-chunk", id: upload.id, index, content: Buffer.from(bytes.subarray(offset, offset + CHUNK_BYTES)).toString("base64") });
          return artifactReference(await call({ op: "write-commit", id: upload.id }));
        },
        async read(artifact) {
          if (artifact.size > MAX_ARTIFACT_BYTES) throw new TypeError("Workflow artifact exceeds 256 MiB transfer limit");
          const chunks: Buffer[] = [];
          for (let offset = 0; offset < artifact.size; offset += CHUNK_BYTES) {
            const result = workflowObject(await call({ op: "read", artifact, offset }));
            const bytes = decodeChunk(result.content);
            if (bytes.length !== Math.min(CHUNK_BYTES, artifact.size - offset)) throw new TypeError("Truncated workflow artifact");
            chunks.push(bytes);
          }
          const content = Buffer.concat(chunks);
          const { createHash } = await import("node:crypto");
          if (createHash("sha256").update(content).digest("hex") !== artifact.sha256) throw new TypeError("Workflow artifact digest mismatch");
          return content;
        },
      };
    },
  };
  return { call, store };
}
