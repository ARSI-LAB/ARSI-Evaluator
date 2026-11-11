import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { runDockerCommand } from "../../src/infrastructure/containers/command.js";
import { DockerRuntime } from "../../src/infrastructure/containers/runtime.js";
import { PINNED_NODE_IMAGE, type DockerCommand } from "../../src/infrastructure/containers/runtime-contract.js";

test.skipIf(process.env.EVALUATOR_TEST_DOCKER !== "1")("Docker runtime supplies missing system CA roots and preserves existing bundles", async () => {
  const context = await mkdtemp(join(tmpdir(), "evaluator-runtime-ca-"));
  const name = `evaluator-ca-${randomUUID()}`;
  const existing = `${name}:existing`;
  const images: string[] = [];
  const signal = AbortSignal.timeout(120_000);
  const command: DockerCommand = (args, options) => runDockerCommand("docker", args, options);
  const runtime = new DockerRuntime(command);
  const scope = { taskId: name, phase: "solve" as const };
  const bundle = "/etc/ssl/certs/ca-certificates.crt";
  const readBundle = (image: string) => command([
    "run", "--rm", "--pull=never", "--network", "none", "--platform", runtime.platform,
    "--entrypoint", "/usr/local/bin/node", image, "-e",
    `process.stdout.write(require("node:fs").readFileSync(${JSON.stringify(bundle)}))`,
  ], { signal });
  try {
    const missing = await runtime.prepare(PINNED_NODE_IMAGE, [], signal, undefined, scope);
    images.push(missing.image);
    const generated = await readBundle(missing.image);
    expect(generated.stdout.match(/-----BEGIN CERTIFICATE-----/gu)?.length).toBeGreaterThan(1);

    const setup = [
      'const fs = require("node:fs");',
      'fs.mkdirSync("/etc/ssl/certs", { recursive: true });',
      `fs.writeFileSync(${JSON.stringify(bundle)}, require("node:tls").rootCertificates[0] + "\\n", { mode: 0o644 });`,
    ].join("\n");
    await writeFile(join(context, "Dockerfile"),
      `FROM ${PINNED_NODE_IMAGE}\nRUN ${JSON.stringify(["node", "-e", setup])}\nUSER 65534:65534\n`);
    await command(["build", "--platform", runtime.platform, "--tag", existing, context], { signal });
    images.push(existing);
    const original = await readBundle(existing);
    expect(original.stdout.match(/-----BEGIN CERTIFICATE-----/gu)).toHaveLength(1);

    const preserved = await runtime.prepare(existing, [], signal, undefined, scope);
    images.push(preserved.image);
    expect((await readBundle(preserved.image)).stdout).toBe(original.stdout);
  } finally {
    try {
      if (images.length) await command(["image", "rm", "--no-prune", ...images.reverse()], { signal: AbortSignal.timeout(30_000) });
    } finally {
      await rm(context, { recursive: true, force: true });
    }
  }
}, 150_000);
