# 在管理容器中安装和运行评测

> [English](./container-toolbox.md) | 中文

适用于已有 Docker Engine 的 Linux 服务器。宿主机需准备 Evaluator 仓库，并能访问 `/var/run/docker.sock`；Node.js、pnpm 和 Python 等依赖由管理容器提供。

## 在宿主机启动管理容器

在宿主机的 Evaluator 仓库根目录执行：

```bash
bash scripts/toolbox/run.sh
```

首次启动会构建镜像，完成后进入容器终端。退出后，再执行同一命令即可重新进入。

## 在管理容器安装 Evaluator

在容器内的仓库根目录按[安装指南](../installation.zh-CN.md#直接安装)安装，确认 `ember-evaluator --help` 正常输出。容器已配置好 pnpm。

## 在容器中运行实验

按[快速上手](../quick-start.zh-CN.md)设置模型变量并准备配置，然后运行：

```bash
ember-evaluator doctor /path/to/config.yaml
ember-evaluator run /path/to/config.yaml
```

示例配置见 [Playbook](../../../playbook/README.md)。重新进入容器后需要重新设置模型变量；使用 Ray 时，参阅 [Ray 配置](../config.zh-CN.md#ray-与执行节点)。

需要另开终端进入正在运行的容器时，在宿主机执行：

```bash
docker exec -it ember-evaluator-toolbox bash
```

## 环境边界

- 源码和评测结果与宿主机共享；依赖和 Git 配置保存在 Docker 卷中，退出容器后保留。
- 容器使用宿主机 Docker，可以管理其容器和镜像。
- 保留启动脚本设置的挂载路径。本方案不适用于 Windows Docker Desktop 或远程 Docker daemon。
- 退出管理容器不会自动停止 Ray 集群。

<details>
<summary>特殊环境与排障（按需查看）</summary>

## 构建网络与旧 Docker API 的兼容配置

管理容器已自动配置 Docker 适配脚本。自行部署时，若遇到镜像构建网络问题或旧 Docker API 错误，可在 YAML 中指定：

```yaml
environment:
  name: docker
  config:
    dockerExecutable: /path/to/ember-evaluator/scripts/toolbox/docker-host.sh
```

该脚本仅适用于本机 Linux Docker。下载和网络问题见 [Docker 排障](../faq/docker.zh-CN.md)。

## ARM64 宿主机上的 x86 模拟与恢复

在 ARM64 服务器上运行 amd64 镜像需要 QEMU。缺失时，管理员可在宿主机执行以下命令；它会修改宿主机的模拟器注册：

```bash
docker run --privileged --rm tonistiigi/binfmt --install amd64
```

仅当该注册由本次新增时，停止 x86 任务后可撤销：

```bash
docker run --privileged --rm tonistiigi/binfmt --uninstall qemu-x86_64
```

模拟运行可能较慢，优先使用与镜像架构匹配的机器。平台选择规则见 [Docker 目标平台](docker-platform.zh-CN.md)。

</details>

[返回用户手册](../README.zh-CN.md) · [快速上手](../quick-start.zh-CN.md)
