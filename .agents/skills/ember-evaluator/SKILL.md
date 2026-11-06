---
name: ember-evaluator
description: Use when an agent needs to configure, inspect, diagnose, warm up, run, resume, or report an ember-evaluator benchmark experiment, or develop and load a Cordis evaluator plugin.
---

# 使用 Ember Evaluator 完成评测

在 Evaluator 仓库根目录操作。通过 `npx skills add` 安装到其他项目时，示例和指南仍在 Evaluator checkout 的 `playbook/` 和 `docs/` 下，按链接中的仓库路径查找。用 `ember-evaluator --help` 和子命令的 `--help` 确认当前版本；从源码运行时，按仓库要求用 `pnpm install --frozen-lockfile` 和 `pnpm build`，然后用 `node dist/cli.js` 替换下文的 `ember-evaluator`。

- 查命令和执行副作用时，读 [CLI 速查](references/cli.md)。
- doctor 报错、下载慢或需要代理时，读 [网络排障](references/network.md)。
- 加载或开发外部组件时，读 [外部插件](references/plugins.md)。

## 新实验

1. **写实验 YAML。** 用 `benchmark list` 和 `benchmark info <name>` 查版本、场景和默认组件。从 [Playbook](../../../playbook/README.md) 选相近示例，或运行 `ember-evaluator init --benchmark <name> --output experiment.yaml`。核对模型、数据来源、样本规模、并发和结果路径。认证使用环境变量引用，输出和共享材料里保留变量名即可。用户只要求生成配置或预检时，到相应步骤交付。
2. **检查生效配置。** 运行 `ember-evaluator inspect experiment.yaml`，确认展开后的配置与评测目标一致。inspect 不探测下载连通性。使用外部插件或显式网络配置时，为 inspect、doctor、dry-run、warmup 和正式 run 传入同一份 `--patch cordis.patch.yaml`、`--network network.yaml`。
3. **检测网络和前置条件。** 运行 `ember-evaluator doctor experiment.yaml`。下载慢或不通时，定位端点、操作和实际执行位置，再按网络排障参考调整。配置变更后重跑 inspect 和 doctor。必要前置条件仍失败时，报告具体阻塞。
4. **确认选题并预热。** 如需核对选题，运行 `ember-evaluator run experiment.yaml --dry-run`，它可能下载数据并列出任务 ID。运行 `ember-evaluator warmup experiment.yaml --progress plain` 准备镜像和运行时，检查预热结果中的 `failures`，确认 `readyTaskIds` 覆盖所选的 `taskIds`。要求两阶段选题严格一致时，为 warmup 和 run 传同一个 `--task-ids-file tasks.json`，其中是形如 `{"taskIds":["实际任务ID"]}` 的对象。该参数覆盖 YAML 选题。
5. **运行并交付。** 运行 `ember-evaluator run experiment.yaml --progress plain`，跟踪到终止并核对保存的任务结果与报告。交付 Run ID、结果目录、报告路径、任务完成情况和失败原因。需要离线重建报告时执行 `ember-evaluator report <run-dir>`。

## 恢复已有实验

| 目的 | 命令 | 选题 |
| --- | --- | --- |
| 修复网络后定向补测 | `ember-evaluator retry --run <run-id-or-directory>` | 只选因明确网络故障而无效的题。可重复传 `--task-id` 缩小范围。 |
| 中断后继续，或补齐所有无效结果 | `ember-evaluator run experiment.yaml --resume <run-id>` | 按续跑规则重跑未完成或无效任务，包括符合条件的非网络失败。 |

两者沿用原 Run ID，并为重跑的题创建新 attempt。答错、有效零分和按规则计为有效结果的 Agent 超时会保留。比如 5 题因拉镜像失败，20 题未开始，retry 只补测符合条件的 5 题，resume 会处理这两组。

- **retry** 可以给仍在运行的评测提交请求。在线补测使用原进程的网络配置，已结束的 run 可以显式传 `--network network.yaml`。插件由原 run 记录恢复，保持原 patch 和已编译模块可用。收到 `pending` 或 `accepted` 后继续检查补测结果。请求未确认时，用原 `--request-id` 重发。
- **resume** 使用原实验 YAML、匹配的数据来源与插件，并按需传回原 `--patch` 和原选题用的 `--task-ids-file`。需要显式网络配置时传入 `--network network.yaml`。显式指定 Run ID，避免自动匹配选错。模型、选题或并发变更后创建新 run。
- 恢复前补齐原配置引用的认证变量。用保存的产物确认结果，保留历史 attempt。

详见 [网络补测](../../../docs/users/network-retry.zh-CN.md)和[续跑说明](../../../docs/users/usage.zh-CN.md#续跑与重建报告)。
