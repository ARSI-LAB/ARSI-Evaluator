# 工作流结构化进度

日期：2026-11-10

状态：用户已明确批准。

当前工作流仅转发日志字符串，导致 Benchmark 任务阶段、实时工具输出和结构化错误没有进入 CLI/SDK、Ray 及 Jobs 原有进度展示。

- WorkflowEvent 增加可选 progress: ProgressEvent；WorkflowContext.log 与执行器 host.log 接收可选进度事件，现有纯文本插件调用保持有效。
- 内核负责脱敏并转发，不识别 Benchmark 名称或业务阶段。临时进度不保存为结果或评测证据。
- Benchmark 接入原有准备与 attempt 进度，结果完成后输出分类错误和计分状态；CLI/SDK 消费结构化字段。
- Ray 使用认证传输通道发送正式事件，实时预览复用有内存限制的 ProgressPublisher 快照；节点只允许报告本次派发的任务身份。Jobs 复用现有进度内存邮箱和客户端读取逻辑。
- 验收覆盖执行完成前收到进度、实时输出不落盘、凭据与错误嵌套字段脱敏、本地与远端进度、取消时关闭发送器。
