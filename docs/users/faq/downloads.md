# Data Downloads and Image Build FAQ

> English | [中文](./downloads.zh-CN.md)

[FAQ index](README.md) · [User documentation](../README.md)

Set variables in the environment actually launching Evaluator or workers. Download-source changes do not alter version/digest requirements.

## Data Downloads, Mirrors, and Proxies

Downloads use official sources by default. Select Hugging Face, GitHub, pip/uv, npm, Node and APT sources and per-location proxies with a separate [network YAML](../network.md), supplied through `--network` or `EVALUATOR_NETWORK_CONFIG`.

APT rewriting handles `/etc/apt/sources.list` and `.list`/`.sources` under `sources.list.d/`. The `sources.apt` fields independently select complete Debian main/security and Ubuntu archive/security/ports URLs, preserving releases, components and signing keys. Third-party repositories, original task files and existing images are unchanged.

Pinned Node Docker images, task base images and separate verifier images use `docker.pull` and `docker.mirrors` from the network YAML. Mirrors match the original registry exactly; pinned digests and platform checks remain. Evaluator no longer automatically selects a Huawei mirror from daemon settings. `FROM` connectivity is controlled by the actual Docker daemon. See [network configuration](../network.md) for the three acquisition methods and examples.

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

Task images, Solver runtimes and judge images build separately but read the same run's network YAML. `sources.python`, `sources.npm`, `sources.github` and `sources.apt` select installation sources; `proxy.overrides.build` selects build proxies and `docker.buildNetwork` selects `default` or `host`. Defaults use official sources. Loopback proxy addresses are not rewritten; provide an address reachable from the container.

`PIP_IGNORE_INSTALLED` is a separate installation option accepting `0/1/false/true`, unset by default. It changes pip behavior and build cache identity, not network routing. Other network environment variables are read centrally only when no network file is supplied; see the [network guide](../network.md) for precedence. With Docker adapter scripts, also select the script through `verifier.config.dockerExecutable`; Environment and Verifier executables are configured separately.

Successful builds do not establish runtime download access. Ordinary/Compose main containers receive `NPM_CONFIG_REGISTRY`, `PIP_INDEX_URL`, `PIP_EXTRA_INDEX_URL` and `UV_DEFAULT_INDEX` from the network settings; task/Environment values take precedence. `model-api` isolation does not inherit them.

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
