# 新增内置流程步骤

> [English](add-built-in-plugin.en.md) | 中文

新增数据检查、预处理或评分时，注册一个步骤即可，不需要向 PluginRole、EffectiveConfig 或 Engine 增加新的组件类别。

例如，在模型调用前限制样例数量：

1. 在 `src/plugins/steps/` 新建一个 StepDefinition，输入为样例列表，配置为 `maxCases`。
2. 校验通过后原样返回样例，超限时抛出带数量的错误。
3. 在 `registerWorkflowSteps` 中注册该步骤。
4. 用 `inspect --output custom.yaml` 导出流程，把检查步骤插入选题之后，并让 `forEach.items` 读取检查步骤的输出。

这样用户可以添加或删除检查步骤；没有这项检查的流程无需新增配置字段或默认分支。

接口及完整示例见[工作流插件开发](workflow-plugins.md)，资源与模板的选择见[内置流程插件开发](built-in-role-development.md)。原有 Solver 或 Metrics 的新增实现继续使用各自 Benchmark 组件契约。
