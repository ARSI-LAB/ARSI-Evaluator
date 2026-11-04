# 任务镜像归档

将每个任务的镜像分别用 `docker save` 导出并 gzip 压缩，上传至 ModelScope 或 Hugging Face。Evaluator 根据实验选中的任务、平台、阶段和服务拼接文件地址，不扫描目录，不下载其他任务的镜像。

## 网络配置

```yaml
version: 1
docker:
  pull:
    method: docker
  benchmarks:
    terminalbench:
      method: archive
      provider: modelscope
      baseUrl: https://modelscope.cn/datasets/your-org/task-images/resolve/master/terminalbench4.0
```

Hugging Face 使用 `provider: huggingface`，根地址示例为 `https://huggingface.co/datasets/your-org/task-images/resolve/main/terminalbench4.0`。`baseUrl` 必须是文件下载根地址，不是仓库预览页面；建议使用固定的仓库 revision 或发布目录。

## 文件布局

```text
terminalbench4.0/
└── vf2-speedup-networkx/
    └── linux/
        ├── amd64/
        │   ├── solve.tar.gz
        │   └── verify.tar.gz
        └── arm64/
            ├── solve.tar.gz
            └── verify.tar.gz
```

任务 ID 为 `terminal-bench/vf2-speedup-networkx` 时，下载目录使用 `vf2-speedup-networkx`，不包含 `terminal-bench` 前缀。任务 ID 含斜杠时删除第一段命名空间，其余相对路径保留；不含斜杠时直接使用任务 ID。主镜像路径为 `<baseUrl>/<任务相对路径>/<platform>/<phase>.tar.gz`。服务镜像路径为 `<baseUrl>/<任务相对路径>/<platform>/<phase>/services/<service>.tar.gz`，例如 `linux/arm64/solve/services/api.tar.gz`。程序对任务 ID 的各段和服务名执行 URL 编码，拒绝空任务路径段和 `.`、`..`。只需准备任务真正使用的阶段和服务镜像。

归档方式使用实验 `environment.platform` 显式选择的平台，`auto` 使用执行节点原生平台，不采用原 Registry 镜像的平台声明。发布者负责确保对应目录中的镜像能在目标平台运行。归档方式优先于本机原 Registry 镜像缓存。

## 导出和执行

在 Linux/WSL 中导出一个镜像：

```bash
docker image save --output solve.tar <本机镜像引用>
gzip solve.tar
```

分别导出解题、验证及任务服务镜像。一个文件只放一个镜像；使用 `docker save`，不使用 `docker export`。文件名必须与上述路径相符。无需生成 catalog.json、SHA256SUMS 或原始 Manifest。

以下评测命令使用已注册的 `ember-evaluator`，注册步骤见[安装指南](../users/installation.zh-CN.md#安装全局命令)。

```bash
ember-evaluator warmup experiment.yaml --network network.yaml
ember-evaluator run experiment.yaml --network network.yaml
```

下载完成后直接 `docker load --input`，读取返回的镜像引用并添加 Evaluator 标签。Evaluator 不检查归档格式、镜像平台、文件 SHA-256、原 Registry 摘要或导入身份。下载器仍处理连接失败、取消、流错误和不完整响应；Docker 的加载错误直接使本次准备失败。程序不改变 Docker 对归档的原生处理，包内原始标签可能被恢复或覆盖。

本机按下载 URL 对应的 Evaluator 镜像标签缓存。标签存在时不重新下载；镜像 ID 等元数据仍用于 Runtime/Solver 构建。覆盖远端同名文件后，清理对应本机镜像或换用新版本地址。内部下载文件的内容摘要仅用于缓存命名，不要求发布者提供校验值。

HF 请求使用执行节点的 `HF_TOKEN`；ModelScope 使用 `MODELSCOPE_API_TOKEN`。公开文件不需要 Token，认证不写进配置或归档。`doctor` 无法仅凭根目录确认具体镜像可用，会提示执行 `warmup`。

## 从清单方式迁移

1. 删除网络 YAML 中的 `catalogs`，填写 `provider` 和 `baseUrl`。旧配置会报未知字段，不自动兼容。
2. 将 `vf2-speedup-networkx/solve-linux-amd64.tar.gz` 移到 `vf2-speedup-networkx/linux/amd64/solve.tar.gz`；验证镜像同理改为 `verify.tar.gz`。镜像包内容无需修改。
3. catalog.json 和 SHA256SUMS 不再使用，可从远端移除。
4. 用选择单题的实验执行 `warmup`，确认目标路径存在且 Docker 能加载镜像。
