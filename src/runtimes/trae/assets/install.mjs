import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";

const root = import.meta.dirname;
const lock = JSON.parse(await readFile(join(root, "release-lock.json"), "utf8"));
const platform = `${process.platform}-${process.arch}`;
const artifacts = lock.platforms[platform];
if (!artifacts) throw new Error(`TRAE CLI ${lock.version} does not support ${platform} in Evaluator`);

for (const { source, target, size, sha256, member } of artifacts) {
  const destination = join(root, target);
  const archive = `${destination}.download`;
  await mkdir(dirname(destination), { recursive: true });
  try {
    const response = await fetch(new URL(source, lock.baseUrl), { signal: AbortSignal.timeout(600_000) });
    if (!response.ok || !response.body) throw new Error(`TRAE download ${source} failed with HTTP ${response.status}`);
    const hash = createHash("sha256");
    let bytes = 0;
    const verify = new Transform({
      transform(chunk, _encoding, callback) {
        bytes += chunk.length;
        if (bytes > size) return callback(new Error(`TRAE archive ${source} exceeds its locked size`));
        hash.update(chunk);
        callback(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(response.body), verify, createWriteStream(archive, { flags: "wx" }));
    if (bytes !== size || hash.digest("hex") !== sha256) throw new Error(`TRAE archive ${source} failed size or SHA-256 verification`);
    if (member) {
      const binary = execFileSync("tar", ["-xOzf", archive, "--", member]);
      await writeFile(destination, binary, { flag: "wx", mode: 0o755 });
    } else {
      await pipeline(createReadStream(archive), createGunzip(), createWriteStream(destination, { flags: "wx", mode: 0o755 }));
    }
  } finally {
    await rm(archive, { force: true });
  }
}

await writeFile(join(root, "trae-installation.json"), JSON.stringify({ channel: "public", release_channel: "stable", auto_update: false }) + "\n", { flag: "wx" });
