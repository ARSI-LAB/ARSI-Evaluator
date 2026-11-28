import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";
import { bundleComposeOverride } from "../../scripts/ray-smoke/ensure.mjs";

const command = promisify(execFile);
// Run with the checkout mounted at the identical host path and access to an isolated Docker test project.
test.skipIf(process.env.EVALUATOR_BUNDLE_MOUNT_TESTS !== "1")("Docker mounts multiple bundles read-only and removes deleted mounts", async () => {
  const scratch = resolve(".scratch"); await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, "bundle-mounts-"));
  const name = `bundle-test-${Date.now()}`, base = join(root, "base.json");
  const image = process.env.EVALUATOR_BUNDLE_TEST_IMAGE ?? "arsi-workflow-validation:20261110";
  let override = "";
  const compose = (...args: string[]) => command("docker", ["compose", "-p", name, "-f", base, "-f", override, ...args], { timeout: 60_000 });
  try {
    const first = join(root, "first $BUNDLE_TEST_UNDEFINED"), second = join(root, "other-parent", "second");
    for (const [path, content] of [[first, "first"], [second, "second"]] as const) {
      await mkdir(path, { recursive: true }); await writeFile(join(path, "bundle.yaml"), content);
    }
    await writeFile(base, JSON.stringify({ services: Object.fromEntries(["head", "worker-a", "worker-b"].map(name => [name,
      { image, entrypoint: ["node"], command: ["-e", "setInterval(()=>{}, 1000)"], network_mode: "none" }])) }));
    override = (await bundleComposeOverride({ first, second }, root)).path;
    await compose("up", "-d", "--wait");
    const probe = "const f=require('node:fs'); for(const [n,v] of [['first','first'],['second','second']]) { const p='/builtin-experiment/bundles/'+n+'/bundle.yaml'; if(f.readFileSync(p,'utf8')!==v) throw Error('wrong bundle'); try { f.writeFileSync(p,'changed'); throw Error('writable bundle'); } catch(e) { if(e.code!=='EROFS') throw e; } }";
    for (const service of ["head", "worker-a", "worker-b"]) await compose("exec", "-T", service, "node", "-e", probe);
    override = (await bundleComposeOverride({ first }, root)).path;
    await compose("up", "-d", "--wait");
    for (const service of ["head", "worker-a", "worker-b"]) await compose("exec", "-T", service, "node", "-e",
      "const f=require('node:fs'); if(f.existsSync('/builtin-experiment/bundles/second')) throw Error('stale mount'); if(f.readFileSync('/builtin-experiment/bundles/first/bundle.yaml','utf8')!=='first') throw Error('missing bundle');");
    expect(await readFile(join(second, "bundle.yaml"), "utf8")).toBe("second");
  } finally {
    try { if (override) await compose("down", "--remove-orphans"); }
    finally { await rm(root, { recursive: true, force: true }); }
  }
}, 150_000);
