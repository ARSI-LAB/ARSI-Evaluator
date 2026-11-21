# 网络与 doctor

doctor 先检查配置和运行前置条件，再探测下载连通性。它不调用模型，也不执行任务；宿主机探测通过不等于 Docker daemon、构建容器、任务运行时或 Ray 节点都能访问同一网络。

## 读取 doctor 结果

| 退出码 | 含义 | 处理 |
| --- | --- | --- |
| `0` | 所有已执行检查通过 | 检查输出中是否仍有 `not-checked`；这些项不是通过 |
| `1` | 至少一个检查失败 | 按失败操作、端点、执行位置分类 |
| `2` | 配置错误 | 先修实验 YAML；不要用网络配置掩盖配置错误 |
| `130` | 取消 | 询问用户是否继续 |

对每个失败项记录：

- **操作**：下载数据集、拉取镜像、构建镜像、安装运行时、连接 Ray、访问模型服务。
- **端点**：实际请求的 URL 或主机。
- **位置**：宿主机、Docker daemon、构建容器、任务运行时、Ray 节点。

只有涉及端点、代理、镜像源或下载源的失败才进入网络访谈。缺少本地文件、路径错误、字段拼写错误和依赖缺失先按配置或环境问题处理。

## 网络访谈

```text
doctor 显示 <操作> 在 <位置> 访问 <端点> 失败。需要确认连接方式：
1. [必填] 本机是否有可用的 HTTP(S) 代理？有则给地址；没有回复“无”。
2. [选填] 下载源偏好：官方源 / 镜像源 / ModelScope 归档 / 自建源？默认：官方源。
3. [选填] Docker daemon、构建和任务运行时是否使用不同代理或源？默认：与宿主机相同。
4. [条件必填] 代理需要认证时，凭据放在哪个环境变量？不要发送用户名或密码值。
```

不要虚构代理地址、镜像地址或凭据。用户没有提供时，使用官方源或停止在预检阶段。

## 选择现成配置

优先复用 [network Playbook](../../../playbook/network/)：

| 场景 | 文件 |
| --- | --- |
| 官方源 | `playbook/network/official.yaml` |
| Hugging Face、PyPI、npm、apt 和 Docker Hub 镜像 | `playbook/network/mirrors.yaml` |
| Terminal-Bench 任务镜像从 ModelScope 下载 | `playbook/network/archives.yaml` |

复制到实验目录后再改，或直接通过 `--network` 引用仓库中的文件。每次命令都要重复传入同一个 `--network`。

## 自定义代理

```yaml
proxy:
  http: http://127.0.0.1:7890
  https: http://127.0.0.1:7890
  noProxy: [localhost, 127.0.0.1, "::1"]
  # overrides:
  #   host: {http: "${HOST_HTTP_PROXY}", https: "${HOST_HTTPS_PROXY}"}
  #   daemon: {http: "${DAEMON_HTTP_PROXY}", https: "${DAEMON_HTTPS_PROXY}"}
  #   build: {http: "${BUILD_HTTP_PROXY}", https: "${BUILD_HTTPS_PROXY}"}
  #   runtime: {http: "${RUNTIME_HTTP_PROXY}", https: "${RUNTIME_HTTPS_PROXY}"}
```

注意：

- 每个位置的 `127.0.0.1` 指该位置自身。容器内的回环地址不是宿主机。
- Docker daemon 使用自己的拉取通道时，需要在该 daemon 上配置代理；只在宿主机设置环境变量不够。
- 远端 daemon 或 Ray 节点必须能从自己的网络访问代理地址。
- 认证代理用环境变量引用，例如 `${PROXY_URL}`，不要把用户名密码写进共享 YAML。

## 自定义下载源

```yaml
sources:
  huggingface: https://hf-mirror.com
  python:
    index: https://mirrors.aliyun.com/pypi/simple
    extraIndexes: []
    interpreter: null
  npm:
    registry: https://registry.npmmirror.com
  node:
    dist: https://npmmirror.com/mirrors/node
  github:
    api: https://api.github.com
    raw: https://raw.githubusercontent.com
    repository: https://github.com
  apt:
    debian: https://mirrors.aliyun.com/debian
    debianSecurity: https://mirrors.aliyun.com/debian-security
    ubuntu: https://mirrors.aliyun.com/ubuntu
    ubuntuSecurity: https://mirrors.aliyun.com/ubuntu
    ubuntuPorts: https://mirrors.aliyun.com/ubuntu-ports
docker:
  pull:
    method: docker
  mirrors:
    docker.io: https://dockerproxy.net/
  benchmarks: {}
  buildNetwork: default
git:
  ssh:
    route: direct
```

只保留用户确认要使用的字段。未填写的字段使用程序默认值；受支持的环境变量会覆盖 YAML。

## Docker 镜像来源

任务镜像可以继续用 Docker 拉取，也可以从归档下载：

```yaml
docker:
  pull:
    method: docker
  benchmarks:
    terminalbench:
      method: archive
      provider: modelscope
      baseUrl: https://modelscope.cn/datasets/evolving-foundry/ember-evaluator/resolve/master/terminalbench4.0
```

`provider` 取 `modelscope` 或 `huggingface`；只对支持归档获取的 Benchmark 使用。先确认远端已发布所选任务、版本和平台。

## 复检与后续命令

生成或修改 `network.yaml` 后，用同一份文件重新执行：

```bash
arsi-evaluator inspect <experiment.yaml> --network <network.yaml>
arsi-evaluator doctor  <experiment.yaml> --network <network.yaml>
arsi-evaluator run     <experiment.yaml> --network <network.yaml> --progress plain
```

注意：

- `inspect` 不探测下载连通性，网络是否可用以 doctor 和实际下载为准。
- doctor 通过后仍要观察 run 中的准备阶段；镜像、数据集和运行时可能在不同位置下载。
- 使用外部插件时，inspect、doctor、run 都要带同一个 `--patch`。
- Ray 节点不接收协调端的本机网络路径；节点使用自己的网络配置和认证。涉及 Ray 时，分别核对每个节点。

字段和覆盖顺序见[网络配置参考](../../../docs/users/reference/network.zh-CN.md)和[部署网络](../../../docs/users/deployment/network.zh-CN.md)。常见失败见[网络 FAQ](../../../docs/users/faq/network.zh-CN.md)。
