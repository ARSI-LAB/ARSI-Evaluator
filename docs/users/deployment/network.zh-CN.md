# 部署环境的网络配置

> [English](network.md) | 中文

[网络配置入口](../network.zh-CN.md)

## Docker 构建与 daemon 代理

### 预热期间的镜像与依赖下载

同一次 `warmup` 可能需要下载现成镜像、构建任务镜像和安装依赖。这些步骤的下载地址和代理分别配置：

| 操作 | 下载地址 | 代理 |
| --- | --- | --- |
| 主动获取镜像，`method: docker` | 按 `docker.mirrors` 替换 Registry 地址，再执行 `docker pull` | Docker daemon 或 Docker Desktop 的代理 |
| 主动获取镜像，`method: registry-client` | 按 `docker.mirrors` 替换 Registry 地址，由 Node.js 或 skopeo 下载 | Evaluator 进程使用的 `host` 代理 |
| 从 ModelScope 或 Hugging Face 获取任务镜像 | `docker.benchmarks.<题库名>` 下的 `baseUrl` | Evaluator 进程使用的 `host` 代理 |
| Dockerfile 的 `FROM` 和外部 `COPY --from` | Docker daemon 或 BuildKit 的镜像仓库配置 | Docker daemon 或 Docker Desktop 的代理 |
| Dockerfile 的 `RUN` 安装依赖 | `sources` 中对应的包源，或命令指定的地址 | `proxy.overrides.build` |
| Harness 运行时安装依赖 | `sources` 中对应的包源，或安装器指定的地址 | `proxy.overrides.runtime` |

例如，SWE-bench 可能先通过 Dockerfile 的 `FROM` 下载任务镜像，再准备 Node 运行环境。`FROM` 失败时先检查 Docker daemon 到该镜像仓库的连接；后续需要下载的 Node 镜像仍按 `docker.pull` 和 `docker.mirrors` 获取。各种下载方式见[镜像下载](../image-downloads.zh-CN.md)。

网络 YAML 的 `docker.mirrors` 不会修改 daemon 的 `registry-mirrors`。将 YAML 代理设为 `null` 也不会关闭已在 Docker Desktop 或 daemon 中启用的代理。

`docker.buildNetwork` 可选 `default` 或 `host`，只控制构建步骤的网络，不改变任务运行时的网络权限。

### 应用 Docker 代理建议

运行诊断查看 Docker 代理建议：

```bash
ember-evaluator doctor experiment.yaml --network network.yaml
```

输出中的 `network.dockerAdvice` 提供建议。按 Docker 的部署方式应用：

- Linux Engine：修改 daemon 配置时保留其他设置，确认配置有效后由管理员重启。
- Docker Desktop：在 Desktop 设置中配置代理，不使用 `daemon.json` 的代理字段。
- 远端 Docker：在远端 daemon 所在主机配置，本机代理设置不能代替远端设置。

诊断使用当前 Docker context。确认连接的是预期 daemon 后再调整配置；Evaluator 不会自动重启 Docker。

## 源码启动与部署

首次安装依赖前，就可以通过仓库启动器使用网络 YAML。Node.js 和 pnpm 版本需符合 `package.json`：

```bash
node scripts/network/bootstrap.mjs --network network.yaml -- pnpm install --frozen-lockfile
node scripts/network/bootstrap.mjs --network network.yaml -- pnpm ray:ensure
```

toolbox 使用 `EVALUATOR_NETWORK_CONFIG` 指定的文件，或用户目录下的默认网络文件。启动器会把该文件用于安装、构建和管理容器。

Ray 节点需要能访问配置中的下载地址和代理。`${VARIABLE}` 引用需要在对应节点设置；选择 skopeo 后端时，也需要在执行下载的节点预装 skopeo。

Docker-in-Docker 服务首次创建时会应用 daemon 代理。已有服务修改网络配置后，需由管理员按启动器提示重建服务。使用配套启动器及其生成的 Compose 配置启动，避免手工启动时遗漏网络设置。

部署后先用 `doctor` 检查，再用 `warmup` 准备少量实际任务。第三方脚本写死的下载地址可能不受网络 YAML 控制；出现这种情况，需要修改对应脚本或工具配置。完整操作见[网络诊断](../faq/network.zh-CN.md)。
