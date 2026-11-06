# 外部插件

## 加载已有插件

1. 准备与当前 Evaluator 匹配的 ESM JavaScript 入口或已安装的 npm 包。TypeScript 入口先在插件项目中编译。
2. 创建 `cordis.patch.yaml`。当前 patch 使用 `insert`，每项包含唯一模块 `id` 和模块定位 `name`。

   ```yaml
   - insert:
       - id: custom-metrics
         name: ./dist/index.js
   ```

   CLI 的 `--patch` 路径相对当前目录，模块文件路径和 npm 包从 patch 文件目录解析。实验 YAML 按插件注册时的组件名选择 `{ name, config }`，例如从外部插件指南选择指标组件 `valid-count`。patch 模块 ID 和组件注册名分别用于模块识别和组件选择。
3. 在相关命令传 `--patch cordis.patch.yaml`。先用 `inspect` 确认实验选中了预期组件，再按主流程执行 doctor、dry-run、warmup 和小样本 run，检查组件行为或产物。续跑使用与原 run 匹配的 patch、编译产物和插件版本。

## 编写新插件

从[外部插件接入指南的 valid-count 示例](../../../../docs/development/external-plugins.md#2-实现并编译插件)起步，复用其中的 TypeScript 项目配置、完整指标实现和实验 YAML。按组件职责选择 `benchmark`、`verifier`、`environment`、`solver`、`metrics`、`reporter`、`store` 或 `scheduler`。

- 从 `ember-evaluator` 包根导入公共类型。导出 `inject = ["evaluator"]`，在 `apply(ctx)` 中调用 `ctx.evaluator.register(role, name, validate, factory)`。同一 role 下注册名唯一。默认配置用 `registerProfile()`。
- `validate` 只校验配置。工厂通过 `runtime` 获取路径、模型与认证，资源接入 Cordis 或组件生命周期。求解器使用公开任务，私有验证材料留在验证边界内。
- 在插件项目构建 JavaScript，按上述步骤加载。用有效配置和错误配置检查校验与加载，再通过小样本运行检查产物。涉及持久化的组件同时检查续跑或离线报告。

Ray 的执行节点需要预装一致的插件，通过节点配置 `pluginPatchPath` 指向本机 patch；Ray Jobs 协调端通过部署变量 `EVALUATOR_PLUGIN_PATCH_PATH` 找到容器内的 patch。详见 [SDK 与 Ray 接入](../../../../docs/development/external-plugins.md#6-sdk-与-ray-接入)。
