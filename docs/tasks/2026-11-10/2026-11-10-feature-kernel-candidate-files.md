# Kernel 候选文件树

## 目标与依据

实施已批准的多文件 kernel 设计在 Evaluator 一侧的接口。设计来源为 RSI 仓库的 `docs/design/2026-11-10/2026-11-10-operator-source-files.md`；本文仅记录 Evaluator 实现与验收，不调整 RSI 配置接口。保留本次工作开始时已有的工作区修改。

目标是让精度、严格计时和 msprof replay 使用相同的候选目录结构，明确锁定 helper 的身份，并让 helper 或布局变化使 profiling 缓存失效。清单继续使用 schemaVersion 1，旧清单和单文件 profile 调用保持兼容。

## 实现路径

1. 清单 task 新增可选 `candidateRoot`，校验相对目录、候选位于目录内、参考位于目录外；候选树成员仍由 `candidate` 与 `files` 枚举。将根传播到验证请求。
2. Python worker 使用候选根加载入口，按实际路径保留包结构，并以根目录区分任务命名空间。同名参考与候选入口可分别导入；严格计时沿用已加载的函数。锁定文件拒绝符号链接和非普通文件。
3. `KernelProfileArgs` 增加可选的绝对 `candidateRoot` 及根相对 `candidateFiles: {path, sha256}[]`。显式树要求二者配对且清单包含入口；NPU backend 从锁定请求哈希派生这些参数。
4. Profiling 将全部声明成员按原布局复制到独立候选目录，验证路径、普通文件和 SHA-256。Replay 哈希包括候选完整树、参考及其声明依赖；内部 `sourceContext` 保留原 dataRoot 和锁定哈希。证据记录排序后的 `metadata.sources.candidateFiles` 与依赖摘要；缓存身份包括入口布局、所有成员和参考依赖。Kernel 名称按入口优先、随后已声明 Python helper 的顺序选择，选择协议纳入缓存身份。
5. 独立 profile 拒绝不匹配的完整树证据；完整评测中的可选 profiling 将无效证据降为失败诊断，保留原有正确性/计时验收语义。中英文 kernel-npu 指南同步说明配置与兼容边界。

## 验收结果

- RED：新增 TS 回归首次运行 48 项中 5 项失败，分别覆盖 `candidateRoot` 尚未支持、完整树 staging/cache/inventory 尚未接通及完整树收据缺失未拒绝。Python 回归观察到候选根 helper 导入失败及同字节 symlink 被接受。另补完整评测的回归，确认缺少树证据仍错误标记 completed，再实现修复。
- GREEN：`pnpm test --run tests/unit/kernel*.test.ts tests/integration/kernel*.test.ts`，13 个文件、95 项通过。审查后的回归另覆盖 helper 内的 Triton kernel 名称过滤、嵌套参考依赖及其缓存失效。
- GREEN：使用带 CPU PyTorch 的 Python 运行 `python -m unittest discover -s tests/unit -p 'test_kernel_*.py'`，37 项通过，覆盖嵌套相对/root 导入、同名入口、precision、strict 计时、replay、变更/缺失/symlink helper；设备与计时 API 为受控替身。
- GREEN：`pnpm typecheck`、`pnpm build`、`git diff --check` 均通过。Node/pnpm 使用协作说明指定的工具链 PATH。
- 全量 `pnpm test --run`：2234 项通过、67 项跳过、2 项失败。失败分别为已有的 Hermes mirror 环境断言与 AgentX unreachable host telemetry 超时，与此前基线复现一致；未记为全量通过。
- 匹配的 Evaluator 安装包已在 RSI 中验证。RSI `pnpm check` 完成，722 项通过、4 项跳过；只读入口、helper 修改、比较键、完整来源锁和独立 profiling 链路通过。独立复审未发现新的阻塞问题。
- RSI `pnpm check:package` 通过独立安装包消费、公开类型、算子搜索、SDK 评测、报告、资源释放和续跑验证。安装输出仍有已有的传递依赖弃用提示及缺失 `yaml` CLI bin 提示；本次消费检查未受影响。

## 范围与待验收

尚未执行真实 NPU/CANN/msprof 验收，CPU 测试不能作为设备成绩。RSI 的依赖 pin 尚未引用本次未发布的 Evaluator 修订，集成验证使用本地构建的安装包。省略 `candidateRoot` 的旧清单保留原 dataRoot 导入行为；旧独立 profile 保留单文件 staging，多文件调用应显式声明候选根。参考与候选仍在同一进程执行，公共绝对导入 helper 名称应避免冲突。Evaluator 清单中的重复文件声明继续去重并锁定一次，保留现有行为。
