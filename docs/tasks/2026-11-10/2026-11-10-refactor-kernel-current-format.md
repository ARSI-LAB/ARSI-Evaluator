# 统一算子候选和性能证据格式

本次清理收紧了[算子文件树评测](2026-11-10-feature-kernel-candidate-files.md)的接口。验收目标是让单文件和多文件经过同一条执行路径，并让缺失关键字段的旧证据无法用于当前评测。

每个 kernel 任务显式提供 `candidateRoot`，验证请求保留候选的相对路径。`kernelProfile` 使用包含入口的完整文件清单，独立 CLI 从 `--kernel` 指定的文件构造单成员清单。参考与候选使用随包发布的计时模块。严格评测校验双方的计时证据、实际输入准备方式和迭代次数，profile 重放回执需要记录 `inputUnmodified`。

性能缓存将采集证据和带版本、采集条件标识的回执一起发布。当前作用域没有有效条目时重新采集。离线报告校验当前输出策略，只从已保存的产物清单生成 CSV、trace 和日志链接。配置和调用示例见[算子评测指南](../../users/benchmarks/kernel-npu.zh-CN.md)。

验收结果：

- Evaluator 类型检查和构建通过。13 个算子测试文件的 99 项测试、38 项 CPU Python 测试通过。构建后的 CLI 通过模拟 msprof 验证了单文件入口和完整清单。
- 默认测试集 2238 项通过、67 项跳过。已有的 Hermes 镜像环境断言与 AgentX 不可达主机遥测超时共 2 项失败。
- RSI 使用本地构建的配套 SDK，通过 `pnpm check`，716 项测试通过、4 项跳过。最终 SDK 打包后通过 RSI 的 `pnpm check:package`，覆盖独立安装、算子搜索、最终评测和续跑。
- 真实 NPU/CANN/msprof 运行待设备验收。
