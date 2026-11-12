import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { buildFileManifest } from "../../src/core/artifacts/artifacts.js";
import type { EnvironmentSpec, RuntimeInstallation } from "../../src/core/contracts/environment.js";
import type { JsonValue } from "../../src/core/contracts/task.js";
import { fingerprintConfig } from "../../src/core/results/run-manifest.js";
import { runDockerCommand } from "../../src/infrastructure/containers/command.js";
import { PINNED_NODE_IMAGE } from "../../src/infrastructure/containers/runtime-contract.js";
import { readProcess } from "../../src/infrastructure/process/output.js";
import { DockerEnvironment } from "../../src/plugins/environments/docker/environment.js";
import { OfficeQAProV2Benchmark, parseOfficeQAProV2Config } from "../../src/plugins/benchmarks/agent-harness/definitions/officeqa-pro-v2/index.js";
import { officeQAFiles } from "../fixtures/officeqa.js";

test.skipIf(process.env.EVALUATOR_RETAINED_IMAGES_TEST !== "1")(
  "keeps only the reusable base and runnable images for default, Harbor and OfficeQA environments",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "evaluator-retained-images-"));
    const runId = randomUUID();
    const signal = AbortSignal.timeout(540_000);
    const docker = (args: string[]) => runDockerCommand("docker", args, { signal });
    const imageRefs = async () => (await docker(["image", "ls", "--no-trunc", "--digests", "--format",
      "{{.ID}} {{.Repository}} {{.Tag}} {{.Digest}}"])).stdout.trim().split(/\r?\n/u).filter(Boolean);
    const initial = new Set(await imageRefs());
    vi.stubEnv("EVALUATOR_CACHE_DIR", join(root, "cache"));
    const configs = [runId + "-one", runId + "-two"];
    const a = new DockerEnvironment({ imageConfigFingerprint: configs[0]!, solverName: "one" });
    const b = new DockerEnvironment({ imageConfigFingerprint: configs[1]!, solverName: "one" });
    const aTwo = new DockerEnvironment({ imageConfigFingerprint: configs[0]!, solverName: "two" });
    const bTwo = new DockerEnvironment({ imageConfigFingerprint: configs[1]!, solverName: "two" });
    const defaultSpec: EnvironmentSpec = { workdir: "/workspace", image: null, initialFiles: [], runtime: [], network: "none" };
    const scope = (taskId: string, phase: "solve" | "verify" = "solve") => ({ taskId, phase });
    const install = (name: string): RuntimeInstallation => ({ id: name, files: [],
      commands: [{ executable: "node", args: ["-e", "require('node:fs').writeFileSync('solver', " + JSON.stringify(runId + name) + ")"] }],
      probes: [{ executable: "node", args: ["-e", "require('node:fs').statSync('solver')"] }] });
    const ready = (environment: DockerEnvironment, spec: EnvironmentSpec, name: string, solver: string) =>
      environment.materialize({ ...spec, installation: install(solver) }, signal, undefined, undefined, scope(name));
    const build = async (name: string, visibility: "public" | "verifier"): Promise<EnvironmentSpec> => {
      const context = join(root, name);
      await mkdir(context);
      await writeFile(join(context, "Dockerfile"), "FROM " + PINNED_NODE_IMAGE + "\nLABEL evaluator.fixture=" + runId + "-" + name + "\n");
      const manifest = await buildFileManifest(context, []);
      return { ...defaultSpec, imageScope: { dataset: "terminal-bench@4.0.0", taskPath: name }, build: { context, dockerfile: "Dockerfile", visibility,
        sourceHash: fingerprintConfig(manifest.files as unknown as JsonValue) } };
    };
    const count = async (baseline: Set<string>, newImages: number) => {
      const added = (await imageRefs()).filter(line => !baseline.has(line));
      expect(added).toHaveLength(newImages);
      expect(new Set(added.map(line => line.split(" ")[0])).size).toBe(newImages);
      expect(added.every(line => !line.includes("ember-evaluator/staging") && !line.includes("solver-install"))).toBe(true);
      expect(added.every(line => !line.includes("ember-evaluator/shared"))).toBe(true);
      return new Set(await imageRefs());
    };
    const paths = async (attemptId: string, taskId: string) => {
      const directory = join(root, attemptId);
      await mkdir(directory);
      const key = { runId, taskId, attemptId };
      await writeFile(join(directory, "allocation.json"), JSON.stringify({ key }));
      return { root: directory, agent: join(directory, "agent"), verifier: join(directory, "verifier"), artifacts: join(directory, "artifacts") };
    };
    let stopped: string | undefined;
    let model: string | undefined;
    try {
      const [first, shared, other] = await Promise.all([
        ready(a, defaultSpec, "default/a", "one"), ready(b, defaultSpec, "default/b", "one"),
        ready(bTwo, defaultSpec, "default/b", "two"),
      ]);
      expect(first.prepared).toEqual(shared.prepared);
      expect(first.prepared).not.toEqual(other.prepared);
      const hit = await ready(b, defaultSpec, "default/a", "one");
      expect(hit.preparationTiming?.cache?.solver).toBe("image");
      const defaultImages = await count(initial, 2); // The pinned Node image is also the default base.
      model = (await docker(["run", "--detach", "--pull", "never", "--entrypoint", "node", PINNED_NODE_IMAGE,
        "-e", "require('node:http').createServer((req,res) => res.end(req.url)).listen(19991, '0.0.0.0')"])).stdout.trim();
      const modelIp = (await docker(["inspect", model, "--format", "{{(index .NetworkSettings.Networks \"bridge\").IPAddress}}"])).stdout.trim();
      const modelEndpoint = `http://${modelIp}:19991/v1`;
      const gateway = new DockerEnvironment({ modelEndpoint, imageConfigFingerprint: configs[1]!, solverName: "one" });
      const isolated = await ready(gateway, { ...defaultSpec, network: "model-api" }, "default/a", "one");
      for (const attempt of ["first", "second"]) {
        const session = await gateway.prepare(isolated, await paths(attempt, "default/a"), "solve", signal);
        try {
          const output = await readProcess(await session.start({ executable: "sh",
            args: ["-ec", "test ! -f /workspace/marker; touch /workspace/marker"],
            cwd: "/workspace", env: {}, input: null }, signal), signal);
          expect(output.code, output.stderr).toBe(0);
          expect(session.modelEndpoint?.baseUrl).toBeDefined();
          const request = await readProcess(await session.start({ executable: "node",
            args: ["-e", `(async () => {
              const response = await fetch(${JSON.stringify(session.modelEndpoint?.baseUrl + "/health")});
              if (await response.text() !== "/v1/health") throw Error("gateway request failed");
              const direct = await fetch(${JSON.stringify(modelEndpoint)}, { signal: AbortSignal.timeout(2000) }).catch(() => null);
              if (direct) throw Error("task bypassed the gateway");
            })().catch(error => { console.error(error); process.exitCode = 1; })`],
            cwd: "/workspace", env: {}, input: null }, signal), signal);
          expect(request.code, request.stderr).toBe(0);
        } finally { await session.dispose(signal); }
      }
      const scoped = (fingerprint: string, execute: boolean) => b.cleanupImages({ all: false, execute, configFingerprint: fingerprint }, signal);
      const before = await scoped(configs[0]!, false);
      expect(before.items.some(item => item.status === "retained" && item.reason.includes("another configuration"))).toBe(true);
      await scoped(configs[0]!, true);
      const solver = expect.objectContaining({ launchImage: expect.stringMatching(/^sha256:/u) });
      expect(first.prepared).toMatchObject(solver);
      const launchImage = (first.prepared as { launchImage: string }).launchImage;
      stopped = (await docker(["create", "--pull", "never", launchImage, "true"])).stdout.trim();
      const preview = await scoped(configs[1]!, false);
      expect(preview.items).toContainEqual(expect.objectContaining({ imageId: launchImage, status: "skipped", reason: expect.stringContaining("stopped") }));
      expect(preview.items.some(item => item.status === "candidate")).toBe(true);
      await docker(["rm", stopped]); stopped = undefined;
      expect((await scoped(configs[1]!, true)).items.filter(item => item.status === "deleted")).toHaveLength(2);
      await expect(b.prepare(hit, await paths("lost", "default/a"), "solve", signal)).rejects.toMatchObject({ code: "ENV_PREPARED_IMAGE_LOST" });
      expect((await ready(b, defaultSpec, "default/a", "one")).prepared).toMatchObject(solver);
      await scoped(configs[1]!, true);
      expect((await imageRefs()).every(line => !defaultImages.has(line) || initial.has(line))).toBe(true);

      const harborA = await build("harbor-a", "public");
      const harborB = await build("harbor-b", "public");
      const harborVerify = await build("harbor-verify", "verifier");
      await Promise.all([
        ready(a, harborA, "harbor/a", "one"), ready(aTwo, harborA, "harbor/a", "two"),
        ready(a, harborB, "harbor/b", "one"), ready(aTwo, harborB, "harbor/b", "two"),
        a.materialize({ ...harborVerify, imageScope: harborA.imageScope! }, signal, undefined, undefined, scope("harbor/a", "verify")),
        a.materialize({ ...harborVerify, imageScope: harborB.imageScope! }, signal, undefined, undefined, scope("harbor/b", "verify")),
      ]);
      await count(initial, 7);
      expect((await scoped(configs[0]!, true)).items.filter(item => item.status === "deleted")).toHaveLength(7);

      const fixture = await officeQAFiles(join(root, "office-source"), "parsed-json");
      const office = new OfficeQAProV2Benchmark(parseOfficeQAProV2Config({ cacheDir: join(root, "office-cache") }),
        fixture.source, { questions: 2, documents: 2 }, undefined, configs[1]);
      const lock = await office.resolveSource(null, signal);
      const tasks = [];
      for await (const ref of office.enumerate(lock, signal)) tasks.push(await office.prepare(ref, lock, signal));
      const [task, second] = tasks;
      if (!task || !second) throw new Error("Missing OfficeQA fixtures");
      const [, , receipt, sharedReceipt] = await Promise.all([
        ready(b, task.solveEnv, task.input.id, "one"), ready(bTwo, second.solveEnv, second.input.id, "two"),
        office.verificationRuntime.materialize(task, signal), office.verificationRuntime.materialize(second, signal),
      ]);
      expect(receipt).toEqual(sharedReceipt);
      const hadPython = [...initial].some(line => line.includes(" python 3.12-slim "));
      await count(initial, hadPython ? 3 : 4);
      const key = { runId, taskId: task.input.id, attemptId: "score" };
      const verifier = await office.verificationRuntime.prepare(task, receipt, { key, paths: await paths(key.attemptId, key.taskId), signal });
      try {
        const verdict = await verifier.verify({ finalText: "<FINAL_ANSWER>21.58</FINAL_ANSWER>",
          usage: { inputTokens: null, outputTokens: null, totalTokens: null } }, null, signal);
        expect(verdict.score).toBe(1);
      } finally { await verifier.dispose(signal); }
    } finally {
      if (stopped) await docker(["rm", stopped]);
      if (model) await docker(["rm", "--force", model]);
      for (const configFingerprint of configs)
        await b.cleanupImages({ all: false, execute: true, configFingerprint }, AbortSignal.timeout(60_000));
      vi.unstubAllEnvs();
      await rm(root, { recursive: true, force: true });
    }
  }, 600_000,
);
