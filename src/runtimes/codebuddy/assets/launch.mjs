import { spawn } from "node:child_process";
import { readFileSync, writeSync } from "node:fs";
import { lstat, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { startModelRelay } from "./model-relay.mjs";

const [home, entry] = process.argv.slice(2);
const { apiKey, api, baseUrl, model, maxTokens, supportsImages, prompt, token, media, toolPolicy = {} } = JSON.parse(readFileSync(0, "utf8"));

// The model loader in CodeBuddy 2.183.0 reads this file independently of --setting-sources.
const projectModels = await lstat(join(process.cwd(), ".codebuddy", "models.json")).catch(error => {
  if (error.code === "ENOENT") return undefined;
  throw error;
});
if (projectModels) {
  writeSync(1, JSON.stringify({ type: "evaluator.config_error", message: "CodeBuddy cannot run with a workspace .codebuddy/models.json because it can override the selected model service" }) + "\n");
  process.exit(1);
}

await mkdir(home, { mode: 0o700 });
let relay;
try {
  relay = await startModelRelay({ api, baseUrl, apiKey, token });
  await writeFile(join(home, "models.json"), JSON.stringify({
    models: [{
      id: model, name: model, vendor: "openai", api, apiKey: token,
      url: api === "openai-completions" ? relay.endpoint + "/chat/completions" : relay.endpoint,
      supportsToolCall: true, supportsImages,
      ...(maxTokens === undefined ? {} : { maxOutputTokens: maxTokens }),
    }],
    availableModels: [model],
  }), { mode: 0o600 });

  const windows = process.platform === "win32";
  const tools = toolPolicy.tools === "none" ? [] : ["Read", "Edit", "Write", "Glob", "Grep", windows ? "PowerShell" : "Bash"];
  if (toolPolicy.webSearch === "enabled") tools.push("WebSearch");
  if (toolPolicy.webFetch === "enabled") tools.push("WebFetch");
  const denied = [];
  if (toolPolicy.webSearch === "disabled") denied.push("WebSearch");
  if (toolPolicy.webFetch === "disabled") denied.push("WebFetch");
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(?:CODEBUDDY_|WORKBUDDY_|CLAUDE_|ANTHROPIC_|OTEL_)/iu.test(name)));
  const noProxy = [env.NO_PROXY ?? env.no_proxy, "127.0.0.1"].filter(Boolean).join(",");
  const child = spawn(process.execPath, [entry,
    "--print", "--verbose", "--output-format", "stream-json", "--input-format", "stream-json", "--model", model,
    "--setting-sources", "user", "--strict-mcp-config", "--no-session-persistence",
    "--tools", tools.join(","), "--permission-mode", "dontAsk",
    ...(tools.length ? ["--allowedTools", ...tools] : []),
    ...(denied.length ? ["--disallowedTools", ...denied] : []),
  ], {
    env: {
      ...env, HOME: home, USERPROFILE: home, CODEBUDDY_CONFIG_DIR: home, CODEBUDDY_PROJECT_CONFIG_DIR: join(home, "project"),
      ...(windows ? { TEMP: home, TMP: home, CODEBUDDY_SKIP_GIT_BASH_CHECK: "1" } : {}),
      CODEBUDDY_CODE_SHELL: windows ? "powershell" : "bash", DISABLE_AUTOUPDATER: "1", DISABLE_TELEMETRY: "1",
      CODEBUDDY_CODE_DISABLE_BACKGROUND_TASKS: "1", CODEBUDDY_CODE_DISABLE_SESSION_TITLE_REFRESH: "1",
      CODEBUDDY_DISABLE_AUTO_MEMORY: "1", CODEBUDDY_DISABLE_BUILTIN_MODELS: "1",
      NO_PROXY: noProxy, no_proxy: noProxy,
    },
    stdio: ["pipe", "inherit", "inherit"], windowsHide: true,
  });
  const exited = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", code => resolve(code ?? 1));
    child.stdin.on("error", error => {
      if (error.code !== "EPIPE") reject(error);
    });
  });
  const terminate = () => child.kill("SIGTERM");
  process.once("SIGTERM", terminate);
  try {
    const content = [{ type: "text", text: prompt }, ...media.map(({ mediaType, data }) => ({
      type: "image", source: { type: "base64", media_type: mediaType, data },
    }))];
    child.stdin.end(JSON.stringify({ type: "user", message: { role: "user", content } }) + "\n", "utf8");
    process.exitCode = await exited;
  } finally {
    process.removeListener("SIGTERM", terminate);
  }
} finally {
  relay?.close();
  await rm(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
