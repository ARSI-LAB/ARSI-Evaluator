import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export async function writeFixture(root: string, files: Record<string, string>): Promise<void> {
  for (const [relative, content] of Object.entries(files)) {
    const file = join(root, relative);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, content);
  }
}
