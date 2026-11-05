# Network configuration for deployment

> English | [中文](network.zh-CN.md)

[Network configuration](../network.md)

## Docker builds and daemon proxies

### Image and dependency downloads during warmup

A single `warmup` may download existing images, build task images, and install dependencies. Configure addresses and proxies for each step separately:

| Operation | Download address | Proxy |
| --- | --- | --- |
| Explicit acquisition, `method: docker` | Apply `docker.mirrors`, then run `docker pull` | Docker daemon or Docker Desktop proxy |
| Explicit acquisition, `method: registry-client` | Apply `docker.mirrors`, then download with Node.js or skopeo | Evaluator process `host` proxy |
| Task images from ModelScope or Hugging Face | `baseUrl` under `docker.benchmarks.<benchmark>` | Evaluator process `host` proxy |
| Dockerfile `FROM` and external `COPY --from` | Docker daemon or BuildKit registry configuration | Docker daemon or Docker Desktop proxy |
| Dependency installation in Dockerfile `RUN` | Corresponding package source in `sources`, or the address in the command | `proxy.overrides.build` |
| Harness runtime dependency installation | Corresponding package source in `sources`, or the installer's address | `proxy.overrides.runtime` |

For example, SWE-bench may first fetch the task image using Dockerfile `FROM`, then prepare the Node runtime. If `FROM` fails, check the Docker daemon's connection to the registry. A missing Node image later uses `docker.pull` and `docker.mirrors`. See [image downloads](../image-downloads.md) for acquisition options.

Network YAML `docker.mirrors` does not change the daemon's `registry-mirrors`. Setting a YAML proxy to `null` does not disable a proxy already configured in Docker Desktop or the daemon.

`docker.buildNetwork` accepts `default` or `host`. It controls build steps, independently of task runtime network permissions.

### Apply Docker proxy advice

Run diagnosis for Docker proxy advice:

```bash
ember-evaluator doctor experiment.yaml --network network.yaml
```

Apply the suggestions in `network.dockerAdvice` according to your Docker deployment:

- Linux Engine: preserve other daemon settings, check the edited configuration, and have an administrator restart Docker.
- Docker Desktop: configure proxies in Desktop settings, rather than `daemon.json` proxy fields.
- Remote Docker: configure the host running the remote daemon; local proxy settings cannot replace remote settings.

Diagnosis uses the current Docker context. Confirm it selects the intended daemon before changing settings. Evaluator never restarts Docker automatically.

## Source bootstrap and deployment

The bundled launcher can apply network YAML before dependencies are installed. Use the Node.js and pnpm versions required by `package.json`:

```bash
node scripts/network/bootstrap.mjs --network network.yaml -- pnpm install --frozen-lockfile
node scripts/network/bootstrap.mjs --network network.yaml -- pnpm ray:ensure
```

Toolbox uses `EVALUATOR_NETWORK_CONFIG` or the default network file in the user directory. The launcher applies the file during installation, builds, and management-container use.

Ray nodes must reach the configured download and proxy addresses. Set `${VARIABLE}` references on the relevant nodes. Install skopeo on nodes performing downloads when selecting that backend.

New Docker-in-Docker services receive daemon proxies at creation. After changing networking for existing services, an administrator must recreate them as instructed by the launcher. Use the bundled launcher and its generated Compose configuration to avoid omitting network settings during manual startup.

After deployment, run `doctor`, then use `warmup` for a small set of real tasks. Hard-coded download URLs in third-party scripts may ignore network YAML; adjust those scripts or tool settings when necessary. See [network diagnosis](../faq/network.md) for the steps.
