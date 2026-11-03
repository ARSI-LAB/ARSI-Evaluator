# Installation and Deployment

> English | [中文](./installation.zh-CN.md)

This guide covers source installation, the AgentBundle prerequisite build, global CLI registration, and running from other directories.

[Project home](../../README.md) · [User guide](README.md)

## Install from Source

Requires Node.js **24.22.1 or later 24.x**, Corepack, Git, and pnpm **11.22.0**. Without a proxy, downloads use Node.js built-in `fetch()`; updating project dependencies does not update the undici bundled with older Node.js versions. Update Node.js locally and on Ray nodes. Commands below use Linux/WSL Bash. In WSL, install, build, and run in the same WSL environment.

Prepare two sibling repositories:

```text
/path/to/workspace/
├── AgentBundle/
│   └── packages/core/
└── ember-evaluator/
```

The current [pnpm-workspace.yaml](../../pnpm-workspace.yaml) overrides `agent-bundle-core` with `../AgentBundle/packages/core` and `agentbundle-workspace` with `../AgentBundle/packages/cli`. Prepare the sibling AgentBundle source and build core before installation. Evaluator loads this SDK even with `simpleagent`. This source repository differs from Solver `AGENT_BUNDLE_PATH`, which points to the agent bundle under evaluation.

If AgentBundle is not present, clone it from the parent directory; skip this if it already exists:

```bash
cd '/path/to/workspace'
git clone ssh://git@gitcode.com/evanTang/AgentBundle.git AgentBundle
```

Cloning requires read access to the GitCode repository. AgentBundle currently declares no `packageManager`; Evaluator pins `pnpm@11.22.0`. Explicitly use `corepack pnpm@11.22.0` in both repositories to avoid version changes between directories. Check your tools:

```bash
node --version
corepack pnpm@11.22.0 --version
```

If `corepack` is missing, run `npm install --global corepack` first. Replace the parent path below, then install and build in order:

```bash
cd '/path/to/workspace/AgentBundle' && \
corepack pnpm@11.22.0 install --frozen-lockfile && \
corepack pnpm@11.22.0 --filter agent-bundle-core build && \
cd '../ember-evaluator' && \
corepack pnpm@11.22.0 install --frozen-lockfile && \
corepack pnpm@11.22.0 build && \
node dist/cli.js --help
```

Evaluator installation builds once through `prepare`; the explicit `build` checks the final artifacts. Build AgentBundle core first. Source without `packages/core/lib` may cause missing `agent-bundle-core` or type declaration errors.

After updating AgentBundle, rebuild core before Evaluator. If Evaluator dependencies are already installed, run Terminal-Bench 4.0 from the Evaluator root in this order:

```bash
cd '../AgentBundle' && \
corepack pnpm@11.22.0 install --frozen-lockfile && \
corepack pnpm@11.22.0 --filter agent-bundle-core build && \
cd '../ember-evaluator' && \
corepack pnpm@11.22.0 build && \
node dist/cli.js run playbook/terminalbench/terminalbench-4.0.yaml
```

Set YAML model variables in the same terminal and prepare Docker or other task requirements. See [model variables](quick-start.md#3-set-model-variables), [Harbor](benchmarks/harbor.md), and [Playbook](../../playbook/README.md). Install and build on initial setup or relevant code/dependency changes; repeating them before every evaluation is unnecessary.

For development, run `corepack pnpm@11.22.0 typecheck` and `corepack pnpm@11.22.0 test --run`. After building, create a package with `corepack pnpm@11.22.0 pack --pack-destination .scratch/packages`.

## Register the Global CLI

After building both repositories, register the command from the **Evaluator repository root**:

```bash
corepack pnpm@11.22.0 add -g .
ember-evaluator --help
```

If the global bin directory is unset, missing from PATH, or `ember-evaluator` cannot be found, run:

```bash
corepack pnpm@11.22.0 setup
```

Reopen the terminal or reload shell configuration as instructed, then retry registration in the Evaluator repository. pnpm 11 uses `$PNPM_HOME/bin` for global commands. Check it with `corepack pnpm@11.22.0 bin -g`; see [pnpm global packages](https://pnpm.io/global-packages#registering-local-packages-globally).

This registers the local project's `bin` entry for use outside the source directory. Keep the local Evaluator, sibling AgentBundle, and installed dependencies. No npm publication is required, and the source directories must remain available.

## Run from Any Directory

After registration, run outside the source directory within the same environment, such as the same WSL instance, using an absolute configuration path:

```bash
cd ~
ember-evaluator doctor '/path/to/config.yaml'
ember-evaluator run '/path/to/config.yaml'
```

You can also run a repository example directly:

```bash
ember-evaluator run '/path/to/workspace/ember-evaluator/playbook/terminalbench/terminalbench-4.0.yaml'
```

Relative `output.directory`, bundle paths, and other YAML paths are based on the **YAML directory**, regardless of the current directory. Check them after copying YAML elsewhere. CLI `--patch` is relative to the current working directory; prefer absolute paths when running elsewhere. Set model variables in that terminal and ensure the machine meets Docker and harness requirements.

## Local Runtime Cache and Windows Path Length

For local environments, Evaluator prepares separate runtime files and dependencies for the selected solver, such as AgentX's Python venv. Managed caches use `<runtime-name-and-version>/<12-character-content-hash>/`, for example `agentx-1.0.7-py3.12/a1b2c3d4e5f6/`. Identical content is reused across runs. Changes to installation files, commands, or platform produce a different directory. The full hash is stored in `.runtime-ready.json` for reuse validation.

The Windows default root is `%LOCALAPPDATA%\ember\r`, or `AppData\Local\ember\r` under the user directory if `LOCALAPPDATA` is unset. macOS uses `~/Library/Caches/ember-evaluator/runtimes`; Linux uses `${XDG_CACHE_HOME:-~/.cache}/ember-evaluator/runtimes`. Older full-hash caches are not moved or deleted automatically. First use of the new path installs again.

Installation runs in the final directory, without UUID temporary directories or moving Python venvs afterward. Administrator access and Windows long paths are unnecessary. If a long user path still causes third-party `WinError 206`, set a shorter absolute runtime path before launching Evaluator, for example in PowerShell:

```powershell
$env:EVALUATOR_RUNTIME_CACHE_DIR = "D:\ae"
ember-evaluator run "D:\experiments\config.yaml"
```

This variable changes only managed local runtime storage, leaving result, dataset, and Docker image caches unchanged. A short root cannot guarantee arbitrarily deep third-party dependencies fit Windows limits.

Failed or cancelled installation removes the runtime directory created by that attempt. If forced termination leaves an incomplete directory, or full digest validation fails, Evaluator reports the path. Confirm no process is using it, delete that directory, and retry. Leave other active hash directories intact.

## Run in the Management Container (Linux Servers)

The host requires Docker Engine. Start the management container from the repository root on the host:

```bash
bash scripts/toolbox/run.sh
```

The toolbox preserves absolute workspace paths inside and outside the container, making Evaluator and sibling AgentBundle accessible. Install AgentBundle dependencies and build core inside the management container before building Evaluator, in the same order as source installation. The container already sets `PNPM_HOME`, PATH, and the global command directory; pnpm setup and manual PATH configuration are unnecessary. See [management container boundaries](deployment/container-toolbox.md#environment-boundaries).

With prerequisites available, enter the container and run from the Evaluator directory:

```bash
bash scripts/toolbox/git-login.sh # Enter GitCode account/token when prompted for private AgentBundle HTTPS access
pnpm install --frozen-lockfile
pnpm build
```

For model setup, a two-task Office example, Ray, and ARM64 steps, see the [management container guide](deployment/container-toolbox.md). Docker `environment.config.platform` defaults to `auto`. If the benchmark declares no platform, specify YAML platform requirements as needed, such as an amd64-only image whose `task.toml` has no architecture. A benchmark-declared platform takes precedence over YAML. If neither specifies one, Docker uses the node's native platform. Cross-architecture execution warns of possible overhead and checks for existing QEMU. See [Docker target platforms](deployment/docker-platform.md). Dependencies and Git/SSH settings remain in the management container and its dedicated volumes; the repository is shared with the host, whose Docker manages task containers.
