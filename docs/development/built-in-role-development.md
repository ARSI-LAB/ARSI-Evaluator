# 内置基础插件开发

> [English](./built-in-role-development.en.md) | 中文

本例添加与 `environment`、`scheduler` 等并列的 `runGuard` 角色。实验可以选择一个运行检查器。内置实现 `task-limit` 只检查实验声明的 `run.maxTasks`，拒绝未指定任务数上限或上限超过策略值的运行。省略 `runGuard` 的实验沿用原执行流程。

## 1. 定义角色和接口

新建 `src/core/contracts/run-guard.ts`。调用方只传检查需要的数据。

```ts
export interface RunGuard {
  assertAllowed(maxTasks: number | null): void;
}
```

在 [plugin.ts](../../src/core/contracts/plugin.ts) 导入 `RunGuard`，在 `PluginRole` 中加入 `"runGuard"`，在 `RoleImplementations` 中加入 `runGuard: RunGuard`。工厂沿用现有的 `PluginFactoryContext`。[注册表](../../src/application/plugins/registry.ts) 按角色和名称存取组件，这里沿用现有的 `register()` 和 `prepare()`。

## 2. 注册一个内置实现

新建 `src/plugins/run-guards/index.ts`。校验函数只检查插件配置。工厂创建组件，运行检查留给 `assertAllowed()`。

```ts
import type { Context } from "@deepseek-ai/cordis";
import type { RunGuard } from "../../core/contracts/run-guard.js";
import { expectPositiveInteger, expectRecord, rejectUnknown } from "../../core/validation/input.js";

export function apply(ctx: Context): void {
  ctx.evaluator.register("runGuard", "task-limit", (value: unknown) => {
    const config = expectRecord(value, "task-limit");
    rejectUnknown(config, ["maxTasks"], "task-limit");
    return { maxTasks: expectPositiveInteger(config.maxTasks, "task-limit.maxTasks") };
  }, (config): RunGuard => ({
    assertAllowed(maxTasks) {
      if (maxTasks === null || maxTasks > config.maxTasks) {
        throw new Error(`run.maxTasks must be at most ${config.maxTasks}`);
      }
    },
  }));
}
```

在 [src/plugins/index.ts](../../src/plugins/index.ts) 导入 `apply as runGuards`，并在总入口的 `apply(ctx)` 中调用 `runGuards(ctx)`。

## 3. 让实验配置能选择它

| 文件 | 改动 |
| --- | --- |
| [user-schema.ts](../../src/config/user-schema.ts) | 给 `UserConfig` 加 `runGuard?: string \| PluginSelection`。在顶层字段的允许列表中加入 `runGuard`，如果 `record.runGuard !== undefined`，用 `normalizeSelection(record.runGuard, "runGuard")` 填写 `result.runGuard`。 |
| [config.ts](../../src/core/contracts/config.ts) | 给 `EffectiveConfig` 加 `runGuard?: Selection`。 |
| [effective.ts](../../src/config/effective.ts) | 在 `parseEffectiveConfig()` 的返回对象中，有值时加入 `runGuard: parseSelection(source.runGuard, "runGuard")`。字段缺省时省略该属性。 |
| [load.ts](../../src/config/load.ts) | 在插件校验块内加入 `if (experiment.runGuard) registry.validate("runGuard", experiment.runGuard);`，让 `inspect` 检查注册名及私有配置。 |

本例的字段由用户 YAML 显式指定，沿用 [resolve.ts](../../src/config/resolve.ts) 合并用户配置的流程。若需要让 Benchmark Profile 提供默认选择，再在 [profile-schema.ts](../../src/config/profile-schema.ts) 允许该字段，并检查默认值与用户配置的合并规则。

## 4. 创建组件并在运行时调用

在 [components.ts](../../src/core/contracts/components.ts) 导入接口，给 `RunComponents` 加 `runGuard?: RunGuard`。在 [create-components.ts](../../src/application/plugins/create-components.ts) 的 `createRunComponents()` 中，先和其他角色一起准备工厂。

```ts
const guardSelection = config.experiment.runGuard;
const createRunGuard = guardSelection === undefined
  ? undefined
  : ctx.evaluator.prepare("runGuard", guardSelection);
```

工厂通过校验后，用现有的 `runtime` 创建实例。

```ts
const runGuard = await createRunGuard?.(runtime);
```

在返回对象中添加 `...(runGuard === undefined ? {} : { runGuard })`。在 [engine.ts](../../src/core/execution/engine.ts) 的 `executeEngine()` 中，放在打开历史运行和准备任务之前，即现有 `signal.throwIfAborted()` 后面。

```ts
components.runGuard?.assertAllowed(config.experiment.run.maxTasks);
```

这样每次进入 Engine 都会执行检查，包括续跑和重新启动 Engine 的补测。它检查一次运行的配置，运行中的在线补测不会因此逐题重新检查。`inspect` 只校验选择和插件配置，真正的运行才执行检查。

## 5. 验证和扩展范围

- 运行 `pnpm check:dependencies`、`pnpm typecheck` 和 `pnpm build`，再按[最小示例](add-built-in-plugin.md#最小示例)验证。还可用不存在的实现名或无效的 `maxTasks` 检查 `inspect` 是否拒绝配置。用允许范围内的任务数跑一次受控评测，确认 Engine 能继续执行。
- 可选字段需要覆盖旧 YAML 和已保存配置，确认省略字段时仍能运行和续跑。若新角色持有进程或连接，在所属 Cordis 插件上下文用 `ctx.effect()` 注册清理，并验证成功、失败和取消。
- 本例验证本机执行。接入 Ray 前，确定角色在协调端还是节点执行，再检查配置传输、版本校验和凭证脱敏。若要开放给独立 TypeScript 插件，从 [包根](../../src/index.ts) 导出新接口。
