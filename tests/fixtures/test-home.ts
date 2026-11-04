import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, vi } from "vitest";

// Configuration tests must never read or overwrite the developer's ~/.ember-evaluator.
const testHome = mkdtempSync(join(tmpdir(), "evaluator-test-home-"));
vi.mock("node:os", async importOriginal => {
  const original = await importOriginal<typeof import("node:os")>();
  return { ...original, homedir: () => testHome };
});
afterAll(() => rmSync(testHome, { recursive: true, force: true }));
