import {mkdtemp, mkdir, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {expect, test, vi} from "vitest";
import {DockerComposeProject} from "../../src/infrastructure/containers/compose.js";
import type {DockerCommand} from "../../src/infrastructure/containers/runtime-contract.js";

// Replace only Docker's executable/arguments with a harmless real child. The
// production host cwd and process/pipe lifecycle still cross the OS boundary.
vi.mock("../../src/infrastructure/process/local.js", async importOriginal => {
  const original = await importOriginal<typeof import("../../src/infrastructure/process/local.js")>();
  return {...original, startLocalProcess: (...[command, signal, options]: Parameters<typeof original.startLocalProcess>) =>
    original.startLocalProcess({...command, executable: process.execPath,
      args: ["-e", "process.stdout.write('sidecar-started')"]}, signal, options)};
});

test("sidecar collection starts when the stored attempt path exceeds Windows MAX_PATH", async () => {
  const root = await mkdtemp(join(tmpdir(), "compose-exec-cwd-"));
  const attempt = join(root, ...Array.from({length:8}, (_,i) => `attempt-metadata-${i}-` + "a".repeat(25)));
  try {
    await mkdir(attempt, {recursive:true});
    expect(attempt.length).toBeGreaterThan(350);
    const command: DockerCommand = async args => ({
      stdout: args.includes("ps") ? "a".repeat(64) : args[0] === "image" ? "null" : "", stderr:"",
    });
    const project = new DockerComposeProject(command, process.execPath,
      {image:"fixture", workdir:"/app", initialFiles:[], runtime:[], services:{api:{image:"api:locked",properties:{}}}},
      {root:attempt, agent:attempt, verifier:attempt, artifacts:attempt},
      {runId:"run", taskId:"task", attemptId:"attempt"}, "solve");
    const signal = AbortSignal.timeout(15000);
    await project.create({image:"main:locked",command:["node","idle.mjs"]}, {api:"api:locked"}, {}, signal);
    const handle = await project.start("api", {executable:"sh",args:["collect.sh"],cwd:"/app",env:{},input:null}, signal);
    const read = async () => {
      const chunks:Uint8Array[]=[];
      for await(const chunk of handle.stdout) chunks.push(chunk);
      return Buffer.concat(chunks).toString("utf8");
    };
    const [output,exit] = await Promise.all([read(),handle.done]);
    expect(exit.code).toBe(0);
    expect(output).toBe("sidecar-started");
  } finally {
    expect(root.startsWith(join(tmpdir(),"compose-exec-cwd-"))).toBe(true);
    await rm(root, {recursive:true,force:true});
  }
}, 20000);
