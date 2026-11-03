# Install and Run Evaluations in the Management Container

> English | [中文](./container-toolbox.zh-CN.md)

For Linux servers with Docker Engine. The host needs the Evaluator repository and access to `/var/run/docker.sock`. The management container provides Node.js, pnpm, Python, and other dependencies.

## Start from the Host

Run from the Evaluator repository root on the host:

```bash
bash scripts/toolbox/run.sh
```

The first launch builds the image, then opens a container terminal. After exiting, run the same command to return.

## GitHub HTTPS Login in the Container

Run from the repository root inside the container:

```bash
bash scripts/toolbox/git-login.sh
```

Enter your GitHub account and access token when prompted. The account needs read access to the private `evolving-foundry/agentbundle` repository. The token is cached in memory for eight hours; run the login script again after reentering the container or when authentication expires.

Follow the three commands in the [installation guide](../installation.md#install-from-source) and confirm that `ember-evaluator --help` prints usage. pnpm is already configured in the container; `pnpm setup` is unnecessary.

## Run Experiments Inside the Container

Follow the [quick start](../quick-start.md) to set model variables and prepare a configuration, then run:

```bash
ember-evaluator doctor /path/to/config.yaml
ember-evaluator run /path/to/config.yaml
```

See [Playbook](../../../playbook/README.md) for examples. Set model variables again when reentering the container. For Ray, see [Ray configuration](../config.md#ray-and-execution-nodes).

To open another terminal in the running container, run on the host:

```bash
docker exec -it ember-evaluator-toolbox bash
```

## Environment Boundaries

- Source files and results are shared with the host. Dependencies and Git settings persist in Docker volumes after exit.
- The container uses host Docker and can manage its containers and images. Host Git credentials are not imported automatically.
- Keep the mount paths set by the launcher. This setup does not support Windows Docker Desktop or remote Docker daemons.
- Exiting the management container does not stop Ray clusters.

<details>
<summary>Special environments and troubleshooting (optional)</summary>

## Build Networking and Older Docker APIs

The management container configures the Docker wrapper automatically. For a custom deployment with image build networking or older Docker API errors, set this in YAML:

```yaml
environment:
  name: docker
  config:
    dockerExecutable: /path/to/ember-evaluator/scripts/toolbox/docker-host.sh
```

The script supports local Linux Docker only. See [Docker troubleshooting](../faq/docker.md) for download and network issues.

## x86 Emulation and Recovery on ARM64 Hosts

Running amd64 images on ARM64 servers requires QEMU. If missing, an administrator can run the following on the host; it changes host emulator registration:

```bash
docker run --privileged --rm tonistiigi/binfmt --install amd64
```

Only if this registration was newly added, remove it after stopping x86 tasks:

```bash
docker run --privileged --rm tonistiigi/binfmt --uninstall qemu-x86_64
```

Emulation may be slow; prefer a machine matching the image architecture. See [Docker target platforms](docker-platform.md) for platform selection.

</details>

[User guide](../README.md) · [Quick start](../quick-start.md)
