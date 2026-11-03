import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Server } from "node:http";
import { afterEach, expect, test } from "vitest";

import { DocOpsBenchmark, parseDocOpsConfig } from "../../plugins/docops/index.js";
import { startDocOpsFixtureSource } from "../fixtures/docops-source.js";

const fixture = join(import.meta.dirname, "../fixtures/docops");
const roots: string[] = [];
const servers: Server[] = [];
const signal = () => new AbortController().signal;

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((accept, reject) => server.close(error => error ? reject(error) : accept()));
}

async function workingCopy(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "docops-plugin-"));
  roots.push(root);
  await cp(fixture, root, { recursive: true });
  return root;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(closeServer));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

test("validates the DocOps plugin configuration", () => {
  expect(parseDocOpsConfig({})).toEqual({ repository: "icip-cas/DocOps", revision: "main", cacheDir: ".cache/docops" });
  expect(parseDocOpsConfig({ repository: "owner/repo", revision: "v1", cacheDir: "./cache" })).toEqual({ repository: "owner/repo", revision: "v1", cacheDir: "./cache" });
  expect(() => parseDocOpsConfig({ rootDir: "./DocOps" })).toThrow(/unknown field/i);
  expect(() => parseDocOpsConfig({ repository: "https://github.com/icip-cas/DocOps" })).toThrow(/owner\/repository/i);
});

test("downloads, locks, enumerates and translates a DocOps 1.1 task", async () => {
  const root = await workingCopy();
  const remote = await startDocOpsFixtureSource(root);
  servers.push(remote.server);
  const cacheDir = join(root, "cache");
  const config = { repository: "fixture/docops", revision: "main", cacheDir };
  const benchmark = new DocOpsBenchmark(config, remote.transport);
  const source = await benchmark.resolveSource(null, signal());
  expect(source.source).toBe("docops");
  expect(source.revision).toBe(remote.commit);
  expect(source.files).toHaveLength(1);

  const refs = [];
  for await (const ref of benchmark.enumerate(source, signal())) refs.push(ref);
  expect(refs).toEqual([{ id: "sample-docops", recordKey: "sample-docops" }]);

  const task = await benchmark.prepare(refs[0]!, source, signal());
  expect(task.input).toMatchObject({ id: "sample-docops" });
  expect(task.input.prompt).toContain("/root/submission/output.txt");
  expect(task.solveEnv).toMatchObject({
    workdir: "/root/submission",
    image: null,
    resources: { cpus: 1, memory: "256M", storage: "512M" },
    build: { dockerfile: "Dockerfile" },
  });
  expect(task.verifyEnv).toEqual(task.solveEnv);
  expect(task.transfer).toEqual({ kind: "workspace-archive", workdir: "/root/submission", extraPaths: [] });
  expect(task.verification).toMatchObject({ descriptor: { id: "sample-docops", workdir: "/root/submission", timeoutSeconds: 30 }, env: {} });
  const plan = await benchmark.planRun(refs, source, signal());
  expect(plan.tasks.map(task => task.input.id)).toEqual(["sample-docops"]);
  expect(plan.preparation.defaultTimeoutSeconds).toBe(600);
  expect(plan.tasks[0]?.preparationTimeoutSeconds).toEqual({ solve: 60, verify: 60 });
  expect(plan.policy).toEqual({ version: "docops-preparation-v2", source: "DocOpsBenchmark:declared-build-timeouts" });
  expect((await readFile(join(task.solveEnv.build!.context, "input.txt"), "utf8")).trim()).toBe("docops-fixture");

  await closeServer(remote.server);
  servers.splice(servers.indexOf(remote.server), 1);
  const resumed = new DocOpsBenchmark(config, remote.transport);
  await resumed.resolveSource(source, signal());
  await resumed.prepare(refs[0]!, source, signal());
});

test("rejects a source lock that differs from the configured repository", async () => {
  const root = await workingCopy();
  const remote = await startDocOpsFixtureSource(root);
  servers.push(remote.server);
  const benchmark = new DocOpsBenchmark({ repository: "fixture/docops", revision: "main", cacheDir: join(root, "cache") }, remote.transport);
  const source = await benchmark.resolveSource(null, signal());
  const other = new DocOpsBenchmark({ repository: "other/docops", revision: "main", cacheDir: join(root, "cache") }, remote.transport);
  await expect(other.resolveSource(source, signal())).rejects.toThrow(/does not match configuration/i);
});

test("rejects an output path whose transfer root overlaps evaluator-private state", async () => {
  const root = await workingCopy();
  const taskFile = join(root, "tasks/sample-docops/task.toml");
  await writeFile(taskFile, (await readFile(taskFile, "utf8")).replace("/root/submission/output.txt", "/root/output.txt"));
  const remote = await startDocOpsFixtureSource(root);
  servers.push(remote.server);
  const benchmark = new DocOpsBenchmark({ repository: "fixture/docops", revision: "main", cacheDir: join(root, "cache") }, remote.transport);
  const source = await benchmark.resolveSource(null, signal());
  await expect(benchmark.prepare({ id: "sample-docops", recordKey: "sample-docops" }, source, signal())).rejects.toThrow(/unsafe state transfer root/i);
});
