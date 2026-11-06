# Data Downloads and Image Build FAQ

> English | [Simplified Chinese](./downloads.zh-CN.md)

[FAQ index](README.md) · [User documentation](../README.md)

Set variables in the environment actually launching Evaluator or execution nodes. Changing sources changes download addresses, not the selected dataset version.

## Data Downloads, Mirrors, and Proxies

Downloads use official sources by default. Select Hugging Face, GitHub, pip/uv, npm, Node and APT sources and per-location proxies with a separate [network YAML](../network.md), supplied through `--network` or `EVALUATOR_NETWORK_CONFIG`.

`sources.apt` independently sets full Debian main/security and Ubuntu archive/security/ports URLs. Builds use those addresses while keeping the original distribution and signing settings. Configure third-party repositories separately; original task files are not modified.

Shared images use the method in `docker.pull`; `docker.mirrors` can select registry mirrors. Task images can additionally select ModelScope/Hugging Face archives through `docker.benchmarks`. Dockerfile `FROM` uses the Docker daemon's network settings. See [image downloads](../image-downloads.md) for examples.

Evaluator and the Pi runner default to HTTP/1.1. Set `EVALUATOR_HTTP2=1` **before starting the process** to allow HTTP/2; omit it or set `0` to retain HTTP/1.1. Servers without HTTP/2 support can still use HTTP/1.1.

Set the variable separately in container and worker launch environments. It does not control browsers, Docker image pulls, or third-party Solvers' own download tools.

```bash
# Optional: allow HTTP/2 (Git Bash / Linux / macOS)
export EVALUATOR_HTTP2=1
```

```powershell
# Optional: allow HTTP/2 (PowerShell)
$env:EVALUATOR_HTTP2 = "1"
```

If large downloads repeatedly terminate with `UND_ERR_RES_CONTENT_LENGTH_MISMATCH`, keep the default HTTP/1.1 and check proxy connectivity. Interrupted downloads currently restart from the beginning.

## Judge Image Sources and Build Networking

Task images, Solver runtimes and judge images build separately but read the same run's network YAML. `sources.python`, `sources.npm`, `sources.github` and `sources.apt` select installation sources; `proxy.overrides.build` selects build proxies and `docker.buildNetwork` selects `default` or `host`. Defaults use official sources. Loopback proxy addresses are not rewritten; provide an address reachable from the container.

Nonempty supported network environment variables override network YAML; see [network configuration fields](../reference/network.md). When using a custom Docker wrapper, configure Environment and Verifier executables separately; the Verifier uses `verifier.config.dockerExecutable`.

Successful builds do not establish runtime download access. Ordinary/Compose main containers receive `NPM_CONFIG_REGISTRY`, `PIP_INDEX_URL`, `PIP_EXTRA_INDEX_URL` and `UV_DEFAULT_INDEX` from the network settings; task/Environment values take precedence. `model-api` isolation does not inherit them.

APT defaults to up to three retries per failed file, with 30-second connection and read timeouts; existing image or task settings take precedence. Index updates that still fail stop the build. Download retries do not rerun whole image builds or tasks, and do not rerun compilation or script errors.

WorkBuddy and Harbor Git dependencies get up to three download attempts, each limited to 120 seconds; prolonged slow transfers can also stop. Configure a reachable Git mirror or `HTTPS_PROXY` for connection failures. Evaluator does not choose third-party public proxies automatically.

If a base image lacks CA certificates, the build installs `ca-certificates` before using HTTPS package sources. Custom HTTPS APT mirrors must provide a matching HTTP address for initial certificate installation, or the base image must already contain CA certificates.

Dependency lockfiles can contain fixed download URLs. Framework installation of Harbor dependencies uses the configured package source while retaining locked versions; source dependencies still use fixed Git commits. If a task's own installation script accesses other addresses, check that script and its tool settings.

## Why Access Sources Despite Existing Caches?

Cached files must be complete for the current source and version. Partial downloads can still require network access. Check the actual `cacheDir` and execution environment: Windows, WSL, and different users may use different cache directories.

Handle GitHub/Hugging Face 403 errors separately from model-service 403 errors. Identify the domain in the failure log, then check that service's account permissions, access limits, or proxy settings.

## What If pip Cannot Uninstall distutils Packages During Builds?

Try `PIP_IGNORE_INSTALLED=1` only for explicit distutils uninstall errors in images mixing Conda and pip. It changes Python package installation and rebuilds the relevant dependency layers. Warm up successfully before starting a new evaluation; diagnose other installation failures from their logs.

## Can I Retry Only Failed Tasks After Download Failures?

After restoring networking, use [network recovery](../network-retry.md). Only tasks with explicit evidence, no valid score, and confirmed cleanup qualify. Missing images, permanent permissions, dependency conflicts, and ordinary timeouts do not.
