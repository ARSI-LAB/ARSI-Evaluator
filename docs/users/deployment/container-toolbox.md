# Install, Build, and Submit Evaluations in the Management Container

> English | [中文](./container-toolbox.zh-CN.md)

This setup installs Node.js 24, pnpm 11.22.0, Python 3.11, venv, compilers, Git, SSH client, and Docker CLI/Compose in a dedicated container. The host needs Linux Docker Engine and repositories, without project dependencies, global Git changes, or project SSH keys.

The [launcher](../../../scripts/toolbox/run.sh) builds the [Dockerfile](../../../scripts/toolbox/Dockerfile). In interactive Bash, configure Git/HTTPS, run `pnpm ray:ensure`, and evaluate.

## Start from the Host

Run from the repository root on the server host:

```bash
bash scripts/toolbox/run.sh
```

apt/npm install only during image builds. With host Python 3/npu-smi available, the script prepares a loopback sampling controller without querying devices at startup. AgentX run requests read-only sampling for selected cards; exiting the container cleans it up. No host dependencies/driver settings change. Run the same command to reenter using build cache; two containers with the same name cannot coexist.

The image sets `PNPM_HOME=/toolbox-home/.local/share/pnpm` and includes bin/home in PATH; entry creates directories. `pnpm add --global .` registers Evaluator without pnpm setup/manual exports. The Docker wrapper handles older daemon platform inspection and host build networking while retaining explicit task policies.

AgentX `environment: local` creates/reuses an isolated harness venv inside management home storage, without task images/containers. NPU sampling stays on the host; no NPU devices are mapped. The container is optional; see [AgentX quick start](../quick-start/agentx.md) for direct-host requirements.

The image sets `LANG=C.UTF-8`, `LC_ALL=C.UTF-8`, and `/etc/inputrc` UTF-8 input/display so Chinese paths do not appear as `M-dM-…`. New `docker exec` terminals inherit these settings. After Dockerfile changes, exit/relaunch to build/use the new image; existing containers do not update automatically.

To enter an already-running container from another host terminal:

```bash
docker exec -it ember-evaluator-toolbox bash
```

Exiting the additional terminal does not stop the original container.

Build/runtime use host networking for apt/npm. If base pulls succeed but installs show `Temporary failure resolving`, check host resolution and `--network host` in build commands. Docker restart/host DNS edits are unnecessary for that check. Persistent failures under host networking require Docker DNS/network policy investigation.

Isolation and persistence:

| Content | Storage |
| --- | --- |
| Global Git, SSH keys, known_hosts | `ember-evaluator-toolbox-home` volume mounted as `$HOME` (`/toolbox-home`) |
| Linux project dependencies | `ember-evaluator-toolbox-node-modules` mounted at repository `node_modules` |
| AgentBundle Linux dependencies | `ember-evaluator-toolbox-agentbundle-node-modules` |
| Repositories, dist, results, caches, `.pnpm-store`, Ray authentication | Host repository bind mounts |
| Ray/task containers, images, runtime volumes | Host Docker |

Host `/root`, Git settings, and SSH directories are not mounted; host private keys do not appear automatically. Software/accounts are separate, but the shared Docker socket grants host Docker management access and is not a security boundary.

The launcher preserves absolute paths because host Docker resolves Ray Compose authentication bind mounts. Do not arbitrarily remap the repository. Host networking reaches `localhost:9443` Jobs gateway. This targets native Linux Docker, not Windows Docker Desktop.

## GitCode HTTPS Login in the Container

From the container repository root, run [login](../../../scripts/toolbox/git-login.sh):

```bash
bash scripts/toolbox/git-login.sh
```

Enter GitCode account/token; the hidden token serves as password. The account needs private `evanTang/AgentBundle` read access. The script validates access and rewrites SSH to HTTPS only for that repository, leaving dependency versions/locks unchanged.

Rewrites/cache settings live in container `$HOME/.gitconfig`, not host Git settings. Git credential-cache keeps tokens in memory for eight hours, never repository/config/credential files. Exiting stops the cache; log in after reentry/expiry. Failed validation clears that repository's cached credentials.

For commits, optionally configure author identity separately; it does not grant HTTPS access:

```bash
git config --global user.name "Your name or nickname"
git config --global user.email "Your verified GitCode email"
```

After successful login, install, build, and evaluate below.

## Optional GitCode SSH Login

If HTTPS was configured, remove that repository's rewrite inside the container before switching:

```bash
git config --global --unset-all url.https://gitcode.com/evanTang/AgentBundle.git.insteadOf || true
```

Run all commands inside the container. Git name/email identify commits; the account associated with the public key controls access.

```bash
git config --global user.name "Your name or nickname"
git config --global user.email "Your verified GitCode email"

mkdir -p ~/.ssh
chmod 700 ~/.ssh
if [ ! -f ~/.ssh/id_ed25519_gitcode_evaluator ]; then
  ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519_gitcode_evaluator -C "evaluator-toolbox"
fi
cat ~/.ssh/id_ed25519_gitcode_evaluator.pub
```

Add the full public key to GitCode Personal settings → Security settings → SSH public keys. The account needs `evanTang/AgentBundle` read access. Keep the private key in the dedicated container volume, outside the repository.

Configure Git to use this key, persisting through home volume. Since HOME is `/toolbox-home`, also set a persistent known_hosts path:

```bash
git config --global core.sshCommand "ssh -F /dev/null -i $HOME/.ssh/id_ed25519_gitcode_evaluator -o IdentitiesOnly=yes -o UserKnownHostsFile=$HOME/.ssh/known_hosts"

# If the private key is encrypted, load it after entering each new management container.
eval "$(ssh-agent -s)"
ssh-add ~/.ssh/id_ed25519_gitcode_evaluator

git ls-remote ssh://git@gitcode.com/evanTang/AgentBundle.git HEAD
```

Confirm server identity on first connection. Install/build only after the last command prints a commit hash successfully.

## Run Experiments Inside the Container

The launcher mounts Evaluator's parent, exposing sibling AgentBundle. Build both using [source installation](../installation.md#install-from-source); custom management containers must preserve mounts.

Set [model variables](../quick-start.md#3-set-model-variables) in that terminal, then select a [Playbook](../../../playbook/README.md), for example Terminal-Bench4.0:

```bash
node dist/cli.js doctor playbook/terminalbench/terminalbench-4.0.yaml
node dist/cli.js run playbook/terminalbench/terminalbench-4.0.yaml
```

This example runs all tasks by default; limit the first run per [quick start](../quick-start/terminalbench.md). YAML selects output. Reset model variables after reentering.

For Ray, use its Playbooks. Actual runs check/prepare managed local clusters; optionally prepare earlier with `corepack pnpm@11.22.0 ray:ensure`. Exiting the toolbox does not stop Ray. See [Ray configuration](../config.md#ray-and-execution-nodes).

## Build Networking and Older Docker APIs

If host networking works but task builds cannot resolve sources, or daemon API<1.49 lacks `image inspect --platform`, choose the [local Docker wrapper](../../../scripts/toolbox/docker-host.sh) through environment.config.dockerExecutable. It builds with host networking and validates architecture before old-API identity reads; mismatches still fail.

Select an absolute wrapper path in YAML; relative paths use the YAML directory:

```yaml
environment:
  name: docker
  config:
    dockerExecutable: /path/to/ember-evaluator/scripts/toolbox/docker-host.sh
```

This wrapper targets local Linux daemons, not remote ones. If only task bridge networking cannot reach models, set `EVALUATOR_TOOLBOX_HOST_NETWORK=1` for a run. It affects only container creates without explicit networks, sharing host networking as task rules allow. Explicit none/model-api policies remain.

## x86 Emulation and Recovery on ARM64 Hosts

Docker `platform` defaults to auto. Benchmark declarations override YAML; without them YAML may specify requirements, otherwise node-native applies. See [platforms](docker-platform.md). WorkBuddy examples select linux/amd64. ARM64 needs x86 emulation; Evaluator warns/checks existing support without installation/kernel registration. After administrator authorization to modify host kernel settings, run on the host:

```bash
docker run --privileged --rm tonistiigi/binfmt --install amd64
cat /proc/sys/fs/binfmt_misc/qemu-x86_64
```

Registration affects the host, not one evaluation container. `--rm` removes the installer but leaves registration. Native ARM containers stay native; x86 evaluations share host resources and usually run slower.

Test with a temporary network-disabled/resource-limited container:

```bash
docker pull --platform linux/amd64 node:24.22.1-bookworm-slim
docker run --rm --platform linux/amd64 --network none --cpus 1 --memory 256m \
  node:24.22.1-bookworm-slim node -p 'process.arch'
```

`x64` confirms x86 Node execution. After stopping x86 tasks, unregister on the host:

```bash
docker run --privileged --rm tonistiigi/binfmt --uninstall qemu-x86_64
```

Alternatively, remove the same kernel rule directly without an installer container:

```bash
printf '%s\n' -1 > /proc/sys/fs/binfmt_misc/qemu-x86_64
```

These removal commands apply only when this operation added a previously absent registration. Preserve/restore preexisting rules instead. Unregistration leaves cached images/results intact. Do not unregister during active x86 tasks, which may break subsequent execution.

## Environment Boundaries

- `pnpm-workspace.yaml` links SDK ../AgentBundle/packages/core. Toolbox shares the parent workspace; prepare AgentBundle, install dependencies/build core inside, then Evaluator. Sources/build outputs remain host-shared.
- Host `/var/run/docker.sock` must be accessible. A platform-assigned container without the socket or permission for privileged Docker-in-Docker needs administrator support.
- Management images can match host architecture; task platform selection is separate. WorkBuddy selects amd64; missing emulation on ARM64 gives ENV_ARCH_UNSUPPORTED. Use native nodes or administrator-configured emulation. Entering toolbox/passing dry-run does not prove tasks can execute.
- This setup uses local Docker, without direct remote-daemon support, remote transfers, rootless handling, or SELinux bind policies.
- Volumes live in host Docker storage. Removing the container retains account/dependency volumes; owners must handle private keys during personnel/environment changes.
- Image sources use repository domestic mirrors. Download timeout differs from SSH permissions; adjust Dockerfile build arguments/networking when necessary.

[User guide](../README.md) · [Quick start](../quick-start.md)
