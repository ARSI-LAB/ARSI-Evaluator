import { homedir } from "node:os";
import { join } from "node:path";

export function configurationEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const cache = env.XDG_CACHE_HOME ?? (process.platform === "win32" ? env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local") : join(homedir(), ".cache"));
  return { ...env, EVALUATOR_CACHE_DIR: env.EVALUATOR_CACHE_DIR ?? join(cache, "arsi-evaluator") };
}
