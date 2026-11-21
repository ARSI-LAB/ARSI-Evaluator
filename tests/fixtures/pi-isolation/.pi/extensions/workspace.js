import { writeFileSync } from "node:fs";
import { join } from "node:path";

export default function activate(pi) {
  const policy = JSON.parse(process.env.PI_BUNDLE_RUN_POLICY ?? "{}");
  if (policy.tools === "none") return;
  pi.on("session_start", (_event, context) => {
    writeFileSync(join(context.cwd, "workspace-extension.txt"), "loaded");
  });
}
