# 新增内置基础插件

> [English](./add-built-in-plugin.en.md) | 中文

基础插件指 Benchmark、Environment、Solver 等组件角色。这个例子演示如何在现有八种角色之外新增第九种角色 `runGuard`。它在一次评测开始前检查任务数上限，防止误跑超出预算的实验。

例子中的 `runGuard` 和内置实现 `task-limit` 需要按教程加入源码。要在已有角色下增加一个实现，例如给 Metrics 增加指标，见[为已有角色新增内置实现](plugins.md#为已有角色新增内置实现)。

## 最小示例

| 步骤 | 要改什么 |
| --- | --- |
| 定义角色 | 新建 `src/core/contracts/run-guard.ts`，在 `PluginRole` 和 `RoleImplementations` 中加入 `runGuard`。 |
| 注册内置实现 | 新建 `src/plugins/run-guards/index.ts`，注册 `task-limit`，再由 `src/plugins/index.ts` 调用该入口。 |
| 读取配置 | 让实验 YAML 接受可选的 `runGuard`，解析并校验所选实现。 |
| 接入执行 | 在组件装配时创建所选实例，在 Engine 开始准备任务前调用它。 |

按[完整实现步骤](built-in-role-development.md#1-定义角色和接口)改完源码后，在仓库根目录用 Bash 或 WSL 复制一份[本机 GSM8K 示例](../../playbook/gsm8k/gsm8k-quick-start.yaml)。

```bash
mkdir -p .scratch/run-guard-example
cp playbook/gsm8k/gsm8k-quick-start.yaml .scratch/run-guard-example/experiment.yaml
```

它原有的 `run.maxTasks` 为 2。在副本末尾加入与 `run` 同级的 `runGuard`。

```yaml
runGuard:
  name: task-limit
  config:
    maxTasks: 1
```

构建后检查配置，再运行评测。

```bash
export MODEL_NAME=unused-example MODEL_ENDPOINT=http://127.0.0.1:1/v1 MODEL_API_KEY=fixture-only
pnpm typecheck
pnpm build
node dist/cli.js inspect .scratch/run-guard-example/experiment.yaml
node dist/cli.js run .scratch/run-guard-example/experiment.yaml
```

`inspect` 应显示 `experiment.runGuard.name` 为 `task-limit`。`run` 应以非零状态退出，并提示 `run.maxTasks must be at most 1`。任务还没开始准备，也不会请求模型。该结果同时验证了配置能找到插件，以及 Engine 确实调用了它。
