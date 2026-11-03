# 在管理容器中安装、构建和提交评测

> [English](./container-toolbox.md) | 中文

本方案把 Node.js 24、pnpm 11.22.0、Python 3.11、venv、编译依赖、Git、SSH 客户端和 Docker CLI/Compose 安装在专用管理容器中。宿主机只需已经可用的 Linux Docker Engine，以及仓库目录；无需在宿主机安装项目依赖、修改 Git 全局配置或创建项目 SSH 私钥。

[启动脚本](../../../scripts/toolbox/run.sh) 使用 [Dockerfile](../../../scripts/toolbox/Dockerfile) 构建管理镜像，进入交互式 Bash 后，再执行 Git 设置、HTTPS 登录、`pnpm ray:ensure` 和评测命令。

## 在宿主机启动管理容器

在服务器宿主机的仓库根目录执行：

```bash
bash scripts/toolbox/run.sh
```

apt 和 npm 安装只发生在镜像构建中。宿主机已有 Python3 和 npu-smi 时，脚本还自动准备一个回环采样控制进程；它在管理容器启动时不查询设备，只有 AgentX run 才会申请指定卡号的只读采样，退出管理容器时自动清理。裸机不安装依赖或修改驱动。退出容器后，下次执行同一命令即可重新进入，镜像构建会利用缓存。不能同时启动两个同名管理容器。

管理镜像已设置 `PNPM_HOME=/toolbox-home/.local/share/pnpm`，PATH 包含其 `bin` 和主目录；入口自动创建目录，直接执行 `pnpm add --global .` 即可注册当前 Evaluator，不需要手动执行 pnpm setup 或导出 PATH。Docker CLI 包装器自动处理旧 daemon 的平台检查和构建 host 网络，任务的显式网络策略保持不变。

AgentX 可使用 `environment: local`，在管理容器内自动创建并复用独立的 Harness venv，不再创建 AgentX 任务镜像或任务容器。venv 默认缓存在管理容器 home 卷内。NPU 采样仍由上述裸机控制进程执行，管理容器不映射 NPU。管理容器是可选部署方式，直接裸机运行的依赖和步骤见 [AgentX 入门](../quick-start/agentx.zh-CN.md)。

管理镜像默认设置 `LANG=C.UTF-8` 和 `LC_ALL=C.UTF-8`，并在 `/etc/inputrc` 中启用 Bash 对 UTF-8 字符的输入和原样显示，避免中文路径显示成 `M-dM-…`。这些设置也适用于通过 `docker exec` 打开的新终端，无需手动导出语言变量。更新 Dockerfile 后，先退出原管理容器，再执行上述启动脚本即可构建并使用新镜像；已经运行的旧容器不会自动更新。

如果管理容器已经运行，可在宿主机打开另一个终端进入它：

```bash
docker exec -it ember-evaluator-toolbox bash
```

退出这个附加终端不会停止原管理容器。

镜像构建和管理容器运行均使用 host 网络，使镜像内的 apt/npm 可以通过宿主机网络访问软件源。如果基础镜像拉取成功，但安装时报 `Temporary failure resolving`，先确认宿主机能解析软件源域名，并检查构建命令是否包含 `--network host`；无需为此重启 Docker 或修改宿主机的 DNS 配置。若 host 网络下仍解析失败，需要进一步检查 Docker 的 DNS 设置及网络策略。

容器中的隔离与持久化方式：

| 内容 | 保存位置 |
| --- | --- |
| Git 全局配置、SSH 密钥、known_hosts | 专用 Docker 卷 `ember-evaluator-toolbox-home`，挂载为容器 `$HOME`（`/toolbox-home`） |
| Linux 项目依赖 | 专用 Docker 卷 `ember-evaluator-toolbox-node-modules`，挂载为仓库的 `node_modules` |
| AgentBundle 的 Linux 依赖 | 专用 Docker 卷 `ember-evaluator-toolbox-agentbundle-node-modules` |
| 仓库、dist、评测结果、数据缓存、`.pnpm-store` 和 Ray 认证文件 | 宿主机仓库目录，通过 bind mount 共享 |
| Ray、任务容器、镜像及运行卷 | 宿主机 Docker 管理 |

容器没有挂载宿主机的 `/root`、Git 配置或 SSH 目录，宿主机已有私钥不会自动出现在管理容器中。本方案隔离软件安装和账号配置，但共享宿主机 Docker daemon；挂载 Docker socket 意味着管理容器具有管理宿主机 Docker 的权限，不能视为与宿主机的安全隔离。

启动脚本保留仓库在容器内外相同的绝对路径，因为当前 Ray Compose 的认证目录等 bind mount 由宿主机 Docker 解析。不要将仓库随意映射成另一个容器路径。管理容器采用 host 网络，使用 Ray 时可以直接访问宿主机发布在 `localhost:9443` 的 Jobs 网关。本脚本面向原生 Linux Docker 宿主机，不面向 Windows Docker Desktop。

## 在管理容器通过 HTTPS 登录 GitCode

进入管理容器后，在仓库根目录执行 [登录脚本](../../../scripts/toolbox/git-login.sh)：

```bash
bash scripts/toolbox/git-login.sh
```

按提示输入 GitCode 账号和访问令牌；令牌作为密码使用，输入时不显示。账号必须有 `evanTang/AgentBundle` 私仓的读取权限。脚本自动验证访问权限，并仅对该仓库配置 SSH 地址到 HTTPS 地址的改写，所以无需修改依赖声明或锁文件中的版本。

改写与凭据缓存配置保存在管理容器的 `$HOME/.gitconfig`，不修改宿主机 Git 配置。令牌仅通过 Git credential-cache 在内存中缓存 8 小时，不写入仓库、Git 配置或凭据文件。退出管理容器后缓存进程结束，重新进入或缓存过期时再次执行登录脚本。访问验证失败会清除该仓库的缓存凭据。

需要提交代码时，可以另外设置署名；它不决定 HTTPS 访问权限：

```bash
git config --global user.name "你的姓名或昵称"
git config --global user.email "GitCode 已验证的邮箱"
```

登录成功后，继续下方的安装、构建和评测步骤。

## 可选：使用 SSH 登录 GitCode

如果此前运行过 HTTPS 登录脚本，需要先在管理容器内移除该仓库的地址改写，才能切回 SSH：

```bash
git config --global --unset-all url.https://gitcode.com/evanTang/AgentBundle.git.insteadOf || true
```

以下命令均在管理容器内执行。Git 的姓名和邮箱只用于提交署名；SSH 访问权限由公钥绑定的 GitCode 账号决定。

```bash
git config --global user.name "你的姓名或昵称"
git config --global user.email "GitCode 已验证的邮箱"

mkdir -p ~/.ssh
chmod 700 ~/.ssh
if [ ! -f ~/.ssh/id_ed25519_gitcode_evaluator ]; then
  ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519_gitcode_evaluator -C "evaluator-toolbox"
fi
cat ~/.ssh/id_ed25519_gitcode_evaluator.pub
```

把输出的完整公钥添加到 GitCode 的「个人设置 → 安全设置 → SSH 公钥」。该账号必须有 `evanTang/AgentBundle` 的读取权限。私钥留在管理容器的专用卷中，不加入仓库。

指定 Git 使用这把密钥，配置会随专用 home 卷保存。容器的 `$HOME` 是 `/toolbox-home`，下列命令同时指定持久化的 known_hosts 路径：

```bash
git config --global core.sshCommand "ssh -F /dev/null -i $HOME/.ssh/id_ed25519_gitcode_evaluator -o IdentitiesOnly=yes -o UserKnownHostsFile=$HOME/.ssh/known_hosts"

# 如果私钥设置了密码，每次进入新管理容器后加载一次。
eval "$(ssh-agent -s)"
ssh-add ~/.ssh/id_ed25519_gitcode_evaluator

git ls-remote ssh://git@gitcode.com/evanTang/AgentBundle.git HEAD
```

首次连接按提示确认主机身份。最后一条成功输出提交哈希后，再安装和构建。

## 在容器中运行实验

启动脚本已挂载 Evaluator 的父目录，同级 `AgentBundle` 可直接访问。按[源码安装](../installation.zh-CN.md#直接安装)完成两仓构建；自定义管理容器时须保留相同的目录挂载。

在同一容器终端按[模型变量设置](../quick-start.zh-CN.md#3-设置模型变量)设置模型服务，再选择[已有 Playbook](../../../playbook/README.md)。例如运行 Terminal-Bench 4.0：

```bash
node dist/cli.js doctor playbook/terminalbench/terminalbench-4.0.yaml
node dist/cli.js run playbook/terminalbench/terminalbench-4.0.yaml
```

该示例默认全量，首次运行先按[场景入门](../quick-start/terminalbench.zh-CN.md)限制题数。结果保存在 YAML 配置的目录；退出容器后，模型环境变量需要重新设置。

需要 Ray 时使用对应 Ray Playbook。正式运行会检查和准备配套本机集群；需要提前准备可执行 `corepack pnpm@11.22.0 ray:ensure`。管理容器退出不会自动停止 Ray 集群，连接参数见[Ray 配置](../config.zh-CN.md#ray-与执行节点)。

## 构建网络与旧 Docker API 的兼容配置

若宿主机网络可用，但普通任务镜像构建无法解析软件源，或者 Docker daemon API 低于 1.49、不支持 `image inspect --platform`，可通过已有的 `environment.config.dockerExecutable` 选择 [本机 Docker 适配脚本](../../../scripts/toolbox/docker-host.sh)。它让镜像构建使用 host 网络；旧 API 的 inspect 先核验镜像架构再读取身份，架构不匹配时仍会报错。

在实际实验 YAML 中选择脚本的绝对路径，相对路径则以 YAML 所在目录为基准：

```yaml
environment:
  name: docker
  config:
    dockerExecutable: /path/to/ember-evaluator/scripts/toolbox/docker-host.sh
```

该脚本面向本机 Linux Docker daemon，不适用于远程 daemon。若仅任务容器默认 bridge 网络无法访问模型，而 host 网络可访问，可对一次运行设置 `EVALUATOR_TOOLBOX_HOST_NETWORK=1`；该选项只影响脚本中未显式指定网络的容器创建。启用后任务容器共享宿主网络，须符合任务要求；`none` 和 `model-api` 等显式策略仍保留。

## ARM64 宿主机上的 x86 模拟与恢复

Docker 环境的 `platform` 缺省为 `auto`。Benchmark 未声明平台时，用户可根据其实际平台要求在 YAML 中指定平台；Benchmark 已声明平台时，YAML 中指定的平台不生效。两处均未指定平台时使用节点原生平台，见 [Docker 目标平台](docker-platform.zh-CN.md)。WorkBuddy Playbook 通过 `linux/amd64` 补充镜像要求，ARM64 服务器需要 x86 模拟支持；Evaluator 警告模拟可能产生性能损耗，然后检测并使用已有模拟器，不安装或修改宿主机注册。管理员确认允许修改宿主机内核设置后，可在宿主机执行：

```bash
docker run --privileged --rm tonistiigi/binfmt --install amd64
cat /proc/sys/fs/binfmt_misc/qemu-x86_64
```

注册作用于宿主机，而不是某个测评容器。`--rm` 会删除安装容器，但注册仍保留；已有原生 ARM 容器继续原生执行，后续 x86 测评与其他容器共享宿主机资源。模拟执行通常较慢。

可以用限制资源且禁用网络的临时容器检查执行能力：

```bash
docker pull --platform linux/amd64 node:24.22.1-bookworm-slim
docker run --rm --platform linux/amd64 --network none --cpus 1 --memory 256m \
  node:24.22.1-bookworm-slim node -p 'process.arch'
```

输出 `x64` 表示 x86 Node 可以执行。停止 x86 测评后，在宿主机撤销注册：

```bash
docker run --privileged --rm tonistiigi/binfmt --uninstall qemu-x86_64
```

也可以直接撤销同一项内核规则，无需启动安装容器：

```bash
printf '%s\n' -1 > /proc/sys/fs/binfmt_misc/qemu-x86_64
```

以上撤销操作适用于原先没有该注册项、由本次操作新增的情况；若原先已有规则，应先保存并按原配置恢复。撤销注册不会删除已缓存的镜像或评测文件。不要在 x86 任务运行过程中撤销注册，否则后续执行 x86 程序可能失败。

## 环境边界

- 当前源码的 `pnpm-workspace.yaml` 将 AgentBundle SDK 指向 `../AgentBundle/packages/core`。toolbox 共享 Evaluator 的父工作目录，因此同级 AgentBundle 可直接访问；提前准备该仓库，在管理容器内安装依赖并先构建 core，再构建 Evaluator。父工作目录下的源码和构建产物与宿主机共享。
- 宿主机必须已有可访问的 `/var/run/docker.sock`。如果你只能进入平台分配的普通容器，又没有这个 socket 或创建当前特权 Docker-in-Docker 服务的权限，需要平台管理员提供支持。
- 管理容器可以按宿主机架构构建，任务平台由独立的解析器决定。WorkBuddy 示例显式选择 amd64；ARM64 节点缺失 x86 模拟支持时返回 `ENV_ARCH_UNSUPPORTED`，可改用原生节点或由管理员配置模拟器。能够进入管理容器和通过 dry-run 不代表任务环境已经可以执行。
- 本方案连接本机 Docker daemon；不直接支持远端 daemon，也不自动处理远端文件传输、rootless Docker 或 SELinux bind mount 策略。
- Docker 卷保存在宿主机的 Docker 存储中；删除管理容器不会删除账号配置和依赖卷。更换人员或回收环境时，由卷的拥有者处理其中的私钥。
- 镜像内软件源沿用仓库的国内镜像。源站连接超时与 SSH 权限是独立问题；必要时调整 Dockerfile 的构建参数或网络配置。

[返回用户手册](../README.zh-CN.md) · [快速上手](../quick-start.zh-CN.md)
