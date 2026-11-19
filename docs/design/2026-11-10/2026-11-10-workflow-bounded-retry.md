# 工作流自动重试

日期：2026-11-10

用户已批准：批量执行块声明有上限的 retry，资源插件判断失败是否可重试，内核在 attempt 清理结束后重跑。Benchmark 保留模型流式连接中断自动重试，其他流程默认关闭。

forEach 的独立单元模式可配置 retry: {policy: <资源名称>, maxAttempts: <正整数>}。策略资源提供 workflow.retry/v1 能力，只接收单元身份、attempt ID、累计次数与失败信息，不接收私有评分材料。maxAttempts 包含第一次执行，按保存的单元 ordinal 限制续跑后的累计尝试；手动补测仍可发起一次新 attempt，但不会重置自动重试额度。

只有 failed 且确认清理完成的 attempt 才调用策略。取消、未确认清理、成功但报告或清理失败均不触发重新评测。外部写入仍遵循原有重放许可。重试重新执行整个单元；一次单元占用同一执行槽，下一次 attempt 生成新的 ID。onError: stop 在自动重试耗尽或策略拒绝后生效。

Benchmark 运行资源读取自己保存的 attempt 证据，复用 response-truncated 判定，默认最多 3 次执行（原首次 + 2 次自动重试）。准备回执与已锁定来源继续校验。Ray 的重试决定在协调端作出，远端每次只执行一个 attempt。
