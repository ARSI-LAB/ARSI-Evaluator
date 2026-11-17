import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { serializeToolResultOrError } from "../../src/runtimes/dsh/assets/output-hook.mjs";

test("a failed export is bounded, redacted and never fabricates a completed tool result", async () => {
  const secret = "private-fixture-secret";
  const directory = await mkdtemp(join(tmpdir(), secret + "-"));
  const event = Object.freeze({ type: "tool_result", callId: "call", status: "completed", result: "x".repeat(100000) });
  try {
    await writeFile(join(directory, "tool-outputs"), "blocked");
    const line = serializeToolResultOrError(event, directory, secret);
    const diagnostic = JSON.parse(line);
    expect(diagnostic.type).toBe("error");
    expect(diagnostic.message).toContain("EEXIST");
    expect(diagnostic.message).toContain("[redacted]");
    expect(line).not.toContain(secret);
    expect(line).not.toContain('"status":"completed"');
    expect(Buffer.byteLength(line)).toBeLessThan(32768);
    expect(event.result).toHaveLength(100000);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
