# Network downloads

> English | [中文](network.zh-CN.md)

Use a separate YAML with `--network`, or `EVALUATOR_NETWORK_CONFIG`. The CLI option takes precedence; no file is discovered implicitly. SDK callers use `Evaluator.run({ networkConfigPath, ... })`. An explicit file uses official sources/direct access for omitted fields and does not merge unrelated host network variables. Reference required variables explicitly as `${VARIABLE}`.

These commands use the registered `ember-evaluator` CLI; see the [installation guide](installation.md#register-the-global-cli). Example paths are relative to the working directory; run from the repository root when using its Playbooks.

```bash
ember-evaluator network inspect --network playbook/network/mirrors.yaml
ember-evaluator network docker-config --network network.yaml
ember-evaluator network doctor --network network.yaml --experiment experiment.yaml
ember-evaluator warmup experiment.yaml --network network.yaml
ember-evaluator run experiment.yaml --network network.yaml
```

Examples: [official sources](../../playbook/network/official.yaml), [mirrors and DockerProxy](../../playbook/network/mirrors.yaml), [task image archives](../../playbook/network/archives.yaml). The mirrors example uses `docker pull` with the `dockerproxy.net/` image prefix; it does not modify Docker daemon `registry-mirrors`.

## Proxy and sources

`proxy.http/https` control their respective protocols; `null` means direct. `noProxy` lists direct destinations. `proxy.overrides.host/daemon/build/runtime` select routes for Evaluator, Docker daemon, Dockerfile RUN, and runtime installation. Missing override fields inherit common settings; a null location is entirely direct. Loopback always refers to the execution location and is never silently rewritten.

Use environment references for authenticated proxy URLs. Ray transports the template and expands variables on each node; literal credentials are rejected. Without a file, the central loader reads existing HTTP(S)/NO_PROXY, HF_ENDPOINT, pip/uv, npm and Evaluator mirror variables. Each run keeps its own settings and HTTP client.

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

## Builds and verification

FROM and external COPY use Docker's built-in builder and daemon network. Registry mappings affect explicit acquisition only. RUN receives configured sources/proxies through a temporary Dockerfile copy; `docker.buildNetwork` is `default` or `host`, independent of task runtime permissions.

`docker-config` reports the active context/daemon and redacted merge instructions. Linux administrators preserve unrelated daemon.json fields, validate, apply and restart themselves. Docker Desktop proxies belong in Desktop settings. Remote daemon configuration must be applied on the remote host. Evaluation, warmup and diagnosis never restart Docker automatically.

`inspect` is offline. `doctor` performs temporary downloads and reports execution location, destination, route, evidence and duration. Status is passed, failed, not-checked or not-applicable; cache reuse is not a download pass, and incomplete verification exits with code 1. Required package managers must exist on the execution node; probes do not install into the host environment. Ray experiments run probes on actual execution nodes and report unavailable nodes separately. `warmup` prepares selected real tasks, including archives, without model calls. Normal runs do not execute extra probes.

Failed probes retain the error evidence. `guidance.yamlFields` identifies the relevant YAML fields, and `guidance.action` describes the next steps. Missing tools, authentication failures, and Docker daemon connectivity may require changes outside the YAML. Insufficient cache evidence is not a network failure.

## Source bootstrap and deployment

The bundled launcher parses YAML before repository dependencies are installed. Use the Node/pnpm versions required by package.json:

```bash
node scripts/network/bootstrap.mjs --network network.yaml -- pnpm install --frozen-lockfile
node scripts/network/bootstrap.mjs --network network.yaml -- pnpm ray:ensure
```

Regenerate the launcher with `pnpm network:bundle` after source changes. Toolbox reads `EVALUATOR_NETWORK_CONFIG` for bootstrap and temporary builds. Ray deployment writes a node template and Compose override; variables resolve in node environments and skopeo must be installed on nodes selecting it.

New Docker-in-Docker services receive configured daemon proxies. Changed settings on existing services require explicit administrator recreation; ensure stops instead of restarting daemons. Manual Compose invocation bypasses the launcher, so use its generated override. Third-party scripts may hard-code sources that environment settings cannot override; validate the actual task with warmup. Private Git authentication, remote Docker and real archive services need deployment-specific acceptance.
