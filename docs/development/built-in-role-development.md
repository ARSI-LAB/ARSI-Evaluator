# 内置流程插件开发

> [English](built-in-role-development.en.md) | 中文

先根据具体行为选择实现位置：

| 行为 | 实现方式 | 注册入口 |
| --- | --- | --- |
| 检查输入、转换数据、调用应用、产生评分 | StepDefinition | registerStep |
| 保持模型客户端、浏览器、记忆会话等实例 | ResourceProvider | registerResource |
| 为用户提供少量参数并生成步骤顺序 | WorkflowTemplate | registerWorkflow |
| 为现有 Benchmark 增加 Solver、Verifier、Metrics 等实现 | 对应的领域接口 | registerNativeResource |

普通流程扩展不修改 PluginRole、RunComponents 或核心执行器。内核只读取步骤、端口、作用域和控制节点，不按新插件名称添加分支。

## 修改位置

步骤放 `src/plugins/steps`，资源放 `src/plugins/resources`，模板放 `src/plugins/workflows`。在相应注册入口调用注册函数。仓库源码使用相对路径导入，不能通过 `arsi-evaluator` 自引用；第三方插件才从包根导入。

模板的 expand 只展开参数，不执行 I/O。提供 example 参数后，用户可直接执行 init --workflow 生成 YAML。复杂流程仍可以导出后手动编辑，不需要另写专属 CLI 参数。

## 验证范围

检查配置类型和未知字段、删除步骤后的失效引用、端口协议和私有数据流。资源插件还要检查并发、取消、迟到实例释放和崩溃恢复。恢复信息先持久化，再创建外部资源。使用实际可观察行为验证，不为单纯注册语句堆叠测试。

运行 pnpm check:dependencies、pnpm typecheck、pnpm build，以及受影响的集成测试。接口示例和生命周期规则见[工作流插件开发](workflow-plugins.md)。
