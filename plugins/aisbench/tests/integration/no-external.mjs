import childProcess from "node:child_process";
import { appendFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";

function deny(operation) {
  if (process.env.AISBENCH_TEST_EXTERNAL_LOG) appendFileSync(process.env.AISBENCH_TEST_EXTERNAL_LOG, `${operation}\n`);
  throw new Error(`Unexpected external operation: ${operation}`);
}

// Keep the real CLI in a child Node process; reject SSH and every other subprocess.
for (const name of ["spawn", "spawnSync", "execFile", "execFileSync"]) {
  const original = childProcess[name];
  childProcess[name] = function (executable, ...args) {
    if (executable !== process.execPath) return deny(`${name}: ${executable}`);
    return original.call(this, executable, ...args);
  };
}
for (const name of ["exec", "execSync", "fork"]) childProcess[name] = () => deny(name);
globalThis.fetch = () => deny("fetch");
syncBuiltinESMExports();
