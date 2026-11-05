# 任务镜像归档

将每个任务的镜像分别用 `docker save` 导出并 gzip 压缩，上传至 ModelScope 或 Hugging Face。Evaluator 根据实验选中的任务、平台、阶段和服务拼接文件地址，不扫描目录，不下载其他任务的镜像。

## 官方维护仓库

[evolving-foundry/ember-evaluator](https://www.modelscope.cn/datasets/evolving-foundry/ember-evaluator) 是 Evaluator 官方维护的 ModelScope 数据集仓库，存放部分 Benchmark 的官方任务镜像归档。可用题库、任务和平台以仓库文件目录为准；下文的 `terminalbench4.0` 路径用于说明目录布局，不代表所有示例镜像均已上传。

用户可以下载已发布的镜像，也可以将镜像上传到自己有写入权限的 ModelScope 数据集仓库。向官方仓库上传需要该仓库的写入权限。

## 网络配置

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
      baseUrl: https://modelscope.cn/datasets/evolving-foundry/ember-evaluator/resolve/master/terminalbench4.0
```

`docker.pull` 控制 Node 等共享镜像及未单独配置的题库任务镜像；`docker.benchmarks.terminalbench` 为 Terminal-Bench 任务镜像指定 ModelScope 归档来源。前者执行 `docker pull`，后者下载归档后执行 `docker load`。

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

## 导出镜像

在 Linux/WSL 中导出一个镜像：

```bash
docker image save --output solve.tar <本机镜像引用>
gzip solve.tar
```

分别导出解题、验证及任务服务镜像。一个文件只放一个镜像；使用 `docker save`，不使用 `docker export`。文件名必须与上述路径相符。无需额外生成下载清单或校验文件。

## 上传到 ModelScope

以下命令在 Linux/WSL 的 Bash 中执行，使用 Python 3.10+ 和 ModelScope 官方的 [modelscope-hub CLI](https://github.com/modelscope/modelscope_hub#ms-hub-upload)。

### 安装、登录和选择仓库

先准备一个有写入权限的数据集仓库。使用自己的新仓库时，先在 ModelScope 网页创建数据集，再将下面的 `repo` 改成 `用户名或组织名/仓库名`。从 [访问令牌页面](https://modelscope.cn/my/access/token) 获取有写入权限的 Token，在登录提示中输入：

```bash
python -m pip install --upgrade modelscope-hub
ms-hub login

# 改成你要上传到的数据集仓库；此处以官方仓库为例
repo='evolving-foundry/ember-evaluator'
```

后续命令在同一个 Bash 会话执行。`--repo-type dataset` 指定数据集仓库，`--revision master` 指定上传分支。

### 上传单个镜像

将本地 `solve.tar.gz` 上传到指定任务、平台和阶段的路径：

```bash
ms-hub upload "$repo" ./solve.tar.gz \
  terminalbench4.0/vf2-speedup-networkx/linux/amd64/solve.tar.gz \
  --repo-type dataset --revision master
```

上传验证镜像时，将本地文件和远端文件名改成 `verify.tar.gz`；服务镜像使用前文的 `<阶段>/services/<服务名>.tar.gz` 路径。

### 批量上传镜像

先按前文的文件布局，把多个任务的压缩包放进本地 `terminalbench4.0/` 目录，再执行：

```bash
ms-hub upload "$repo" ./terminalbench4.0 terminalbench4.0 \
  --repo-type dataset --revision master \
  --include '*.tar.gz' --max-workers 4 --use-cache
```

该命令递归上传目录中的 `.tar.gz` 文件，保留相对目录结构。例如本地 `terminalbench4.0/vf2-speedup-networkx/linux/amd64/solve.tar.gz` 会上传到仓库中的同一路径，不会重复添加两层 `terminalbench4.0`。中断后可重跑同一命令，利用上传缓存继续处理。

单个和批量上传都会更新同路径文件；发布新版本时建议换用新的目录或分支，避免已有下载缓存继续使用旧镜像。

### 上传后配置下载

在仓库文件页面确认上传路径，再将网络 YAML 中的 `baseUrl` 设置为对应题库目录的下载地址。例如，上传到官方仓库的 `master` 分支、`terminalbench4.0/` 目录时：

```yaml
baseUrl: https://modelscope.cn/datasets/evolving-foundry/ember-evaluator/resolve/master/terminalbench4.0
```

上传到其他仓库、分支或目录时，替换 URL 中对应部分。使用下方 `warmup` 命令验证选中任务的镜像能下载、加载；需要确认镜像与官方版本一致时，按[镜像 ID 核验方法](../users/image-downloads.zh-CN.md#核验-modelscope-镜像)检查。

## 在 Evaluator 中使用

以下评测命令使用已注册的 `ember-evaluator`，注册步骤见[安装指南](../users/installation.zh-CN.md#安装全局命令)。

```bash
ember-evaluator warmup experiment.yaml --network network.yaml
ember-evaluator run experiment.yaml --network network.yaml
```

下载后由 `docker load --input` 加载归档，加载失败会停止本次准备。归档中的原始镜像标签可能被恢复或覆盖。Evaluator 不确认归档是否与原仓库镜像相同；需要确认时，按[镜像 ID 核验方法](../users/image-downloads.zh-CN.md#核验-modelscope-镜像)检查。

相同下载地址对应的本地镜像仍在时会复用，不重新下载。覆盖远端同名文件后，清理对应本地镜像或换用新版本地址，再执行 `warmup`。

公开归档不需要 Token。私有归档在执行下载的节点设置 `HF_TOKEN`（Hugging Face）或 `MODELSCOPE_API_TOKEN`（ModelScope），不要把 Token 写入网络文件或归档。使用 `warmup` 检查实际选中任务的归档能否下载并加载。

## 从清单方式迁移

1. 删除网络 YAML 中的 `catalogs`，填写 `provider` 和 `baseUrl`。旧配置会报未知字段，不自动兼容。
2. 将 `vf2-speedup-networkx/solve-linux-amd64.tar.gz` 移到 `vf2-speedup-networkx/linux/amd64/solve.tar.gz`；验证镜像同理改为 `verify.tar.gz`。镜像包内容无需修改。
3. catalog.json 和 SHA256SUMS 不再使用，可从远端移除。
4. 用选择单题的实验执行 `warmup`，确认目标路径存在且 Docker 能加载镜像。
