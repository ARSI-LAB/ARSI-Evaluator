# 工作流快捷参数与选题预览

日期：2026-11-10

状态：用户已明确同意实施。补充[实施设计](2026-11-10-workflow-runtime-implementation.md)，保留现有简单命令。

- WorkflowTemplate 可声明 overrideParameters，接收模板参数和 JSON 覆盖值，在环境变量展开之前执行。模板负责识别字段及选择服务；CLI 不判断流程名称。
- Benchmark 支持 model、endpoint、apiKeyEnv、taskIds。选题覆盖移除 sampling/offset/maxTasks 限制；模型覆盖只修改 Solver 选中的服务。
- --api-key 只进入本次调用的环境副本，模板只接收 EVALUATOR_CLI_API_KEY 引用；不改变进程环境、不保存值。
- ResourceProvider 的 preview 维护操作读取来源并列出选题，不创建 Solver、执行环境或运行结果。Benchmark 只声明读取来源需要的凭据，Jobs 使用既有维护协议。
- 完整展开流程和未提供参数覆盖函数的模板拒绝快捷覆盖；没有 preview 的流程提示使用 inspect。run、inspect、warmup、report、retry、doctor 改为调用新流程，删除旧入口选择分支。
- 验收覆盖快捷覆盖与环境变量先后顺序、服务选择、选题限制、无模型认证预览、资源释放，以及凭据不进入计划、结果和日志。
