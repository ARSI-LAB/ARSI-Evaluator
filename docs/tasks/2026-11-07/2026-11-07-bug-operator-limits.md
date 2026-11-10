# 算子链路限制清理

类型为缺陷修复与配置简化。验收完成。契约范围见[限制设计](../../design/2026-11-07/2026-11-07-kernel-contract-limits.md)，前次评测修复见[此前记录](./2026-11-07-bug-kernel-evaluation.md)。

实际修改覆盖 RSI 与 Evaluator。配置可以省略固定的 SDK 模式、计时口径和普通评测的 profiling；独立 profiling 使用有效默认值。移除单任务清单和外层期限必须更长的限制，保留串行评测与取消清理。张量契约接受三种浮点类型、标量和显式非连续输入。参考修改输入时遵从任务声明。

RSI 将可调用入口的检查交给实际评测，支持函数别名。historyWindow 接受零，embedding 批大小接受正整数。文件可读性通过实际 I/O 判断；lstat.isFile 已排除符号链接的地方移除重复判断。原始 SDK 错误保留完整内容及来源。结果验证集中处理 assessment 和有效协议。

## 实际验证

- Evaluator 类型检查、构建与打包通过。全量测试 2,219 项通过、67 项跳过、2 项失败。失败仍为前次已在干净 cf3d80a 复现的 Hermes 镜像变量断言和 AgentX 不可达主机采样超时。
- CPU PyTorch 的严格检查、计时和 replay 共 33 项 Python 测试全部通过。直接 precision API、CLI 和 Python worker 均拒绝空或非法种子列表，避免漏测。
- 独立 profiling 经实际 SDK 验证了多任务选择和每任务回执。更短的外层期限触发取消后，进程完成清理，测量维持无效状态。
- 本地打包 SDK 用于 RSI 的 pnpm check，636 项通过、3 项跳过。另通过实际 SDK 验证混合 FP16/FP32/BF16 输入、标量输出、非连续输入声明和省略固定配置。
- 文件边界相关的补充测试 25 项通过。修改过的 Markdown 本地链接、换行和 git diff --check 均通过。
- 未运行真实 NPU 或模型。RSI 的依赖清单仍锁定已有 SDK 提交，全新安装接入这些 SDK 修改需在对应提交可拉取后更新锁定。
