import { createHash, randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const definition = await readFile("capability-patch.json");
const patch = JSON.parse(definition);
const root = join("node_modules", patch.package);
const installed = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
if (installed.name !== patch.package || installed.version !== patch.version) {
  throw new Error(`Expected ${patch.package}@${patch.version}, found ${installed.name}@${installed.version}`);
}

async function replaceFile(path, content) {
  const temporary = path + "." + randomUUID() + ".tmp";
  try {
    await writeFile(temporary, content, { flag: "wx" });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

for (const file of patch.files) {
  const path = join(root, file.path);
  const bytes = await readFile(path);
  const current = sha256(bytes);
  if (current === file.afterSha256) continue;
  if (current !== file.beforeSha256) throw new Error(`Unrecognized upstream file: ${path} (sha256:${current})`);
  let content = bytes.toString("utf8");
  for (const { before, after } of file.replacements) {
    const index = content.indexOf(before);
    if (index < 0 || content.indexOf(before, index + before.length) !== -1) throw new Error(`Patch context mismatch: ${path}`);
    content = content.slice(0, index) + after + content.slice(index + before.length);
  }
  if (sha256(content) !== file.afterSha256) throw new Error(`Patched file digest mismatch: ${path}`);
  await replaceFile(path, content);
}
const receipt = {
  package: installed.name, version: installed.version, patchSha256: sha256(definition),
  files: patch.files.map(({ path, beforeSha256, afterSha256 }) => ({ path, beforeSha256, afterSha256 })),
};
await replaceFile("capability-patch-receipt.json", JSON.stringify(receipt, null, 2) + "\n");
