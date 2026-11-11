import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const extensions = {
  "image/png": "png",
  "image/jpeg": "jpeg",
  "image/webp": "webp",
  "application/pdf": "pdf",
};

export async function stageAttachments(home, media) {
  if (!media.length) return [];
  const directory = join(home, "attachments");
  await mkdir(directory, { mode: 0o700 });
  const paths = [];
  for (const [index, { mediaType, data }] of media.entries()) {
    const file = join(directory, `attachment-${index + 1}.${extensions[mediaType]}`);
    await writeFile(file, Buffer.from(data, "base64"), { flag: "wx", mode: 0o600 });
    paths.push(file);
  }
  return paths;
}
