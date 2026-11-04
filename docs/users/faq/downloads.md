# Data Downloads and Image Build FAQ

> English | [中文](./downloads.zh-CN.md)

[FAQ index](README.md) · [User documentation](../README.md)

Set variables in the environment actually launching Evaluator or workers. Download-source changes do not alter version/digest requirements.

## Data Downloads, Mirrors, and Proxies

HF datasets default to `https://hf-mirror.com`. Task Docker builds default to Huawei Cloud pip/apt sources and replace literal `https://nodejs.org/dist/` URLs with npmmirror Node downloads without modifying source datasets. Override with `PIP_INDEX_URL`, `EVALUATOR_DEBIAN_MIRROR`, and `EVALUATOR_NODE_MIRROR`; changes alter task image cache identities. `NPM_CONFIG_REGISTRY` changes npm sources, not Node binary URLs. Ray deployment variables may override defaults. Switch HF with `HF_ENDPOINT`, such as `https://huggingface.co`. For GitHub/other proxies set `HTTP_PROXY`/`HTTPS_PROXY`; global `fetch` and Pi model requests use them.

APT mirror rewriting handles `/etc/apt/sources.list` and `.list`/`.sources` under `sources.list.d/`, mapping official Debian main/security and Ubuntu archive/security/ports to mirror `/debian`, `/debian-security`, `/ubuntu`, `/ubuntu-ports`, preserving releases, components, and signing keys. Third-party repositories remain unchanged. `EVALUATOR_DEBIAN_MIRROR` applies to both distributions; use an origin without paths and ensure required repositories exist. Newly built task images retain mirrors for agent installs; existing image references are not modified.

Pinned Node **Docker image** downloads are separate from Node tarballs. If missing locally, read the node daemon's `RegistryConfig.Mirrors` and use its first Huawei Cloud HTTPS mirror, otherwise Docker Hub. Explicit `EVALUATOR_NODE_IMAGE_MIRROR=https://<your-huawei-cloud-mirror>` supplies an origin without repository paths/credentials. Existing official local images are preferred. Only the download address changes; pinned versions, multi-architecture digests, and platform validation remain. Runtime builds and model gateways share the source. Pull failure returns immediately without trying other sources or changing Docker globals. Local/Ray resolve on execution nodes; pass explicit variables to workers. This does not replace benchmark ECR images or toolbox Dockerfile bases.

Evaluator's global `fetch` and its Pi runner use HTTP/1.1 by default for both direct and proxied connections. Set `EVALUATOR_HTTP2=1` **before starting the process** to allow HTTP/2 negotiation; unset it or set `EVALUATOR_HTTP2=0` to keep HTTP/1.1. Enabling HTTP/2 still permits HTTP/1.1 when the server does not support it. Proxy settings and TLS certificate validation remain in effect. The Pi runner reads this variable from its own environment. Configure it separately in container and worker launch environments; it does not configure browsers, Docker image pulls, external download commands, or other third-party Solver runtimes.

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

Task images, Solver runtimes, and judge images build separately. Host apt/Git globals do not automatically enter judge images. Judge builds use:

| Variable | Purpose and default |
| --- | --- |
| EVALUATOR_DEBIAN_MIRROR | Debian main/security and Ubuntu archive/security/ports origin; default https://repo.huaweicloud.com |
| PIP_INDEX_URL | Python index; default https://repo.huaweicloud.com/repository/pypi/simple |
| NPM_CONFIG_REGISTRY / npm_config_registry | Optional npm source, uppercase first; otherwise task defaults. Passed to every task/sidecar/separate-judge build stage for npm/pnpm/Corepack and included in cache identity. Lock versions/hashes remain; absolute lockfile URLs are not rewritten |
| UV_DEFAULT_INDEX / UV_INDEX_URL | When set, overrides PIP_INDEX_URL for all judge-image Python installation |
| PIP_IGNORE_INSTALLED | Optional task build argument, unset by default; accepts `0/1/false/true`. For mixed Conda/pip distutils uninstall failures, explicit `1` installs over resolved dependencies. Changes installed packages/cache identity |
| EVALUATOR_GITHUB_MIRROR | GitHub prefix, default https://github.com/; e.g. https://git-mirror.example/github/ receives Tencent/workbuddy-bench.git or harbor-framework/harbor.git |
| HTTP_PROXY / HTTPS_PROXY / NO_PROXY | Explicit Docker build inputs, lowercase supported; default networking rewrites loopback proxies to host.docker.internal |
| EVALUATOR_DOCKER_BUILD_NETWORK | default or host; default default. host means the Docker daemon host, not necessarily the CLI's WSL distribution |

Export in the WSL shell/management container launching Evaluator. Source/proxy URLs must omit credentials. Settings/recipe changes create new cache keys. With Docker adapter scripts, also select the script through verifier.config.dockerExecutable; Environment and Verifier executables are separate.

Successful builds do not establish runtime download access. Ordinary/Compose main containers can inherit explicit coordinator `NPM_CONFIG_REGISTRY`, `PIP_INDEX_URL`, `PIP_EXTRA_INDEX_URL`, and `UV_DEFAULT_INDEX`; task/Environment values take precedence. `model-api` isolation does not inherit them.

Task builds add missing APT defaults: up to three retries per failed file; HTTP/HTTPS connection/read timeout 30 seconds; index update fails immediately after exhausted errors instead of continuing with missing-package errors. Defaults apply before CA bootstrap; image settings, later task settings, and `apt-get -o` override them. Retries occur in APT downloads. Exhaustion fails the build without retrying whole builds/attempts. Compilation/script errors are not retried; preparation deadlines remain.

Git fetches pinned WorkBuddy and uv.lock Harbor commits with up to three attempts, 120 seconds each, stopping below 1 KiB/s for 30 seconds. Timeout kills Git and transport children. Git selects no third-party public proxy automatically; configure your mirror prefix or reachable HTTPS_PROXY.

When base images lack CA certificates, builds first install ca-certificates through the same mirror's HTTP address with APT signatures checked, then restore HTTPS. Already-rewritten mirror HTTPS `.list`/`.sources` also bootstrap. Custom HTTPS mirrors need matching HTTP bootstrap or preinstalled CA. Existing certificates skip reinstall. Only build snapshots change; source files/digests remain intact.

Setting PIP_INDEX_URL then running uv sync --frozen may still use official lockfile URLs. This implementation exports registry dependencies offline/frozen, then installs from the configured index using --require-hashes and --no-deps. Upstream versions/hashes remain; both source packages use pinned commits without resolving/modifying uv.lock. See [uv export documentation](https://docs.astral.sh/uv/concepts/projects/sync/#exporting-the-lockfile).

## Why Access Sources Despite Existing Caches?

Cache hits require matching source identity, pinned version, and content digest. Partial files are not a complete verifiable lock. Check original manifest, actual `cacheDir`, and execution environment; Windows/WSL/users may have different caches.

GitHub/HF 403 differs from model 403. Identify the failing domain before checking access, throttling, and proxies. Do not alter digests to bypass validation. Old DeepSWE cache-registration scripts depend on removed source implementations and do not apply to Harbor profiles. New runs use current adapters; retained historical results rebuild offline.

## What If pip Cannot Uninstall distutils Packages During Builds?

Try `PIP_IGNORE_INSTALLED=1` only for explicit distutils uninstall errors caused by mixed Conda/pip images. It changes Python installation/cache identities, not a general installation fix. Validate the new environment before starting a new evaluation.

## Can I Retry Only Failed Tasks After Download Failures?

After restoring networking, use [network recovery](../network-retry.md). Only tasks with explicit evidence, no valid score, and confirmed cleanup qualify. Missing images, permanent permissions, dependency conflicts, and ordinary timeouts do not.
