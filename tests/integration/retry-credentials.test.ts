import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { runWorkflow, retryWorkflow } from "../../src/application/workflow.js";

test.each(["solver", "verifier", "benchmark-judge"])("retry resolves current %s credentials without replaying saved secrets", async role => {
  const root = await mkdtemp(join(tmpdir(), "workflow-retry-credentials-"));
  const globals = globalThis as Record<string, unknown>;
  try {
    await copyFile(join(import.meta.dirname, "../fixtures/cli/plugin.mjs"), join(root, "base.mjs"));
    await writeFile(join(root, "plugin.mjs"), `import { registerNativeResource } from "arsi-evaluator";
      import { apply as base } from "./base.mjs";
      export const inject = ["evaluator"];
      export function apply(ctx) {
        base(ctx);
        registerNativeResource(ctx, "verifier", "retry-fixture", value => value, () => ({}));
        registerNativeResource(ctx, "solver", "retry-fixture", value => value, (_config, runtime) => ({
          requirements() { return []; },
          async solve() {
            globalThis.__retryAuthSeen.push(Object.fromEntries(Object.entries(runtime.services).map(([name, service]) => [name, service.auth.value])));
            if (globalThis.__retryAuthFail) throw new Error("controlled failure");
            return { finalText: "42", usage: { inputTokens: null, outputTokens: null, totalTokens: null } };
          }
        }));
      }`);
    const configPath = join(root, "eval.yaml"), patchPath = join(root, "patch.yaml");
    await writeFile(patchPath, JSON.stringify([{ insert: [{ id: "retry-credentials", name: "./plugin.mjs" }] }]));
    const service = (apiKeyEnv: string) => ({ model: "fixture", base_url: "https://unused.invalid", apiKeyEnv });
    await writeFile(configPath, JSON.stringify({ schemaVersion: 2, workflow: "benchmark.evaluate", with: {
      services: { default: service("SOLVER_KEY"), ...(role === "solver" ? {} : { judge: service("JUDGE_KEY") }) },
      benchmark: { name: "cli-fixture", config: role === "benchmark-judge" ? { judgeService: "judge" } : {},
        solver: { name: "retry-fixture", service: "default" },
        ...(role === "verifier" ? { verifier: { name: "retry-fixture", service: "judge" } } : {}) },
      environment: "local", output: { directory: join(root, "runs") },
    } }));
    const seen: unknown[] = []; globals.__retryAuthSeen = seen; globals.__retryAuthFail = true;
    const first = await runWorkflow({ configPath, patchPath, env: { SOLVER_KEY: "initial-solver-private", JUDGE_KEY: "initial-judge-private" } });
    expect(first.record.status).toBe("failed");
    expect(seen).toHaveLength(1);
    const missingName = role === "solver" ? "SOLVER_KEY" : "JUDGE_KEY";
    const missing = await retryWorkflow(first.directory, { env: role === "solver" ? {} : { SOLVER_KEY: "current-solver-private" } });
    expect(missing.record.status).toBe("failed");
    expect(JSON.stringify(missing.record.errors)).toContain(missingName);
    expect(missing.record.units).toHaveLength(first.record.units.length);
    expect(seen).toHaveLength(1);
    globals.__retryAuthFail = false;
    const retried = await retryWorkflow(first.directory, { env: { SOLVER_KEY: "current-solver-private", JUDGE_KEY: "current-judge-private" } });
    expect(retried.record.status, JSON.stringify(retried.record.errors)).toBe("completed");
    expect(seen.at(-1)).toEqual({ default: "current-solver-private", ...(role === "solver" ? {} : { judge: "current-judge-private" }) });
    for (const name of ["plan.json", "run.json", "workflow-reporting.json"]) {
      const saved = await readFile(join(first.directory, name), "utf8");
      expect(saved).not.toContain("initial-solver-private"); expect(saved).not.toContain("initial-judge-private");
      expect(saved).not.toContain("current-solver-private"); expect(saved).not.toContain("current-judge-private");
    }
  } finally {
    delete globals.__retryAuthSeen; delete globals.__retryAuthFail;
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);
