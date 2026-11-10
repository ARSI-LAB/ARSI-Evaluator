# 错误码与结构化诊断

> [English](./errors.md) | 中文

错误码表示原因，`action` 表示默认处理策略，评分是否有效由独立的结果字段决定。不要用错误文本或进程退出码代替这些字段。框架只产生注册表中的标准码，不保留旧码别名或错误码转换表。注册表见 [registry.ts](../../../src/core/errors/registry.ts)。

## 查看错误

正常运行命令即可在报错时直接看到阶段、任务、标准错误码、领域、原始原因和处理建议，无需附加日志格式参数。例如：

```text
[42.0s] [error] [verify] Task 2/50 task=example-task ERROR: VERIFY_TIMEOUT: verify exceeded its task-specific time limit [verifier/attempt]
[hint] Verification exceeded its budget. Preserve official verification deadlines; ordinary verification timeouts are not retried.
```

完整结构化诊断自动保存在每个 attempt 的 `result.json` 中，不需要另行开启。准备阶段诊断也保存在 manifest 的 `preparationRounds[].failure` 或 `tasks[].failure` 中；`report.md` 汇总错误码、处理建议及清理结果。`EVALUATOR_DEBUG=1` 仍可用于查看额外执行细节。

`details` 只保存组件、操作、原始代码/异常名、HTTP 状态、退出码/信号、`retryAfterMs`，以及网络阶段、原因和脱敏证据；不保存请求、任意 headers 或环境变量。原因链限制深度、数量和长度，并脱敏。模型 key、访问令牌等敏感内容也不应由插件写入原始日志。

## 处理与评分

| 字段 | 含义 |
| --- | --- |
| `executionStatus` | `completed`、`agent_timeout`、`failed` 或 `cancelled`，表示本次执行如何结束 |
| `scoreStatus` | 质量评测为 `valid` 或 `invalid`，性能测量为 `not-applicable`，独立于清理是否成功 |
| `cleanupStatus` | `cleaned` 表示收尾未发现未确认资源；`unconfirmed` 表示不能确认释放 |
| `evaluationKind` | 必需；`quality` 表示质量评测，`performance` 表示性能测量 |

当前 attempt 不再保存 `status`、`timeoutKind`；CLI 和报告的状态文字从上述字段派生。旧结果只在本地读取入口转换，原文件不回写；新提交和远端上传拒绝旧字段。

- **Agent 解题超时**：整题还有时间时默认验证已有产物。总时限已耗尽或显式关闭超时后验证时，结果为 `agent_timeout`，计有效 0 分，`verdict` 为 null。[超时与并发](../concurrency.zh-CN.md)
- **系统故障**：没有可靠的合法评分时记为无效，排除评分分母。可恢复网络故障只在失败的请求、下载或拉取操作内有限重试；耗尽后记录 `NETWORK_FAILURE`，不会自动创建新 Attempt。明确的 Retry-After 可延长对应操作的退避。
- **环境准备失败**：镜像拉取及非构建操作的运行时安装只在可安全重试的网络操作内恢复；镜像构建失败不触发任务补测，APT 只在当前指令内重试下载。平台、权限、编译、普通阶段超时等不补测。`run.onError` 决定普通任务故障是否继续；批次准备屏障未通过时不会执行 Agent。
- **认证、额度、存储或协议全局故障**：停止本次运行，即使 `run.onError: continue` 也不能继续盲目请求或派发。
- **清理未确认**：停止派发，不补位、不重叠重试。已经得到合法 Benchmark verdict 的任务保留评分，不重新解题；纯证据收集故障也保留合法评分，并明确证据不完整。尚未得到 verdict 的失败不会凭空变成有效 0 分。
- **续跑**：先恢复未完成或未确认释放的环境，再运行未完成/无效题；有效评分和 Agent 超时任务跳过。恢复不会改写原 attempt 的清理诊断；全部题已有效完成、仅残留清理诊断时，恢复后原 run 仍可显示 error，但不会再次解题。

错误上报时，对应操作的自动重试已结束，`retryable` 为 false；显式手动补测另外检查网络证据、评分和资源回收情况，不根据此字段自动重新派发。`abort_run` 与 `stop_dispatch` 当前都会停止后续派发并取消在途任务；后者表示需先修复节点或释放资源，不自动启动后台清理器或换节点。

CLI 退出码继续使用 `0`（运行完成，允许答错及有效 Agent 超时）、`1`（运行/系统故障）、`2`（配置或参数错误）、`130`（用户取消）。某道题保留有效评分不等于整次 run 退出码一定为 0。

## 错误码

| 错误码 | 场景 | 默认处理 |
| --- | --- | --- |
| `NETWORK_FAILURE` | 对应请求或下载的有限重试耗尽 | 结束当前流程，不自动重跑；可显式手动补测 |
| `CONFIG_INVALID` | 配置、参数、组件初始化非法 | 中止运行 |
| `SOURCE_CHANGED` | 来源、选题、插件或求解器版本与锁定状态不一致 | 中止运行 |
| `DATA_FETCH_FAILED` | 数据源访问失败，下载器自身重试已耗尽 | 中止运行 |
| `TASK_DATA_INVALID` | 单题元数据或公开文件非法 | 无效，不重试 |
| `BENCHMARK_UNSUPPORTED` | 不支持此任务能力或协议 | 不支持，不重试 |
| `ENV_IMAGE_PULL_FAILED` / `ENV_IMAGE_PULL_TIMEOUT` | 镜像拉取失败 / 超时 | 无效，不重试 |
| `ENV_IMAGE_REFERENCE_INVALID` | 镜像引用或镜像身份非法 | 无效，不重试 |
| `ENV_CAPABILITY_UNSUPPORTED` | 环境不支持所需操作 | 无效，不重试 |
| `ENV_SESSION_CLOSED` | 环境会话已经关闭 | 停止使用该会话，完成清理 |
| `ENV_IMAGE_BUILD_FAILED` / `ENV_IMAGE_BUILD_TIMEOUT` | 镜像构建失败 / 超时 | 无效，不重试 |
| `ENV_ARCH_UNSUPPORTED` | 镜像平台、宿主架构或执行格式不兼容 | 无效，不自动换平台 |
| `ENV_DOCKER_DAEMON_UNAVAILABLE` | Docker daemon 不可用 | 停止派发 |
| `ENV_RESOURCE_EXHAUSTED` | 磁盘、内存、PID 等明确的资源不足 | 停止派发 |
| `ENV_RESOURCE_REQUIREMENTS_UNMET` | 任务 CPU 或内存要求超过节点容量 | 无效，不降低任务要求 |
| `ENV_CONTAINER_START_FAILED` | 容器创建或启动失败 | 无效，不重试 |
| `ENV_RUNTIME_ASSET_MISSING` | 框架运行时文件缺失 | 修复打包并重建镜像 |
| `ENV_SERVICE_HEALTHCHECK_FAILED` | 服务健康探针失败 | 无效，不跳过探针 |
| `ENV_CONTAINER_EXITED` / `ENV_CONTAINER_OOM` | 服务提前退出 / Docker 确认 OOM | 无效，检查日志和资源限额 |
| `ENV_RUNTIME_INSTALL_FAILED` | Agent 运行时未准备好或安装失败 | 无效，不重试 |
| `ENV_CPU_BUDGET_FAILED` | 无法应用任务 CPU 预算 | 无效，不重试 |
| `ENV_PREPARED_IMAGE_LOST` | 准备回执对应镜像丢失或改变 | 停止派发 |
| `ENV_PREPARATION_FAILED` / `ENV_PREPARATION_TIMEOUT` | 其他准备失败 / 超时 | 无效，不重试 |
| `SOLVER_AGENT_TIMEOUT` | Agent 解题预算耗尽 | 整题还有时间时默认验证已有产物 |
| `SOLVER_PROCESS_CRASHED` | Agent 进程异常退出 | 无效，不重试；不能只凭 137 断定 OOM |
| `SOLVER_PROTOCOL_INVALID` | Agent 事件流、状态或输出协议非法 | 无效，不重试 |
| `SOLVER_RESULT_INCOMPLETE` | Agent 未完整结束当前轮次 | 无效，只有明确网络故障才补测 |
| `SOLVER_OUTPUT_LIMIT` | 输出被 token 上限截断 | 无效，不补测；按主仓 Harness 保留截断错误 |
| `MODEL_RATE_LIMIT` | 模型服务 429 / 限流 | 明确可恢复时归类 NETWORK_FAILURE；缺少证据不补测 |
| `MODEL_AUTH_FAILED` | 模型认证或权限拒绝（401/403） | 中止运行 |
| `MODEL_QUOTA_EXHAUSTED` | 模型额度耗尽 | 中止运行 |
| `MODEL_UPSTREAM_TIMEOUT` | 模型服务请求或流式响应超时 | 明确传输超时时归类 NETWORK_FAILURE；普通预算耗尽不补测 |
| `MODEL_UNAVAILABLE` | 模型连接失败、服务 5xx | 明确临时网络故障时归类 NETWORK_FAILURE；缺少证据不补测 |
| `MODEL_CONTEXT_LIMIT` | 模型上下文超限 | 无效，不重试 |
| `MODEL_REQUEST_INVALID` | 模型请求参数或协议非法 | 无效，不重试 |
| `TRANSFER_TIMEOUT` / `TRANSFER_FAILED` | 工作区传输超时 / 失败 | 不自动补测，检查传输和收尾日志 |
| `TRANSFER_AUTH_FAILED` | 传输认证失败 | 中止运行 |
| `TRANSFER_PROTOCOL_INVALID` | 传输消息、回执或身份不符合协议 | 中止运行 |
| `TRANSFER_CONFLICT` | 同一传输标识对应不同内容或上传已结束 | 拒绝冲突，不覆盖已有产物 |
| `TRANSFER_NOT_FOUND` | 传输记录不存在 | 先创建上传再发送文件 |
| `TRANSFER_CHECKSUM_MISMATCH` | 工作区或补丁摘要不匹配 | 拒绝损坏数据，不作为网络故障补测 |
| `TRANSFER_UNSAFE` | 不安全归档或恢复路径 | 无效，不重试 |
| `VERIFY_TIMEOUT` | 验证器超过官方验证预算 | 无明确网络原因时不补测 |
| `VERIFY_EXEC_FAILED` | 验证执行失败或没有评分文件 | 无效，不重试 |
| `VERIFY_RESULT_INVALID` | 评分文件格式非法 | 无效，不伪造 0 分 |
| `ARTIFACT_COLLECTION_INCOMPLETE` | 原生 session、轨迹或产物缺失 | 保留合法评分及不完整证据说明 |
| `RAY_WORKER_LOST` | Ray 执行节点/进程失联 | 先确认退出和回收，失联本身不证明网络故障 |
| `RAY_HEARTBEAT_TIMEOUT` | Ray 心跳或协调执行预算超时 | 先确认退出，未确认时停止派发；不凭超时补测 |
| `RAY_RESULT_UNCOLLECTED` | 执行返回但没有已接受的结果回执 | 核实结果和节点证据，缺少明确网络原因时不补测 |
| `RAY_PROTOCOL_INVALID` | 协议或回执不匹配 | 中止运行 |
| `SCHEDULER_UNAVAILABLE` | 调度服务初始化或通信失败 | 中止运行 |
| `STORE_WRITE_FAILED` | 无法可靠保存结果 | 中止运行 |
| `STORE_RECORD_INVALID` | 记录、文件清单或轨迹不完整或身份不符 | 拒绝损坏记录，中止运行 |
| `STORE_LOCKED` | 存储锁由其他进程持有或所有权改变 | 中止运行，先确认原进程状态 |
| `STORE_CONFLICT` | 同一结果标识已有不同内容 | 保留已有结果，中止运行 |
| `STORE_STATE_INVALID` | 存储未打开或被其他运行使用 | 中止运行，检查生命周期 |
| `STORE_SNAPSHOT_CHANGED` | 报告使用的快照已经变化 | 从当前结果重新生成报告 |
| `REPORT_FAILED` | 报告生成失败 | 保留结果，修正后离线重建 |
| `CLEANUP_TIMEOUT` / `CLEANUP_FAILED` | 资源释放超时 / 失败 | 保留合法评分，停止派发 |
| `RUN_CANCELLED` | 用户或运行控制器取消 | 保留部分结果，停止本次执行 |
| `INTERNAL_ERROR` | 无法识别的组件异常 | 无效，不盲目重试 |

模型 HTTP 状态只在模型/求解边界识别。镜像仓库的 403 不会被解释成模型权限错误。未知外部错误保留原始代码与原因链，确定不了 OOM、网络或模型原因时不伪造具体结论。

插件作者如何抛出结构化错误，见[插件错误处理](../../development/diagnostics.md)。

[返回用户文档](../README.zh-CN.md) · [快速上手](../quick-start.zh-CN.md)
