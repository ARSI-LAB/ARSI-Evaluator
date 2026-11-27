import { modelWithLimits, type AgentLimits } from "./agent-limits.js";
import { pickSolverToolPolicy } from "../../core/validation/solver-tool-policy.js";
import type { Context } from "@deepseek-ai/cordis";
import { SimpleAgentSolver, parseSimpleAgentConfig } from "./simpleagent.js";
import { ChoiceLogprobsSolver, parseChoiceLogprobsConfig } from "./choice-logprobs.js";
import { AgentBundleSolver, parseAgentBundleConfig } from "./agentbundle.js";
import { expectRecord, rejectUnknown } from "../../core/validation/input.js";
import { bindSolverService, type PluginFactoryContext } from "../../core/contracts/plugin.js";
import { AgentXReplaySolver, parseAgentXReplayConfig } from "./agentx-replay.js";
import { registerTelemetryMsprof } from "./telemetry-msprof.js";
import { KernelReplaySolver } from "./kernel-replay.js";
import { CodexSolver, parseCodexConfig } from "./codex.js";
import { ClaudeCodeSolver, parseClaudeCodeConfig } from "./claudecode.js";
import { ZCodeSolver, parseZCodeConfig } from "./zcode.js";
import { TraeSolver, parseTraeConfig } from "./trae.js";
import { CodeBuddySolver, parseCodeBuddyConfig } from "./codebuddy.js";
import { NativeCodeSolver, parseNativeCodeConfig } from "./native-code.js";

function solverArgs<T extends AgentLimits>(runtime: PluginFactoryContext, config: T) {
  const bound = bindSolverService(runtime);
  const { maxTokens, contextWindow, ...options } = config;
  return [{ ...bound, model: modelWithLimits(bound.model, config) }, options] as const;
}

export function apply(ctx: Context): void {
  registerTelemetryMsprof(ctx);
  for (const name of ["qwencode", "kimicode", "minimaxcode", "opencode"] as const) {
    ctx.evaluator.register("solver", name, value => parseNativeCodeConfig(name, value),
      (config, runtime) => new NativeCodeSolver(name, ...solverArgs(runtime, config)));
  }
  ctx.evaluator.register("solver", "claudecode", parseClaudeCodeConfig, (config, runtime) => new ClaudeCodeSolver(...solverArgs(runtime, config)));
  ctx.evaluator.register("solver", "codex", parseCodexConfig, (config, runtime) => new CodexSolver(...solverArgs(runtime, config)));
  ctx.evaluator.register("solver", "zcode", parseZCodeConfig, (config, runtime) => new ZCodeSolver(...solverArgs(runtime, config)));
  ctx.evaluator.register("solver", "trae", parseTraeConfig, (config, runtime) => new TraeSolver(...solverArgs(runtime, config)));
  ctx.evaluator.register("solver", "codebuddy", parseCodeBuddyConfig, (config, runtime) => new CodeBuddySolver(...solverArgs(runtime, config)));
  ctx.evaluator.register("solver", "choice-logprobs", parseChoiceLogprobsConfig, (config, runtime) => {
    const { model, auth } = bindSolverService(runtime);
    return new ChoiceLogprobsSolver(config, model, auth, runtime.environmentName);
  });
  ctx.evaluator.register("solver", "kernel-replay", (value: unknown) => {
    const config = expectRecord(value, "kernel-replay");
    rejectUnknown(config, [], "kernel-replay");
    return {};
  }, () => new KernelReplaySolver());
  ctx.evaluator.register("solver", "agentx-replay", parseAgentXReplayConfig, (config, runtime) => new AgentXReplaySolver(config, runtime));
  ctx.evaluator.register(
    "solver",
    "agentbundle",
    parseAgentBundleConfig,
    (config, runtime) => {
      const bound = bindSolverService(runtime);
      const solver = new AgentBundleSolver(runtime.resolvePath(config.path), bound.model, bound.auth, undefined, {
        limits: {
          ...(config.maxTokens === undefined ? {} : { maxTokens: config.maxTokens }),
          ...(config.maxTurns === undefined ? {} : { maxTurns: config.maxTurns }),
          ...(config.contextWindow === undefined ? {} : { contextWindow: config.contextWindow }),
        },
        environmentName: runtime.environmentName ?? "local",
        ...pickSolverToolPolicy(config),
        ...(config.dshhome === undefined ? {} : { dshhome: runtime.resolvePath(config.dshhome) }),
        ...(config.dshprofile === undefined ? {} : { dshprofile: runtime.resolvePath(config.dshprofile) }),
        ...(config.hermeshome === undefined ? {} : { hermeshome: runtime.resolvePath(config.hermeshome) }),
        ...(config.jiuwenswarmTimeoutSeconds === undefined ? {} : { jiuwenswarmTimeoutSeconds: config.jiuwenswarmTimeoutSeconds }),
        ...(config.pi === undefined ? {} : { pi: config.pi }),
        ...(config.dify === undefined ? {} : { dify: {
          ...config.dify,
          ...(config.dify.registryPath === undefined ? {} : { registryPath: runtime.resolvePath(config.dify.registryPath) }),
        } }),
      }, runtime.network);
      ctx.effect(() => () => solver.dispose(), "AgentBundle staging lifecycle");
      return solver;
    },
  );
  ctx.evaluator.register(
    "solver",
    "simpleagent",
    parseSimpleAgentConfig,
    (config, runtime) => {
      const bound = bindSolverService(runtime);
      const solver = new SimpleAgentSolver(
        modelWithLimits(bound.model, config),
        bound.auth,
        config.bundle === undefined
          ? undefined
          : {
              path: runtime.resolvePath(config.bundle.path),
              ...(config.bundle.settings === undefined ? {} : { settings: config.bundle.settings }),
            },
        config.toolPolicy,
        {
          ...pickSolverToolPolicy(config),
          ...(config.bundle?.webSearchTools === undefined ? {} : { webSearchTools: config.bundle.webSearchTools }),
          ...(config.bundle?.webFetchTools === undefined ? {} : { webFetchTools: config.bundle.webFetchTools }),
        },
      );
      ctx.effect(() => () => solver.dispose(), "simpleagent staging lifecycle");
      return solver;
    },
  );
}
