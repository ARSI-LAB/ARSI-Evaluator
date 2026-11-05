# Terminal-Bench 4.0 快速入门

> [English](./terminalbench.md) | 中文

目标：使用默认 SimpleAgent 在 Docker 中执行终端任务，查看任务内验证器给出的结果。本页使用仓库自带的 4.0 配置；只填写 `benchmark: terminalbench` 时，默认版本是 2.0。

[项目主页](../../../README.zh-CN.md) · [用户文档](../README.zh-CN.md) · [全部实验配置](../../../playbook/README.md)

## 1. 准备安装与 Docker

先按[源码安装](../installation.zh-CN.md#直接安装)配置 GitHub 读取权限并安装、构建 Evaluator。AgentBundle SDK 会自动下载和构建，无需手动克隆。

按安装指南注册 `ember-evaluator` 后，在 Evaluator 仓库根目录执行以下命令，以便读取仓库中的 Playbook。执行机器还需要可用的 Docker Engine，以及模型 API、任务数据与镜像的访问条件。

```bash
docker version
ember-evaluator --help
```

官方 4.0 预构建镜像使用 `linux/amd64`，仓库示例已显式选择该平台；ARM64 节点需要可用的 QEMU/binfmt，见[Docker 平台选择](../deployment/docker-platform.zh-CN.md)。

## 2. 设置模型并检查配置

按[模型变量设置方法](../quick-start.zh-CN.md#3-设置模型变量)，在运行命令的同一终端设置 `MODEL_NAME`、`MODEL_ENDPOINT` 和 `MODEL_API_KEY`。模型服务需支持工具调用。

使用 [terminalbench-4.0.yaml](../../../playbook/terminalbench/terminalbench-4.0.yaml)，先查看展开后的配置并检查运行条件：

```bash
ember-evaluator inspect playbook/terminalbench/terminalbench-4.0.yaml
ember-evaluator doctor playbook/terminalbench/terminalbench-4.0.yaml
```

`doctor` 不调用模型，会读取任务归档样本并执行下载和镜像探针；`not-checked` 项需要在实际运行中确认。可用下面的命令预览实际任务，它可能下载任务数据：

```bash
ember-evaluator run playbook/terminalbench/terminalbench-4.0.yaml --dry-run
```

## 3. 运行任务

仓库示例未限制题数，会运行全部支持的题目。第一次使用建议在原 YAML 中增加以下内容，先运行两题；详细的固定 ID 和抽样方法见[选题与并发](../usage.zh-CN.md#选择题目与并发)。

```yaml
run:
  maxTasks: 2
```

```bash
ember-evaluator run playbook/terminalbench/terminalbench-4.0.yaml
```

Docker 按题目要求准备环境，Agent 在任务容器中操作，任务内验证器检查完成情况。首次拉取镜像可能较慢。环境、网络与验证材料的处理见[Harbor 执行与验证边界](../benchmarks/harbor.zh-CN.md#执行与验证边界)。确认链路正常后，删除 `run.maxTasks`，开始新的全量实验。

## 4. 查看报告与续跑

示例的输出位于 `results/terminalbench-4.0/<RUN_ID>/`。打开 `report.md` 查看得分、耗时和失败原因，进入 `tasks/` 查看 attempt、轨迹与验证证据。

保持配置、来源、外部插件及待评测 Bundle、Harness 版本不变时，可继续未完成任务；Evaluator 代码允许更新并重新构建：

```bash
ember-evaluator run playbook/terminalbench/terminalbench-4.0.yaml --resume
```

从两题切换到全量后，配置已经变化，应新建 run。续跑与离线报告见[日常操作](../usage.zh-CN.md#续跑与重建报告)。

已[注册全局命令](../installation.zh-CN.md#安装全局命令)时，也可在任意目录执行：

```bash
ember-evaluator run '/path/to/ember-evaluator/playbook/terminalbench/terminalbench-4.0.yaml'
```

更换 Agent 见[Solver 与模型服务](../solvers.zh-CN.md)；使用其他 Harbor 任务见[Harbor 指南](../benchmarks/harbor.zh-CN.md)。
