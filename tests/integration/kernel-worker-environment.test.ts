import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { profileSingleKernel } from "../../src/plugins/benchmarks/operator/kernel/runtime/profile.js";
import { kernelBench, kernelPrecision } from "../../src/plugins/benchmarks/operator/kernel/runtime/cli.js";
import { NpuKernelBackend } from "../../src/plugins/benchmarks/operator/kernel/runtime/npu.js";
import { LocalEnvironment } from "../../src/plugins/environments/local/environment.js";

const python = process.env.PYTHON_BIN ?? "python3";
const linuxPython = process.platform === "linux" && spawnSync(python, ["--version"]).status === 0;
const signal = new AbortController().signal;

afterEach(() => vi.unstubAllEnvs());

// Run the packaged Python workers until they import the candidate. Only the hardware
// APIs and the msprof executable are substituted, so the child environment is real.
test.skipIf(!linuxPython).each(["sdk-evaluate", "sdk-profile", "precision", "bench", "profile"] as const)(
  "%s passes only runtime settings and explicit overrides to candidate processes", async operation => {
    await mkdir(".scratch", { recursive: true });
    const root = await mkdtemp(resolve(".scratch/kernel-env-"));
    const observation = join(root, "candidate-env.json");
    const msprofObservation = join(root, "msprof-env.json");
    const problem = join(root, "problem.py");
    const kernel = join(root, "candidate.py");
    const msprof = join(root, "msprof");
    const out = join(root, "out.json");
    const sdk = operation.startsWith("sdk");
    const profiling = operation.endsWith("profile");
    const keys = ["ASCEND_HOME_PATH", "ASCEND_OPP_PATH", "TOOLCHAIN_HOME", "ASCEND_RT_VISIBLE_DEVICES", "KERNEL_NPU_DEVICE",
      "OPENAI_API_KEY", "ASCEND_PRIVATE_TOKEN", "HTTPS_PROXY", "MY_KERNEL_SETTING"];
    const probe = `{k: os.environ.get(k) for k in ${JSON.stringify(keys)}}`;
    vi.stubEnv("KERNEL_ATOM_DIR", resolve("src/plugins/benchmarks/operator/kernel/runtime"));
    vi.stubEnv("OPENAI_API_KEY", "fixture-key");
    vi.stubEnv("ASCEND_PRIVATE_TOKEN", "fixture-token");
    vi.stubEnv("HTTPS_PROXY", "http://fixture:password@localhost");
    vi.stubEnv("ASCEND_HOME_PATH", "/fixture/cann");
    vi.stubEnv("ASCEND_OPP_PATH", "/fixture/opp");
    vi.stubEnv("TOOLCHAIN_HOME", "/fixture/compiler");
    vi.stubEnv("ASCEND_RT_VISIBLE_DEVICES", "0,1,2");
    vi.stubEnv("MY_KERNEL_SETTING", "ambient");
    vi.stubEnv("PYTHONPATH", sdk ? root : join(root, "ambient-python"));
    vi.stubEnv("PYTHONDONTWRITEBYTECODE", "1");
    try {
      await writeFile(join(root, "torch.py"), "from types import SimpleNamespace\nnpu = SimpleNamespace(is_available=lambda: True, set_device=lambda device: None)\n");
      await writeFile(join(root, "torch_npu.py"), "");
      await writeFile(join(root, "mstx.py"), "def get_tool_id(): return 0x1001\n");
      await writeFile(problem, "class Model: pass\n");
      await writeFile(kernel, `import json, os\nfrom pathlib import Path\nPath(${JSON.stringify(observation)}).write_text(json.dumps(${probe}))\nraise RuntimeError("fixture stopped after import")\n`);
      await writeFile(msprof, `#!/usr/bin/env python3
import json, os, shlex, subprocess, sys
from pathlib import Path
Path(${JSON.stringify(msprofObservation)}).write_text(json.dumps(${probe}))
app = next(s.split("=", 1)[1] for s in sys.argv if s.startswith("--application="))
keep = os.environ["PRESERVE_ENV"].split(",")
sys.exit(subprocess.call(shlex.split(app), env={k: os.environ[k] for k in keep if k in os.environ}))
`, { mode: 0o755 });
      if (sdk) {
        const backend = new NpuKernelBackend({ python, device: 3,
          profiling: { enabled: profiling, roundNum: 1, msprofBin: msprof, maxAttempts: 1, cacheEnabled: false } });
        const sessionFiles = [{ source: problem, target: "data/problem.py" }, { source: kernel, target: "data/candidate/kernel.py" },
          ...backend.runtimeFiles().map(({ origin, path }) => ({ source: origin, target: path }))];
        const session = await new LocalEnvironment(root).prepare({ workdir: ".", image: null, runtime: [], env: backend.environment(), initialFiles: sessionFiles },
          { root, agent: join(root, "agent"), verifier: join(root, "verifier"), artifacts: join(root, "artifacts") }, "solve", signal);
        try {
          const hashes = Object.fromEntries(await Promise.all(sessionFiles.map(async ({ source, target }) =>
            [target, createHash("sha256").update(await readFile(source)).digest("hex")] as const)));
          await backend.execute({ operation: profiling ? "profile" : "evaluate", candidateSha256: hashes["data/candidate/kernel.py"],
            problem: "data/problem.py", candidate: "data/candidate/kernel.py", candidateRoot: "data/candidate", dataRoot: "data", hashes, seeds: [0], referenceKind: "pytorch" },
          session, signal);
        } finally { await session.dispose(signal); }
      } else {
        const options = { python, device: 2, env: { MY_KERNEL_SETTING: "explicit", ASCEND_HOME_PATH: "/override/cann", PYTHONPATH: root } };
        const args = { problem, kernel, out };
        if (operation === "precision") await kernelPrecision(args, options);
        else if (operation === "bench") await kernelBench(args, options);
        else await profileSingleKernel({ ...args, round: 1, cacheEnabled: false, maxAttempts: 1, msprofBin: msprof }, options);
      }
      const expected = { ASCEND_HOME_PATH: sdk ? "/fixture/cann" : "/override/cann", ASCEND_OPP_PATH: "/fixture/opp", TOOLCHAIN_HOME: "/fixture/compiler",
        ASCEND_RT_VISIBLE_DEVICES: sdk ? "3" : "0,1,2", KERNEL_NPU_DEVICE: sdk ? "0" : "2",
        OPENAI_API_KEY: null, ASCEND_PRIVATE_TOKEN: null, HTTPS_PROXY: null, MY_KERNEL_SETTING: sdk ? null : "explicit" };
      if (profiling) expect(JSON.parse(await readFile(msprofObservation, "utf8"))).toEqual(expected);
      expect(JSON.parse(await readFile(observation, "utf8"))).toEqual(expected);
    } finally { await rm(root, { recursive: true, force: true }); }
  },
);
