# 网络排障

1. 运行 `ember-evaluator doctor experiment.yaml`，记录失败操作、端点和执行位置。宿主机上的探测只证明宿主机这条链路。Docker daemon、Dockerfile 构建、任务运行时及 Ray 节点按实际位置核对。doctor 检查并给出诊断，应用网络配置是独立操作。
2. 按问题选择设置。下载地址控制请求发往哪个源，代理控制请求经过哪条路径。针对数据集、镜像或包下载的慢链路，可以选 [network Playbook](../../../playbook/network/) 的方案，或复制一份到本地实验目录，调整对应源或代理。模型 API 按模型服务配置单独排查，doctor 不会调用模型验证 API key。
3. 在自己的 `network.yaml` 中保留需要的字段。以下示例假设宿主机上运行着可用的代理，地址必须替换为当前环境的实际值。

   ```yaml
   proxy:
     http: http://127.0.0.1:7890
     https: http://127.0.0.1:7890
     noProxy: [localhost, 127.0.0.1, "::1"]
   ```

   `proxy.overrides.host`、`daemon`、`build` 和 `runtime` 可覆盖各位置的代理。每个位置的 `127.0.0.1` 都指它自身。已有 Docker daemon 的原生拉取需要在该 daemon 上应用代理配置，Docker Desktop 则核对 Desktop 的代理设置。远端 daemon 或 Ray 节点必须能从自己的网络访问代理。认证代理使用环境变量引用，避免把含认证信息的地址写入共享配置。
4. 运行 `inspect experiment.yaml --network network.yaml` 检查实际生效的配置，特别是代理环境变量覆盖。再运行 `doctor experiment.yaml --network network.yaml` 复检，并在预热中验证之前失败的下载步骤。外部插件场景带上原 `--patch`。通过后使用同一网络配置执行后续命令。

查字段、覆盖顺序和部署方式时，读[网络配置参考](../../../docs/users/reference/network.zh-CN.md)和[部署网络](../../../docs/users/deployment/network.zh-CN.md)。
