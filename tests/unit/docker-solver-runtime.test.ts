import { afterEach, expect, test, vi } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DockerRuntime } from "../../src/infrastructure/containers/runtime.js";
import { PINNED_NODE_IMAGE, type DockerCommand } from "../../src/infrastructure/containers/runtime-contract.js";

type Build = { image: string; args: string[]; dockerfile: string; installation: { commands: unknown[]; probes: unknown[] }; probes: { commands: unknown[]; probes: unknown[] } };
const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const id = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
function docker(images = new Map<string, string>(), user = "") {
  const builds: Build[] = [];
  const command: DockerCommand = async args => {
    if (args[0] === "image" && args[1] === "inspect") {
      const image = args[4]!;
      if (args.at(-1)!.includes("RepoDigests")) return { stdout: `${PINNED_NODE_IMAGE.split("@")[1]} []\n`, stderr: "" };
      const digest = images.get(image);
      if (!digest) throw new Error(`No such image: ${image}`);
      if (args.at(-1) === "{{json .Config.User}}") return { stdout: JSON.stringify(user), stderr: "" };
      return { stdout: `${digest}\n`, stderr: "" };
    }
    if (args[0] === "image" && args[1] === "tag") {
      images.set(args[3]!, images.get(args[2]!)!);
      return { stdout: "", stderr: "" };
    }
    if (args[0] === "build") {
      const context = args.at(-1)!;
      const image = args[args.indexOf("--tag") + 1]!;
      builds.push({
        image,
        args: args.slice(0, -1),
        dockerfile: readFileSync(join(context, "Dockerfile"), "utf8"),
        installation: JSON.parse(readFileSync(join(context, "installation.json"), "utf8")),
        probes: JSON.parse(readFileSync(join(context, "probes.json"), "utf8")),
      });
      await new Promise(resolve => setTimeout(resolve, 20));
      images.set(image, id(image));
      return { stdout: "", stderr: "" };
    }
    throw new Error(`unexpected docker ${args.join(" ")}`);
  };
  return { command, builds, images, runtime: () => new DockerRuntime(command) };
}

async function installation() {
  const root = await mkdtemp(join(tmpdir(), "evaluator-solver-runtime-"));
  roots.push(root);
  await writeFile(join(root, "package.json"), '{"name":"fixture-runtime","version":"1.0.0"}');
  return {
    id: "fixture-runtime",
    files: [{ source: join(root, "package.json"), target: "package.json" }],
    commands: [{ executable: "npm", args: ["ci", "--omit=dev"] }],
    probes: [{ executable: "node", args: ["--version"] }],
  };
}


test("exports one final image per base and solver and preserves the install and probe stages", async () => {
  const fake = docker(new Map([["task-a", id("task-a")], ["task-b", id("task-b")]]), "1001:1002");
  const spec = await installation();
  const signal = AbortSignal.timeout(10000);
  const scope = { taskId: "first", phase: "solve" as const };
  const [first, other, shared] = await Promise.all([
    fake.runtime().prepare("task-a", [], signal, undefined, scope, spec),
    fake.runtime().prepare("task-b", [], signal, undefined, scope, spec),
    fake.runtime().prepare("task-a", [], signal, undefined, { ...scope, taskId: "second" }, spec),
  ]);
  expect(shared.image).toBe(first.image);
  expect(other.image).not.toBe(first.image);
  expect(fake.builds).toHaveLength(2);
  for (const build of fake.builds) {
    expect(build.image).toContain(":solve-agent-");
    expect(build.dockerfile).toContain("FROM evaluator_node AS solver_runtime");
    expect(build.dockerfile).toContain("COPY --from=solver_runtime /opt/evaluator-agent /opt/evaluator-agent");
    expect(build.dockerfile).toMatch(/USER 1001:1002[\s\S]*RUN \["\/usr\/local\/bin\/node", "\/opt\/evaluator\/install-runtime\.mjs"/u);
    expect(build.dockerfile).toContain("chmod 1777 /opt/evaluator-agent/state");
    expect(build.installation).toEqual({ commands: spec.commands, probes: spec.probes });
    expect(build.probes).toEqual({ commands: [], probes: spec.probes });
  }
  expect(first.installation).toMatchObject({ root: "/opt/evaluator-agent", stateRoot: "/opt/evaluator-agent/state", persistent: false });
  await fake.runtime().prepare("task-a", [], signal, undefined, scope, spec);
  expect(fake.builds).toHaveLength(2);
});

test("changing solver files or the platform creates a different final image", async () => {
  const fake = docker(new Map([["task", id("task")]]));
  const spec = await installation();
  const signal = AbortSignal.timeout(10000);
  const first = await fake.runtime().prepare("task", [], signal, undefined, undefined, spec);
  const file = spec.files[0]!;
  await writeFile(file.source, '{"name":"different"}');
  const changed = await fake.runtime().prepare("task", [], signal, undefined, undefined, spec);
  const arm = await new DockerRuntime(fake.command, PINNED_NODE_IMAGE, "linux/arm64").prepare("task", [], signal, undefined, undefined, spec);
  expect(new Set([first.image, changed.image, arm.image]).size).toBe(3);
});
