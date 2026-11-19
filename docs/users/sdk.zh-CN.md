# Node.js SDK

> [English](./sdk.md) | 中文

Evaluator 同时提供 CLI 和 ESM SDK，要求 Node.js 24.22.1 或更新的 24.x。其他项目从包根导入 `Evaluator`，一次调用完成配置加载、执行、报告和资源释放。运行入口使用声明式工作流；旧 `loadConfig`、`bootstrap`、`runEngine` 已删除。

[用户文档](README.zh-CN.md) · [安装指南](installation.zh-CN.md) · [插件开发](../development/plugins.md)

## 在业务项目中安装

先按[源码安装](installation.zh-CN.md#直接安装)安装并构建 Evaluator，AgentBundle SDK 由 pnpm 自动下载和构建。业务项目使用 ESM 和 pnpm，在其目录执行以下命令。这里的 `pnpm` 读取业务项目自己的 `packageManager` 配置，不会自动沿用 Evaluator 的配置：

```bash
pnpm add 'arsi-evaluator@link:../arsi-evaluator'
```

根据实际目录修改路径。`link:` 不会自动编译源码，更新 Evaluator 后重新构建。业务项目需要保留可访问的 Evaluator 目录及其已安装依赖。

固定构建产物可以在 Evaluator 根目录打包，再在业务项目安装：

```bash
pnpm pack --pack-destination .scratch/packages
```

```bash
pnpm add '/path/to/arsi-evaluator-0.1.0.tgz'
```

Evaluator 的包清单设置了 `private: true`。上面的命令通过本地链接或 `.tgz` 文件安装 SDK。

## 执行、取消和结果

YAML 使用 `schemaVersion: 2`，模板和完整步骤格式见[自定义评测流程](workflows.zh-CN.md)。

```js
import { Evaluator, EvaluatorRunError } from "arsi-evaluator";

const evaluator = new Evaluator();
const controller = new AbortController();
try {
  const result = await evaluator.run({
    configPath: "/path/to/experiment.yaml",
    signal: controller.signal,
    onProgress(event) { console.log(event.phase, event.message); },
  });
  console.log(result.runId, result.record.status, result.exitCode);
  console.log(result.runDirectory, result.reportPath);
} catch (error) {
  if (!(error instanceof EvaluatorRunError)) throw error;
  console.error(error.phase, error.message, error.result?.runDirectory);
}
```

本地、直接 Ray 和 Ray Jobs 均返回 `kind: "workflow"`，无需按部署方式分支。`record` 保存步骤、独立样例、资源释放状态、输出与错误；Benchmark 原生结果保存在运行目录的证据子目录。`exitCode` 为完成 0、运行失败 1、取消 130；配置异常通过 `EvaluatorRunError` 返回 2。业务评分为零不等于流程失败。

调用 `controller.abort()` 取消，随后等待 `run()` 结束以完成清理。SDK 不安装进程信号监听。同步进度回调抛错会取消本次运行；异常的 `result` 可为 null，或包含已经保存的部分结果。不需要调用 `dispose()`。

## 参数与路径

| 参数 | 行为 |
| --- | --- |
| `configPath` | YAML 路径，相对当前工作目录 |
| `patchPath` | 显式附加插件 patch；模块位置相对 patch 文件 |
| `networkConfigPath` | 网络文件；缺省查找 EVALUATOR_NETWORK_CONFIG 和用户默认网络 YAML |
| `parameterOverrides` | 模板声明支持的覆盖项，如 model、endpoint、apiKeyEnv、taskIds；完整步骤 YAML 不接受模板覆盖 |
| `env` | 当前变量和凭据；显式传入时不自动合并 process.env |
| `signal` | 调用方取消信号 |
| `resume` | true 选择唯一已有运行；字符串指定运行 ID |
| `onEvent` | 工作流步骤事件，可带结构化 progress |
| `onProgress` | 兼容终端展示的阶段、任务和实时输出事件 |

YAML 相对路径按配置目录解析；SDK 不修改当前目录或全局环境变量。模型认证使用 `apiKeyEnv`；题库认证使用 `{credential: "HF_TOKEN"}`。需要继承进程变量时显式写 `env: {...process.env, ...values}`。不同调用拥有各自的注册表和资源，不能同时写同一个运行目录。

## 检查、预热、维护、补测和离线报告

```js
const plan = await evaluator.inspect({ configPath: "/path/to/experiment.yaml" });
const prepared = await evaluator.warmup({ configPath: "/path/to/experiment.yaml" });
const checks = await evaluator.maintain(
  { configPath: "/path/to/experiment.yaml" },
  { operation: "doctor", options: {} },
);
const resumed = await evaluator.run({ configPath: "/path/to/experiment.yaml", resume: "saved-run-id" });
const retried = await evaluator.retry("/path/to/results/saved-run-id", { taskIds: ["failed-case"] });
const report = await evaluator.report("/path/to/results/saved-run-id");
```

`inspect` 不创建评测资源。预热和维护仅创建插件声明的准备依赖。续跑校验计划、实现版本、业务输入、来源和已保存证据，先恢复资源再复用成功样例。补测保持保存的网络模板，读取当前运行时环境变量和凭据；更改模板本身需要新运行。

`report` 只读取保存结果和报告插件，不需要模型密钥，也不重新执行评测。插件必须仍可加载，且与保存版本匹配。运行目录根部 `report.md` 为当前报告，续跑历史在 `reports/`。

直接控制工作流时，包根还提供 `inspectWorkflow`、`runWorkflow`、`retryWorkflow`、`warmupWorkflow`、`rebuildWorkflowReport`、`compileWorkflow` 和 `executeWorkflow`。插件从包根导入契约，不能依赖内部文件路径。
