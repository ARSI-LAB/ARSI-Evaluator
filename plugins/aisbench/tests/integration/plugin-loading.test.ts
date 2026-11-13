import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, test } from "vitest";

const pluginRoot = fileURLToPath(new URL("../../", import.meta.url));
const consumer = fileURLToPath(new URL("./consumer.mjs", import.meta.url));
const guard = new URL("./no-external.mjs", import.meta.url).href;

test.each([
  ["absence", "host exposes the bundled AISBench without an explicit patch"],
  ["config", "bundled providers load and CLI validates configuration without SSH"],
  ["report", "persisted results rebuild offline through public API and CLI with provider version checks"],
])("%s: %s", async scenario => {
  const scratch = join(pluginRoot, ".scratch");
  await mkdir(scratch, { recursive: true });
  const directory = await mkdtemp(join(scratch, "integration-"));
  const env: NodeJS.ProcessEnv = { ...process.env, AISBENCH_TEST_EXTERNAL_LOG: join(directory, "external.log") };
  delete env.AISBENCH_OFFLINE_KEY;
  try {
    const result = await promisify(execFile)(process.execPath,
      ["--import", guard, consumer, scenario, directory],
      { env, encoding: "utf8", timeout: 90000 });
    expect(JSON.parse(result.stdout)).toMatchObject({ passed: true, scenario });
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 100000);
