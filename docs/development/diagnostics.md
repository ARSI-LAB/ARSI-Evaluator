# 插件错误处理

> [English](./diagnostics.en.md) | 中文

[开发文档](README.md) · [错误码参考](../users/reference/errors.zh-CN.md)

## 插件接入

推荐新插件抛出明确类型，避免依赖字符串诊断：

```typescript
import { EvaluatorError } from "ember-evaluator";

throw new EvaluatorError(
  "VERIFY_RESULT_INVALID",
  "Verifier reward must be a finite number",
  { component: "custom-benchmark", operation: "read-reward" },
  { cause: originalError },
);
```

包根导出 `ErrorCode`、`ERROR_CODES`、`EvaluatorError`、`classifyError`、`normalizeFailure` 和 `failureDecision`。处理策略由注册表重新计算，不信任插件自填的 retryable/action。`Failure` 必须使用版本 1 的完整结构，校验拒绝简版错误、未登记的码、不一致策略、未知元数据和任意认证字段。本地存储读取历史三字段错误时先转换，转换函数不用于新提交或远端消息。`Warning` 是独立的三字段非致命诊断，code 同样必须登记。历史结果不会被追溯改分。

框架异常和 Solver warning 的 `code` 只接受 `ErrorCode`。需要新增有独立处理行为的错误时，先在 `ERROR_CODES` 声明，再修改抛出点和消费者；不要增加插件私有的框架错误码或别名转换表。Harbor 与其他插件直接使用 `TASK_DATA_INVALID`、`BENCHMARK_UNSUPPORTED` 等标准码。

操作系统 errno、外部 SDK 异常名、HTTP 状态和进程退出码保留为 `cause` 或 `details`，由适配器结合实际操作分类。不要把 SDK 异常名直接发送为 Pi／Ray 协议的 `code`。自有协议拒绝未登记的错误码；旧框架码不再转换，新插件不能依赖旧码获得处理策略。读取历史结果不会改写原始记录。
