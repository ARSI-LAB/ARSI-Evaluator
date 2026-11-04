# Network downloads

> English | [中文](network.zh-CN.md)

Network YAML is separate from experiment YAML. File selection: CLI `--network` (SDK `networkConfigPath`), then `EVALUATOR_NETWORK_CONFIG`, then `~/.ember-evaluator/network.yaml` (`%USERPROFILE%\.ember-evaluator\network.yaml` on Windows). The default file is created with official sources and direct connections on first use; existing content is never overwritten.

Field precedence is **nonempty supported environment variables → YAML → built-in defaults**, including files selected with `--network`. An empty file, comments only, or `{}` uses default sources and direct connections only when no corresponding environment variables are set. Network configuration does not accept a `version` field. Remove it from existing files; otherwise loading fails with `Unknown network field: version`. YAML still supports `${VARIABLE}` references; overridden fields do not expand their original references. Empty environment values are treated as unset and do not clear YAML values. Invalid environment values fail instead of falling back to YAML. Missing or invalid explicitly selected files fail without falling back.

These commands use the registered `ember-evaluator` CLI; see the [installation guide](installation.md#register-the-global-cli). Example paths are relative to the working directory; run from the repository root when using its Playbooks.

```bash
# Inspect the experiment and default network file without downloads
ember-evaluator inspect experiment.yaml
# Diagnose networks at the experiment execution locations
ember-evaluator doctor experiment.yaml
# Select an alternative network configuration for this call
ember-evaluator doctor experiment.yaml --network playbook/network/mirrors.yaml
ember-evaluator warmup experiment.yaml --network network.yaml
ember-evaluator run experiment.yaml --network network.yaml
```

Examples: [official sources](../../playbook/network/official.yaml), [mirrors and DockerProxy](../../playbook/network/mirrors.yaml), [task image archives](../../playbook/network/archives.yaml). The mirrors example uses `docker pull` with the `dockerproxy.net/` image prefix; it does not modify Docker daemon `registry-mirrors`.

Manual recovery of a stopped run with `ember-evaluator retry --run <run-id-or-directory>` also reloads the current default network file; `--network` can override it. An already running coordinator keeps the configuration loaded at startup.

## Proxy and sources

`proxy.http/https` control their respective protocols; `null` means direct. `noProxy` lists direct destinations. `proxy.overrides.host/daemon/build/runtime` select routes for Evaluator, Docker daemon, Dockerfile RUN, and runtime installation. Without corresponding environment overrides, missing location fields inherit common settings and a null location is entirely direct. Proxy environment variables override matching fields at every location, including explicit addresses and nulls; other fields retain their YAML values. Loopback always refers to the execution location and is never silently rewritten.

| Environment variables (first nonempty value wins within each row) | Overridden field |
| --- | --- |
| `HTTP_PROXY`, `http_proxy` | `proxy.http` at every location |
| `HTTPS_PROXY`, `https_proxy` | `proxy.https` at every location |
| `NO_PROXY`, `no_proxy` | `proxy.noProxy` at every location; comma-separated |
| `HF_ENDPOINT` | `sources.huggingface` |
| `UV_DEFAULT_INDEX`, `UV_INDEX_URL`, `PIP_INDEX_URL` | `sources.python.index` |
| `PIP_EXTRA_INDEX_URL` | `sources.python.extraIndexes`; whitespace-separated, replaces the YAML list |
| `UV_PYTHON_INSTALL_MIRROR` | `sources.python.interpreter` |
| `NPM_CONFIG_REGISTRY`, `npm_config_registry` | `sources.npm.registry` |
| `EVALUATOR_NODE_MIRROR` | `sources.node.dist` |
| `EVALUATOR_GITHUB_MIRROR` | `sources.github.repository`; API/raw addresses are retained |
| `EVALUATOR_DEBIAN_MIRROR` | `sources.apt`; appends `debian`, `debian-security`, `ubuntu`, and `ubuntu-ports` paths |
| `EVALUATOR_DOCKER_BUILD_NETWORK` | `docker.buildNetwork` |

For example, `export HTTPS_PROXY=http://127.0.0.1:7890` selects that proxy even when YAML omits proxies or sets `https: null`. Unset the variable (and any lowercase alias) to use YAML again. HTTP and HTTPS proxies are independent; neither falls back to the other. `ALL_PROXY` is not a configuration input. Proxy URLs must use HTTP(S).

Use environment variables or references for authenticated proxy URLs. Ray transports the template; each node applies its own nonempty network environment overrides before expanding references. Variables referenced by the resulting template must exist on the receiving node; literal credentials are rejected. Without an explicit file or EVALUATOR_NETWORK_CONFIG, edit the default file in the user directory. Each run keeps its own settings and HTTP client, fixed at startup. `inspect` shows values after environment overrides.

| Field | Downloads |
| --- | --- |
| `sources.huggingface` | Hub datasets, files and tokenizer assets |
| `sources.python.index/extraIndexes` | pip and uv packages |
| `sources.python.interpreter` | uv Python installations; null keeps uv's default |
| `sources.npm.registry` | npm, pnpm, Corepack |
| `sources.node.dist` | Node distributions |
| `sources.github.api/raw/repository` | GitHub API, raw files and HTTPS Git |
| `sources.apt` | Full `debian`, `debianSecurity`, `ubuntu`, `ubuntuSecurity`, `ubuntuPorts` repository roots |
| `git.ssh.route` | `direct` or HTTP CONNECT `proxy`; preserves SSH repository URLs |

Model endpoints/authentication and task network isolation retain their experiment settings.

## Image acquisition

`docker.pull` selects the default method. `docker.benchmarks.<selected benchmark>` overrides task base images; shared Node/runtime images still use the default.

| Method | Behavior |
| --- | --- |
| `docker` | Default native pull; daemon controls HTTP proxies |
| `registry-client`, backend `nodejs` | Fetch and verify Manifest/Config/Layers, then import |
| `registry-client`, backend `skopeo` | Use preinstalled skopeo, optionally at `skopeoExecutable`; no auto-install or fallback |
| `archive` | Benchmark override using a `modelscope` or `huggingface` download root |

`docker.mirrors` matches the original registry exactly. `docker.io: https://dockerproxy.net/` maps `ubuntu:24.04` to `dockerproxy.net/library/ubuntu:24.04`, preserving tag/digest and leaving GHCR unaffected. Errors do not trigger source rotation or fallback.

Verified local images can be reused. Registry authentication comes from the execution user's Docker credential store; cross-origin redirects do not receive registry credentials. Downloads, platform, image identity and fixed-digest provenance remain verified. skopeo must support `copy --preserve-digests` (1.13.3 supports this flag; Ubuntu 22.04's 1.4.1 does not). skopeo writes a temporary OCI layout and shares validation/packaging/import with Node.js.

Archive configuration uses `provider: modelscope | huggingface` and `baseUrl`, the benchmark directory download root. For `terminal-bench/vf2-speedup-networkx`, use the `vf2-speedup-networkx` directory. Main images use `<baseUrl>/<task path without namespace>/<linux/amd64 or linux/arm64>/<solve or verify>.tar.gz`; service images use `<phase>/services/<service>.tar.gz`. Export one image per file with `docker save` and gzip. No catalog.json, SHA256SUMS or registry manifests are required.

Archives go directly to `docker load`, then receive an Evaluator tag. Evaluator does not inspect archives, compare file checksums, original registry digests or image platforms, or verify imported identities. Docker errors propagate without fallback. Docker load may restore or overwrite original tags. Image IDs and other metadata are still read for runtime builds.

For archives, explicit `environment.platform` selects the download platform; `auto` selects the execution node native platform, ignoring the original registry task platform declaration. Existing Evaluator image tags for the same URL are reused. Clear the relevant image cache after replacing a remote file, or use a new version directory/revision. See [task image archives](../development/image-archives.md).

The officially maintained ModelScope repository, [evolving-foundry/ember-evaluator](https://www.modelscope.cn/datasets/evolving-foundry/ember-evaluator), hosts official task image archives for selected benchmarks. Check its file tree for available images. To publish your own archives, see the [single-file and batch upload guide](../development/image-archives.md#上传到-modelscope) (Chinese).

### Verify a ModelScope Image

Compare full image IDs for the same platform: **matching IDs mean the same image, even if names and tags differ.**

The example uses `linux/amd64`. Replace the image references and archive path, then run in order:

```bash
# 1. Pull the official image and note its full ID
docker pull --platform linux/amd64 'official-image:tag'
docker image inspect --platform linux/amd64 --format '{{.Id}}' 'official-image:tag'

# 2. Load the archive downloaded from ModelScope
docker load --input solve.tar.gz

# 3. Use the reference printed after Loaded image and compare this ID with step 1
docker image inspect --platform linux/amd64 --format '{{.Id}}' 'loaded-image-reference'
```

Note the official ID before loading, since the archive may overwrite the same tag. If IDs differ, check the version and platform, and whether a Runtime/Agent image was archived instead. An updated official tag can also explain a mismatch.

## Builds and verification

FROM and external COPY use Docker's built-in builder and daemon network. Registry mappings affect explicit acquisition only. RUN receives configured sources/proxies through a temporary Dockerfile copy; `docker.buildNetwork` is `default` or `host`, independent of task runtime permissions.

`doctor experiment.yaml` returns redacted Docker configuration suggestions in `network.dockerAdvice`; Docker probes use the active context. Linux administrators preserve unrelated daemon.json fields, validate, apply and restart themselves. Docker Desktop proxies belong in Desktop settings. Remote daemon configuration must be applied on the remote host. Evaluation, warmup and diagnosis never restart Docker automatically.

`inspect experiment.yaml` displays the experiment and the selected network file path and redacted settings without downloads. `doctor experiment.yaml` combines configuration/tool checks with temporary downloads and reports execution location, destination, route, evidence and duration. Status is passed, failed, not-checked or not-applicable; cache reuse is not a download pass, and incomplete verification exits with code 1. Required package managers must exist on the execution node; probes do not install into the host environment. Ray experiments run probes on actual execution nodes and report unavailable nodes separately. `warmup` prepares selected real tasks, including archives, without model calls. Normal runs do not execute extra probes.

Each probe prints its status to stderr. The final JSON names the active `network.configPath`, `recommendedConfigPath`, `retryCommand`, and `recommendedCommand`. Edit the indicated fields and retry, or explicitly select the bundled mirror configuration; no source is changed automatically. Archive datasets such as WorkBuddy and Terminal-Bench also receive a small ranged download probe of their configured URL; full validation requires warmup.

Failed probes retain the error evidence. `guidance.yamlFields` identifies the relevant YAML fields, and `guidance.action` describes the next steps. Missing tools, authentication failures, and Docker daemon connectivity may require changes outside the YAML. Insufficient cache evidence is not a network failure.

## Source bootstrap and deployment

The bundled launcher parses YAML before repository dependencies are installed. Use the Node/pnpm versions required by package.json:

```bash
node scripts/network/bootstrap.mjs --network network.yaml -- pnpm install --frozen-lockfile
node scripts/network/bootstrap.mjs --network network.yaml -- pnpm ray:ensure
```

Regenerate the launcher with `pnpm network:bundle` after source changes. Toolbox reads `EVALUATOR_NETWORK_CONFIG` for bootstrap and temporary builds. Ray deployment writes a node template and Compose override; variables resolve in node environments and skopeo must be installed on nodes selecting it.

New Docker-in-Docker services receive configured daemon proxies. Changed settings on existing services require explicit administrator recreation; ensure stops instead of restarting daemons. Manual Compose invocation bypasses the launcher, so use its generated override. Third-party scripts may hard-code sources that environment settings cannot override; validate the actual task with warmup. Private Git authentication, remote Docker and real archive services need deployment-specific acceptance.
