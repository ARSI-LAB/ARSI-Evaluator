# 下载 Docker 与 ModelScope 镜像

> [English](image-downloads.md) | 中文

[网络配置入口](network.zh-CN.md)

镜像获取配置分为两层：

1. 用 `docker.pull.method` 选择默认方式，供共享镜像和未单独配置的题库任务镜像使用。示例：[Docker 原生拉取](#docker-原生拉取)、[Node.js 下载后端](#nodejs-下载后端)、[skopeo 下载后端](#skopeo-下载后端)。
2. 按需添加 `docker.benchmarks.<题库名>`，为指定题库的任务镜像单独选择获取方式。示例：[在默认配置上添加 ModelScope 任务镜像下载](#从-modelscope-下载任务镜像)。

## 从 ModelScope 下载任务镜像

使用 ModelScope 时，在同一份网络文件中保留 `docker.pull` 默认配置，再添加 `docker.benchmarks.terminalbench`，将 Terminal-Bench 的任务镜像改为归档下载；共享镜像继续使用 `docker.pull` 指定的方式。

先按 [Terminal-Bench 入门](quick-start/terminalbench.zh-CN.md)准备 Docker、模型和选题，再在仓库根目录执行：

```bash
ember-evaluator warmup playbook/terminalbench/terminalbench-4.0.yaml --network playbook/network/archives.yaml
ember-evaluator run playbook/terminalbench/terminalbench-4.0.yaml --network playbook/network/archives.yaml
```

`archives.yaml` 文件内容为：

```yaml
docker:
  # 共享镜像（如 Node）：通过 docker pull 获取。
  # 未单独配置获取方式的题库任务镜像也使用此设置。
  pull:
    method: docker
  # Terminal-Bench 任务镜像：从 ModelScope 下载归档并加载到 Docker。
  benchmarks:
    terminalbench:
      method: archive
      provider: modelscope
      # Official image repository; adjust the benchmark directory as needed.
      baseUrl: https://modelscope.cn/datasets/evolving-foundry/ember-evaluator/resolve/master/terminalbench4.0
```

`terminalbench` 对应实验中的 `benchmark.name`，`baseUrl` 指向该版本镜像归档的下载目录。程序根据所选任务和平台下载解题、验证及服务镜像，再自动加载到 Docker，无需手动下载或执行 `docker load`。只有远端已发布的任务和平台可用；文件缺失会报错，不会自动改从原 Registry 拉取。

本例以 `docker.pull.method: docker` 为默认配置，再单独指定 Terminal-Bench 的任务镜像来源：

| 镜像类别 | 使用的配置 | 获取方式 |
| --- | --- | --- |
| Node 等共享镜像 | `docker.pull` | 执行 `docker pull` |
| Terminal-Bench 的解题、验证和服务镜像 | `docker.benchmarks.terminalbench` | 从 ModelScope 下载归档，再执行 `docker load` |
| 未单独配置的其他题库任务镜像 | `docker.pull` | 执行 `docker pull` |

也可以将 `docker.pull` 改为 `method: registry-client`，并选择 `backend: nodejs` 或 `skopeo`：共享镜像及未单独配置的题库任务镜像改用对应后端，Terminal-Bench 的任务镜像仍从 ModelScope 下载。

任务数据和依赖包的下载地址仍由 `sources` 控制。若同时需要包镜像源，可复制 `mirrors.yaml` 为自己的 `network.yaml`，将上面的 `benchmarks` 内容加入已有的 `docker` 下，保留原有 `pull` 和 `mirrors`；不要重复写两个顶层 `docker:`。运行时只传 `--network network.yaml`。

示例实验默认全量选题，预热也会准备全部所选任务；首次使用可按入门指南限制题数。

## 镜像获取方式

先选择 `docker.pull` 的默认获取方式，省略时默认为 `method: docker`。`docker.pull.method` 只接受 `docker` 或 `registry-client`，后者可选择 Node.js 或 skopeo 后端：

| 配置 | 行为 | 具体示例 |
| --- | --- | --- |
| `method: docker` | 默认；执行 `docker pull --platform`，HTTP 代理由 daemon 决定 | [Docker 原生拉取](#docker-原生拉取) |
| `method: registry-client`，`backend: nodejs` | Evaluator 下载镜像内容，再导入 Docker | [Node.js 下载后端](#nodejs-下载后端) |
| `method: registry-client`，`backend: skopeo` | 调用预装 skopeo；可设置 `skopeoExecutable`，不会自动安装或切换后端 | [skopeo 下载后端](#skopeo-下载后端) |

需要额外指定任务镜像来源时，再添加 `docker.benchmarks.<实验选择的 benchmark 标识>`。其中的 `method: archive` 优先于该题库的默认获取方式；完整示例见上方的 [ModelScope 配置](#从-modelscope-下载任务镜像)。它可以与表中的任意一种默认配置组合，同一个任务镜像只使用选中的一种方式。

以下三个示例分别展示默认配置，均未添加题库专属设置，各自使用独立的网络文件。将 `experiment.yaml` 换成自己的 Docker 实验配置；准备 Docker、模型和选题的方法见 [Terminal-Bench 入门](quick-start/terminalbench.zh-CN.md)。

### Docker 原生拉取

需要由 Docker daemon 拉取 Registry 镜像时，将以下内容保存为 `network-docker.yaml`：

```yaml
docker:
  pull:
    method: docker
```

执行预热，下载所选任务需要的镜像和依赖：

```bash
ember-evaluator warmup experiment.yaml --network network-docker.yaml
```

本例没有题库专属配置，因此任务镜像和 Node 等共享镜像都通过 `docker pull` 获取。需要使用 DockerProxy 等 Registry 镜像源时，可在同一文件中添加 `docker.mirrors`，配置方法见[修改镜像源](reference/network.zh-CN.md#修改下载地址)。daemon 的代理设置见[部署网络配置](deployment/network.zh-CN.md#docker-构建与-daemon-代理)。

### Node.js 下载后端

需要让 Evaluator 进程负责 Registry 下载时，将以下内容保存为 `network-nodejs.yaml`：

```yaml
docker:
  pull:
    method: registry-client
    backend: nodejs
```

```bash
ember-evaluator warmup experiment.yaml --network network-nodejs.yaml
```

本例通过内置 Node.js 下载器获取任务镜像和共享镜像的 Registry 内容，再导入 Docker；无需安装 skopeo，但仍需要可用的 Docker daemon。下载请求使用 Evaluator 进程的代理，设置方法见[代理配置](reference/network.zh-CN.md#设置代理)。省略 `backend` 时也默认使用 `nodejs`。

### skopeo 下载后端

执行节点已安装 skopeo、需要使用它下载 Registry 镜像时，将以下内容保存为 `network-skopeo.yaml`：

```yaml
docker:
  pull:
    method: registry-client
    backend: skopeo
    skopeoExecutable: skopeo
```

```bash
ember-evaluator warmup experiment.yaml --network network-skopeo.yaml
```

`skopeoExecutable` 可以省略，默认从 `PATH` 查找 `skopeo`；也可改为执行节点上的程序绝对路径。skopeo 需要支持 `copy --preserve-digests`，程序不会自动安装它。下载后仍会导入 Docker；Ray 使用该后端时，每个实际执行下载的节点都要预装 skopeo，见[源码启动与部署](deployment/network.zh-CN.md#源码启动与部署)。

以上预热完成后，将对应命令中的 `warmup` 换成 `run` 即可开始评测，继续使用相同的网络文件。若预热失败，用相同参数执行 `doctor`，处理方法见[网络诊断](faq/network.zh-CN.md)。

### Registry 镜像源、登录与缓存

`docker.mirrors` 为指定镜像仓库设置镜像源。例如，配置 `docker.io: https://dockerproxy.net/` 后，下载 `ubuntu:24.04` 时会使用 `dockerproxy.net/library/ubuntu:24.04`。镜像的标签或固定摘要保持不变；这条配置只影响 Docker Hub，不影响 GHCR 等其他仓库。

下载私有仓库镜像前，先在实际执行下载的机器上使用 `docker login` 登录。`registry-client` 使用当前执行用户的 Docker 登录信息；Ray 下载发生在执行节点上，需要在对应节点配置登录信息。

使用 `registry-client` 时，同一镜像和平台的本机缓存仍可用，就会直接复用，无需重新下载。使用 `method: docker` 时，Docker 自己管理镜像层缓存。

下载或导入 Docker 失败时，程序会报错，不会自动切换镜像源或获取方式。

### 归档路径与缓存

`method: archive` 的具体配置见开头的 [ModelScope 示例](#从-modelscope-下载任务镜像)。使用 Hugging Face 时，改为 `provider: huggingface` 并填写对应下载根地址，示例见[归档网络配置](../development/image-archives.md#网络配置)。

归档地址由 `baseUrl`、任务路径、平台和阶段组成。例如 `terminal-bench/vf2-speedup-networkx` 的解题镜像使用 `<baseUrl>/vf2-speedup-networkx/linux/amd64/solve.tar.gz`，验证镜像改为 `verify.tar.gz`；服务镜像放在 `<阶段>/services/<服务名>.tar.gz`。准备自己的归档时，按[文件布局](../development/image-archives.md#文件布局)组织。

解题基础镜像的本地标签，例如 `ember-evaluator/terminalbench4.0/vf2-speedup-networkx:linux-amd64-base`，对应远端 `vf2-speedup-networkx/linux/amd64/solve.tar.gz`。Evaluator 根据镜像 ID 分配或复用本地引用。Solver 成品在执行节点构建。

Evaluator 检查归档的平台和镜像 ID，通过临时引用导入 Docker。归档里的发布者标签不会恢复。相同镜像 ID 的归档共用一个本地引用。需要核对归档与原仓库是否一致时，可按下方方法比较镜像 ID。

用 `environment.platform` 选择归档平台，`auto` 使用执行节点的原生平台。同一下载地址优先复用已有镜像，清理镜像后可以用本机缓存的归档重新导入。不同下载地址各自记录下载结果。发布更新时请换用新的版本地址。

官方维护的 ModelScope 仓库为 [evolving-foundry/ember-evaluator](https://www.modelscope.cn/datasets/evolving-foundry/ember-evaluator)，存放部分 Benchmark 的官方任务镜像归档。可用镜像以仓库目录为准；上传自己的镜像见[单个和批量上传指引](../development/image-archives.md#上传到-modelscope)。

### 核验 ModelScope 镜像

比较同一平台下的完整镜像 ID：**ID 相同，就是同一个镜像，名称和标签可以不同。**

下面以 `linux/amd64` 为例，替换镜像引用和文件路径后，按顺序执行：

```bash
# 1. 拉取官方镜像，记下输出的完整 ID
docker pull --platform linux/amd64 '官方镜像:标签'
docker image inspect --platform linux/amd64 --format '{{.Id}}' '官方镜像:标签'

# 2. 加载 ModelScope 下载的归档
docker load --input solve.tar.gz

# 3. 使用上一步 Loaded image 输出的引用，查看 ID，与第 1 步比较
docker image inspect --platform linux/amd64 --format '{{.Id}}' '导入后的镜像引用'
```

先记下官方 ID，再加载归档，避免同名标签被覆盖。若 ID 不同，检查是否使用了相同版本和平台，或误打包了 Runtime/Agent 镜像；官方 tag 更新也会导致 ID 不同。

## 归档下载认证

ModelScope 使用执行节点的 `MODELSCOPE_API_TOKEN`，Hugging Face 使用 `HF_TOKEN`；公开文件不需要 Token。认证信息通过环境变量提供，不写进网络文件。
