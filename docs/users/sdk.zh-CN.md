# Node.js SDK

> [English](./sdk.md) | 中文

Evaluator 同时提供 CLI 和 ESM SDK，要求 Node.js 24.22.1 或更新的 24.x。其他项目从包根导入 `Evaluator`，一次调用完成配置加载、执行、报告和资源释放。现有 `loadConfig`、`bootstrap`、`runEngine` 等低层 API 继续保留。

[用户文档](README.zh-CN.md) · [安装指南](installation.zh-CN.md) · [插件开发](../development/plugins.md)

## 在业务项目中安装

先按[源码安装](installation.zh-CN.md#直接安装)安装并构建 Evaluator，AgentBundle SDK 由 pnpm 自动下载和构建。业务项目使用 ESM 和 pnpm，在其目录执行以下命令。这里的 `pnpm` 读取业务项目自己的 `packageManager` 配置，不会自动沿用 Evaluator 的配置：

```bash
pnpm add 'ember-evaluator@link:../ember-evaluator'
```

根据实际目录修改路径。`link:` 不会自动编译源码，更新 Evaluator 后重新构建。业务项目需要保留可访问的 Evaluator 目录及其已安装依赖。

固定构建产物可以在 Evaluator 根目录打包，再在业务项目安装：

```bash
pnpm pack --pack-destination .scratch/packages
```

```bash
pnpm add '/path/to/ember-evaluator-0.1.0.tgz'
```

发行包仍有 AgentBundle GitHub 依赖，使用 pnpm 安装并保留相应仓库的读取权限。Evaluator 保持 `private: true`，本指南不表示已发布到公共 npm。

## 执行 YAML 实验

业务项目的 `package.json` 设置 `"type": "module"`。例如创建 `evaluate.mjs`：

```js
import { Evaluator, EvaluatorRunError } from "ember-evaluator";

const evaluator = new Evaluator();
const controller = new AbortController();

try {
  const result = await evaluator.run({
    configPath: "/path/to/config.yaml",
    signal: controller.signal,
    onProgress(event) {
      console.log(event.phase, event.message);
    },
  });
  console.log(result.runId, result.exitCode, result.reportPath);
  if (result.kind === "local") {
    console.log(result.snapshot.run.status);
  } else {
    console.log(result.jobId, result.collectionError, result.reportError);
  }
} catch (error) {
  if (!(error instanceof EvaluatorRunError)) throw error;
  console.error(error.phase, error.message);
  console.error("部分结果：", error.result?.runDirectory);
}
```

运行前在当前终端设置 YAML 引用的模型变量，方法见[快速上手](quick-start.zh-CN.md#3-设置模型变量)。配置、Benchmark、模型、Docker 和任务的条件与 CLI 相同，SDK 不绕过认证或准备检查。

## 参数与路径

`EvaluatorRunOptions` 和进度类型 `ProgressEvent`、`ProgressListener` 从包根导出。

| 参数 | 含义 |
| --- | --- |
| `configPath` | 实验 YAML；相对路径以调用时的当前目录解析 |
| `networkConfigPath` | 网络 YAML，路径相对当前工作目录；省略时读取 `EVALUATOR_NETWORK_CONFIG`，再读取 `~/.ember-evaluator/network.yaml` |
| `patchPath` | 显式插件 patch；相对当前目录解析，不自动扫描配置旁的 patch |
| `overrides` | 与 CLI 相同的模型覆盖项：`model`、`endpoint`、`apiKey`、`apiKeyEnv` |
| `env` | 用于 YAML 变量展开和模型认证，省略时使用 `process.env`；显式传入时使用该对象，不自动合并 |
| `signal` | 调用方的 `AbortSignal` |
| `resume` | `true` 选择输出目录中唯一的已有 run；字符串指定 run ID；省略或 `false` 新建 run |
| `onProgress` | 同步进度回调；任务阶段有 task/attempt 标识，Ray Jobs 日志使用 `deployment` 阶段 |

YAML 内的 Bundle、输出等路径仍相对 YAML 目录；patch 内的模块路径相对 patch 文件。SDK 不调用 `process.chdir()`，也不修改 `process.env`。单个实例可并行调用，各次运行有独立 Registry 和资源；仍应给不同实验选择合适的输出路径，避免主动对同一个 run 同时续跑。

`env` 提供实验和网络 YAML 的变量值，不自动与 `process.env` 合并。Docker daemon、Ray 网关认证等部署变量仍由实际进程或执行节点提供；例如 Ray Jobs 的 token 仍按原 `tokenEnv` 或安全文件读取，不会通过 `env` 修改进程全局变量。

## 网络和本地数据

```js
const result = await evaluator.run({
  configPath: "/path/to/experiment.yaml",
  networkConfigPath: "/path/to/network.yaml",
  env: { ...process.env, DOWNLOAD_PROXY: "http://proxy.example:8080" },
});
```

网络 YAML 可写 `proxy: { https: "${DOWNLOAD_PROXY}" }`；空文件表示官方默认源和直连。省略 `networkConfigPath` 时使用用户默认网络文件，首次自动创建。完整字段见[网络配置](network.zh-CN.md)。

本地数据路径写在实验 YAML 中：记录型题库使用 `benchmark.config.localPath`；Harbor 系列使用 `benchmark.config.source: { kind: local, path: ./dataset }`。相对路径按实验 YAML 目录解析，SDK 和 CLI 行为相同；格式和限制见[本地数据集](local-datasets.zh-CN.md)。SDK 不公开 `doctor()` 或 `inspect()` 方法，需要诊断时运行 `ember-evaluator doctor experiment.yaml`。

## 取消、续跑与报告

调用 `controller.abort()` 取消当前调用。SDK 不注册 SIGINT/SIGTERM 监听器；服务端应把 HTTP 断开、任务取消或自己的进程信号转换为 AbortSignal。取消后的环境回收和部分证据保存需要时间，等待 `run()` 结束后再退出进程。不要用 `Promise.race` 超时后直接丢弃仍在运行的评测。

```js
const result = await evaluator.run({
  configPath: "/path/to/config.yaml",
  resume: "saved-run-id",
});

const reportPath = await evaluator.report("/path/to/results/saved-run-id");
```

续跑使用相同的配置、来源、代码与插件版本；校验失败时拒绝执行，不重写原报告。`report()` 离线重建报告，不调用模型、不需要模型 key；第三方报告插件仍需可用，失败时透传 `rebuildReport()` 的异常。每次 `run()` 返回或抛出前都会释放本次资源，不需要调用 `evaluator.dispose()`。

进度回调应快速完成；异步消息可由业务方自行入队。同步回调抛错会中止本次运行并释放资源，SDK 抛出 `EvaluatorRunError`，保留已保存的部分结果。

## 结果和异常

`EvaluationResult` 是按 `kind` 区分的联合类型：

| 字段 | 含义 |
| --- | --- |
| `exitCode` | `0` 流程完成、`1` 运行故障、`2` 配置/准备入口错误、`130` 取消；普通错题也可能为 `0` |
| `runId` | 本地 run ID，或远端回执中的 run ID；远端回执尚未提供时可为 `null` |
| `runDirectory` / `reportPath` | 已保存的结果与报告位置；尚未生成或收集失败时可为 `null` |
| `kind: "local"` 的 `snapshot` | 当前进程协调执行的结果快照，包含任务和运行状态；也适用于 Docker 或直接 Ray Client 调度 |
| `kind: "ray-jobs"` 的 `jobId` | Ray Jobs 标识，沿用 CLI 的回执、跟随和取消流程 |
| `collectionError` / `reportError` | Ray Jobs 下载或报告失败的脱敏原因，不把缺失结果解释为成功 |

任务正常答错或 Engine 已保存的任务级失败通过返回结果表示，应检查 `exitCode`、快照和报告。`run()` 的配置、装配、入口执行、报告或释放异常抛出 `EvaluatorRunError`，含 `phase`、`exitCode`、`result` 和脱敏的 `cause` 链；`result` 可能为 `null`。错误诊断脱敏不等于任务内容脱敏，分享轨迹前仍需检查实际文件。

## Ray Jobs 与构建包的条件

SDK 与 CLI 选择相同部署分支，包括显式 Ray Jobs 和 Ray 配置触发的配套本机集群。配置方法见[Ray 与执行节点](config.zh-CN.md#ray-与执行节点)。普通远端日志通过 `onProgress` 的 `deployment` 阶段传递文本；独立进度通道提供含 task/attempt 身份的瞬时活动，不从文本日志反推事件。

`ProgressEvent.transient` 表示无需保存的呈现事件；可选 `live` 提供操作 ID、父 ID、序号、开始/更新/完成/失败/取消状态、累计耗时、无活动时长及最多 10 行脱敏预览，`live.preparation` 标识可使任务环境就绪的步骤。可选 `summary` 提供任务总数、准备就绪数和完成数；`connection` 提供远端进度连接中断、恢复或不支持的通知。重复快照不会表示有新工作，消费方应按操作 ID 和序号去重；结束操作不接受迟到更新。SDK 本身不会绘制终端，也不会将这些事件写入 Store 或轨迹。能力限制和部署要求见[实时执行预览](usage.zh-CN.md#实时执行预览)。

来源解析、任务枚举与整批规划也发送 `live` 操作。内置来源会报告下载字节、文件校验及处理计数；规划会更新当前任务和序号。`message` 可以随实际活动变化，同一个 `live.id` 的 `elapsedMs` 从操作开始累计；这些规划计数不增加 `summary.prepared`。

配套本机集群需要仓库中的 `scripts/ray-smoke/`、Docker 和本机部署资源，适合源码 `link:` 方式；仅安装 `.tgz` 不包含这些管理脚本。独立包连接已部署的 Ray Jobs 时，显式提供 endpoint、CA、网关认证并设置 `managedLocal: false`；各节点运行包、插件与认证要求保持不变。SDK 的存在不表示任意业务服务器已经具有运行 Docker 或 Ray 的条件。
