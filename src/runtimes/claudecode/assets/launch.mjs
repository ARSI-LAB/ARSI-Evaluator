import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { startMessagesRelay } from "./messages-relay.mjs";

const [home, entry, ...args] = process.argv.slice(2);
const { apiKey, prompt, baseUrl, model, maxTokens, contextWindow, media = [] } = JSON.parse(readFileSync(0, "utf8"));
await mkdir(home, { mode: 0o700 });
let relay;
try {
  const shellPrefix = join(home, "shell");
  // Claude Code requires nested PID namespaces for its Linux env scrub.
  // The standard task container does not grant those permissions.
  if (process.platform === "linux") {
    relay = await startMessagesRelay(baseUrl, apiKey);
    // The CLI passes the entire Bash command as one argument to the prefix.
    await writeFile(shellPrefix, '#!/bin/sh\nunset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN ANTHROPIC_BASE_URL\nexec /bin/bash -c "$1"\n',
      { mode: 0o700 });
  }
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    !/^(?:ANTHROPIC_|CLAUDE_|DISABLE_(?:UPDATES|AUTOUPDATER|TELEMETRY|ERROR_REPORTING)$)/iu.test(name)));
  const noProxy = [env.NO_PROXY ?? env.no_proxy, "127.0.0.1"].filter(Boolean).join(",");
  if (media.length) args.push("--input-format", "stream-json");
  const cli = spawn(entry, args, {
    env: {
      ...env, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: join(home, ".claude"),
      ...(process.env.CLAUDE_CODE_GIT_BASH_PATH === undefined ? {} : { CLAUDE_CODE_GIT_BASH_PATH: process.env.CLAUDE_CODE_GIT_BASH_PATH }),
      ANTHROPIC_API_KEY: relay?.key ?? apiKey, ANTHROPIC_BASE_URL: relay?.endpoint ?? baseUrl, ANTHROPIC_MODEL: model,
      ANTHROPIC_DEFAULT_OPUS_MODEL: model, ANTHROPIC_DEFAULT_SONNET_MODEL: model, ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
      CLAUDE_CODE_SUBAGENT_MODEL: model, CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: "1",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      ...(relay ? {
        NO_PROXY: noProxy, no_proxy: noProxy,
        CLAUDE_CODE_SHELL_PREFIX: shellPrefix,
      } : { CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "1" }),
      DISABLE_UPDATES: "1", DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1",
      ...(maxTokens === undefined ? {} : { CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(maxTokens) }),
      ...(contextWindow === undefined ? {} : { CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(contextWindow) }),
    },
    stdio: ["pipe", "inherit", "inherit"],
    windowsHide: true,
  });
  const exited = new Promise((resolve, reject) => {
    cli.once("error", reject);
    cli.once("close", code => resolve(code ?? 1));
    cli.stdin.on("error", error => {
      if (error.code !== "EPIPE") reject(error);
    });
  });
  const terminate = () => { cli.kill("SIGTERM"); };
  process.once("SIGTERM", terminate);
  try {
    const content = [{ type: "text", text: prompt }, ...media.map(({ name, mediaType, data }) => ({
      ...(mediaType === "application/pdf" ? { type: "document", title: name } : { type: "image" }),
      source: { type: "base64", media_type: mediaType, data },
    }))];
    cli.stdin.end(media.length ? JSON.stringify({
      type: "user", message: { role: "user", content }, parent_tool_use_id: null, session_id: "",
    }) + "\n" : prompt, "utf8");
    process.exitCode = await exited;
  } finally {
    process.removeListener("SIGTERM", terminate);
  }
} finally {
  relay?.close();
  await rm(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
