import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export async function lockedCliPatch(name: "codebuddy" | "kimicode" | "minimaxcode") {
  const source = fileURLToPath(new URL(`../${name}/assets/capability-patch.json`, import.meta.url));
  const digest = createHash("sha256").update(await readFile(source)).digest("hex");
  return {
    digest,
    files: [
      { source, target: "capability-patch.json" },
      { source: fileURLToPath(new URL("./assets/apply-capability-patch.mjs", import.meta.url)), target: "apply-capability-patch.mjs" },
    ],
    command: { executable: "node", args: ["apply-capability-patch.mjs"] },
  };
}
