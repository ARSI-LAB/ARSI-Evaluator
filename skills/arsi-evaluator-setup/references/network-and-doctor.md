# 网络与 doctor

doctor 先检查配置和运行前置条件，再探测下载连通性。它不调用模型，也不执行任务；宿主机探测通过不等于 Docker daemon、构建容器、任务运行时或 Ray 节点都能访问同一网络。

## 读取 doctor 结果

| 退出码 | 含义 | 处理 |
| --- | --- | --- |
| `0` | 无 `failed` 检查，且 `network.status` 为 `passed` | 检查输出中是否仍有 `not-checked`；这些项不是通过 |
| `1` | 存在 `failed` 检查，或 `network.status` 不为 `passed`（如 `incomplete`） | 先区分：有 `failed` 时按操作、端点、执行位置分类；仅 `not-checked` 导致 `incomplete` 时表示证据不足，不等于网络失败 |
| `2` | 配置错误 | 先修实验 YAML；不要用网络配置掩盖配置错误 |
| `130` | 取消 | 询问用户是否继续 |

对每个失败项记录：

- **操作**：下载数据集或相关文件、探测镜像仓库、访问运行时包管理器（pip/uv/npm/pnpm）、连接 Ray 或检查 Ray 前置条件。doctor 不构建镜像、不安装依赖。
- **端点**：实际请求的 URL 或主机。
- **位置**：宿主机、Docker daemon、任务运行时、Ray 节点；doctor 未标明时记为“未知”，不要按端点自行推断。

省略 `--network` 时，doctor 会加载用户级默认配置（例如当前用户目录下的 `.arsi-evaluator/network.yaml`）。它可能与实验目录里的网络文件不同；诊断时以输出中的 `network.configPath` 为准，需要可复现时始终显式传 `--network`。

doctor 不访问模型服务（`model and task execution` 恒为 `not-checked`），模型连通性用后续独立的 `/models` 核对，不要混进网络失败分类。

只有涉及端点、代理、镜像源或下载源的失败才进入网络访谈。缺少本地文件、路径错误、字段拼写错误和依赖缺失先按配置或环境问题处理。

超时、连接重置、DNS 临时失败等可能是瞬时故障：原样重跑一次 `doctor`，同一项再次失败再进入故障定位。401 先检查认证配置，不盲目重试。403 先看响应头和响应体区分权限不足、策略拒绝与速率限制，只有明确的 rate-limit 信息才按限流处理。404 先检查 URL、资源路径和版本。配置错误、缺少本地文件和路径错误直接修复，不通过重试处理。退出码 `130` 不自动重跑，先询问用户。

## 网络访谈

先确认失败发生在哪一层。doctor 没有标明位置时先记为“未知”，再查 daemon、builder 或 Ray 节点，不要默认复用本机代理。远程 Docker daemon、远程 BuildKit builder 或 Ray 节点上的失败，先确认该节点自身能否访问代理；本机有代理不代表远端可用。

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
- `noProxy` 按主机名生效，同一域名族的不同子域可能完全不同。`github.com`、`api.github.com`、`raw.githubusercontent.com` 要分别验证，不能因为其中一个可用就推断其它可用。匹配规则以当前网络配置实现为准：不要假设加父域名一定覆盖所有子域，也不要假设每个子域都必须单独配置。对每个实际使用的端点分别验证直连和代理：

  ```bash
  # 强制直连，忽略 shell 里已有的代理变量
  curl --noproxy '*' -sS -o /dev/null -w '%{http_code}\n' --max-time 10 <url>
  # 强制走指定代理，清空 no_proxy 绕过规则
  curl --proxy "$PROXY_URL" --noproxy '' -sS -o /dev/null -w '%{http_code}\n' --max-time 10 <url>
  ```

  返回 `000` 表示没有拿到 HTTP 响应码，要结合 curl 的 stderr 判断是 DNS、连接、TLS 还是超时，不要当成 HTTP 状态码。
- 403 不一定是限流。先看响应头 `X-RateLimit-Remaining`、`X-RateLimit-Reset` 和响应体：只有明确的 rate-limit 信息才按限流处理，否则按权限或策略拒绝处理。未认证的 GitHub API 限额是 60 次/小时/IP，共享代理出口容易触发；`api.github.com` 直连正常且无 rate-limit 提示时可加入 `noProxy`，直连也受限时换出口节点或镜像源，不要反复重试。
- 环境变量会覆盖**所有**位置的对应字段，包括 YAML 里显式写的 `null`，大写变量优先于小写：

  | 环境变量 | 覆盖字段 | 说明 |
  | --- | --- | --- |
  | `HTTP_PROXY` / `http_proxy` | `proxy.http` | 两者同时存在时大写优先 |
  | `HTTPS_PROXY` / `https_proxy` | `proxy.https` | 两者同时存在时大写优先 |
  | `NO_PROXY` / `no_proxy` | `proxy.noProxy` | 逗号分隔后转为数组 |
  | `ALL_PROXY` | 不覆盖网络配置 | 不参与替换，但会影响同一终端里手动执行的 `curl`、`pip` 等命令 |

  终端里已经导出过代理时，访谈得出的 build/runtime 分层会被静默改写，`inspect` 输出也会显示被覆盖后的值。配置前先确认这些变量是否存在；需要按位置区分时，先在当前终端清除它们，再重新 `inspect` 核对。
- 容器内的 `127.0.0.1` 不是宿主机；Docker 直接运行在 WSL 内时 `host.docker.internal` 通常不可解析。Docker Desktop、WSL 内独立安装的 Docker Engine 和远程 daemon 的网络行为不同，必须以实际运行环境验证。构建阶段能否复用宿主回环代理取决于构建器，任务运行阶段不能。典型分层写法：

```yaml
proxy:
  http: http://127.0.0.1:7890
  https: http://127.0.0.1:7890
  overrides:
    build: {http: http://127.0.0.1:7890, https: http://127.0.0.1:7890}
    runtime: {http: null, https: null}
docker:
  buildNetwork: host
```

`buildNetwork: host` 中的 `host` 指构建器所在的网络命名空间，不一定是用户当前操作的机器。本地 Docker Engine 下它通常等于宿主机；Docker Desktop、远程 daemon 或远程 BuildKit builder 下不是，此时 `127.0.0.1:7890` 指向构建器自身。使用前先确认 daemon 和 builder 的位置，以及构建器是否支持 `host` 网络。`docker run` 验证的是运行网络，不等于 BuildKit 构建网络。`runtime` 置 `null` 表示任务容器自行出网，只适合容器能直连所需下载源的网络；先用实际镜像验证目标域名，不要默认成立。

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
