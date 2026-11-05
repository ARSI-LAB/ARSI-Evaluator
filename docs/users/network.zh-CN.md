# 网络下载配置

> [English](network.md) | 中文

`--network` 指定一份网络 YAML，设置代理、下载源和镜像来源。实验 YAML 负责选择 Benchmark、模型、题目和执行环境：

```bash
ember-evaluator run experiment.yaml --network network.yaml
```

两份文件的路径都以当前工作目录为基准。命令需先按[安装指南](installation.zh-CN.md#安装全局命令)注册。

## 1. 先选一份网络配置

| 需求 | 文件 |
| --- | --- |
| 从 ModelScope 下载 Terminal-Bench 任务镜像 | [archives.yaml](../../playbook/network/archives.yaml)，见[使用步骤](image-downloads.zh-CN.md#从-modelscope-下载任务镜像) |
| 使用镜像源与 DockerProxy | [mirrors.yaml](../../playbook/network/mirrors.yaml)，见[修改方法](reference/network.zh-CN.md#修改-mirrorsyaml) |
| 使用官方源 | [official.yaml](../../playbook/network/official.yaml) |
| 设置自己的代理或下载地址 | 创建 `network.yaml`，见[配置字段与代理](reference/network.zh-CN.md) |

每次选择一份文件，未填写的字段使用程序默认值。受支持的环境变量会覆盖 YAML；可用下面的 `inspect` 查看实际设置。

## 2. 检查后运行

例如，在仓库根目录通过 ModelScope 下载任务镜像，将 `experiment.yaml` 换成自己的 Terminal-Bench 4.0 实验文件：

```bash
# 查看实际配置，不下载
ember-evaluator inspect experiment.yaml --network playbook/network/archives.yaml
# 开始评测
ember-evaluator run experiment.yaml --network playbook/network/archives.yaml
```

`--network` 只选择本次命令使用的文件，后续命令需要再次传入。省略参数时使用环境变量或用户目录中的默认文件，见[设置默认网络文件](reference/network.zh-CN.md#设置默认网络文件)。

该配置只改变 Terminal-Bench 的任务镜像来源，远端需已发布所选任务和平台。需要先检查连接或准备镜像时，可分别执行 `doctor` 或 `warmup`，并传入相同的实验文件和 `--network`；`run` 也会自动准备镜像和依赖。

## 按需阅读

| 要解决的问题 | 文档 |
| --- | --- |
| 默认文件、优先级、代理、包源和环境变量 | [配置字段与代理](reference/network.zh-CN.md) |
| ModelScope、镜像源组合、镜像获取方式、缓存和 ID 核验 | [镜像下载](image-downloads.zh-CN.md) |
| doctor 结果、失败原因和实际下载验证 | [网络诊断](faq/network.zh-CN.md) |
| Docker daemon、源码安装、toolbox 和 Ray 节点网络 | [部署网络配置](deployment/network.zh-CN.md) |
