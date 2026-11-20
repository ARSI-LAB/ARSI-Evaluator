# Terminal-Bench Science 评测

> [English](./terminalbench-science.md) | 中文

使用 `benchmark.name: terminalbench-science` 选择内置 Profile。默认版本 `0.1`，也可写作 `0.1.0`，固定使用官方 v0.1.0 任务包。

[Benchmark 指南](README.zh-CN.md) · [Playbook](../../../playbook/terminalbench-science/terminalbench-science-simpleagent.yaml)

## 版本与配置

| 版本 | 配置与要求 |
| --- | --- |
| 0.1（0.1.0） | [SimpleAgent 示例](../../../playbook/terminalbench-science/terminalbench-science-simpleagent.yaml)，官方 GitHub 来源，提交 `f81afac`，Docker 与 shell verifier |

v0.1.0 任务包共 70 题；这不代表这些题目都已执行或通过。题目声明允许 Agent 使用 28800 秒，Profile 将整题外部预算设为 86400 秒。来源提交和其余默认值见 [Profile](../../../src/plugins/benchmarks/agent-harness/profiles/terminalbench-science.yaml)。

## 数据与任务目录

题目嵌套在 `tasks/<domain>/<field>/<task>/` 下，分为 5 个 domain、共 20 个 domain/field 目录。Profile 将仓库的 `tasks/` 目录物化为来源快照，并使用以下设置扫描：

```yaml
tasks:
  root: .
  id: task.name
  depth: 3
  expectedCount: 70
```

任务 ID 使用 `task.toml` 中声明的名称，例如 `terminal-bench-science/ambient-rna-correction`；记录键保留三级相对路径，因此只要上游不重命名任务，ID 就保持稳定且唯一。`depth: 3` 表示在 `tasks.root` 下搜索的目录层数：没有 `task.toml` 的目录会继续向下扫描，包含 `task.toml` 的目录按任务处理。实际数量与 `expectedCount` 不一致时来源锁直接失败，不会静默丢弃题目。

GitHub 来源固定到提交 `f81afac4f11048e77a15dfc8fb1dbfb897fea0ce`（tag `v0.1.0`），枚举、续跑和审计使用同一份快照。切换版本或来源后应新建实验。

## 环境与支持

题目使用自带的 `environment/Dockerfile` 构建求解环境，并声明独立 shell 验证（`tests/Dockerfile`）、固定资源和 `no-network` 验证网络。框架沿用 [Harbor 执行与验证规则](harbor.zh-CN.md#执行与验证边界)：镜像选择、准备时限、`/root/results` 或 `/app` 等声明产物的收集。资源由题目逐项声明，内存和存储最高 12 GB；资源不足会报 `ENV_RESOURCE_REQUIREMENTS_UNMET`，不会降级运行。

题目没有预构建镜像，首次运行会构建镜像并下载基础层，需要相应网络配置。基础镜像为 amd64 时，ARM64 节点需要可用的 QEMU/binfmt；见 [Docker platforms](../deployment/docker-platform.zh-CN.md)。删除失败题目不能得到全量评测结果。

结果写入实验输出目录，使用官方 verifier 的原生奖励。切换版本或来源后请新建实验，不要绕过来源锁续跑旧实验。
