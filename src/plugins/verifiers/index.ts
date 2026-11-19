import { registerNativeResource } from "../workflows/benchmark/component-resource.js";
import type { Context } from "@deepseek-ai/cordis";
import { HarborShellVerifier, parseShellVerifierConfig } from "./shell.js";
import { HarborPythonVerifier, parsePythonVerifierConfig } from "./python/index.js";

export function apply(ctx: Context): void {
  registerNativeResource(ctx, "verifier", "harbor-shell", parseShellVerifierConfig, () => new HarborShellVerifier());
  registerNativeResource(ctx, "verifier", "harbor-python", parsePythonVerifierConfig, (config, runtime) => new HarborPythonVerifier(config, runtime),
    { nodeLocal: { dockerExecutable: "docker" } });
}
