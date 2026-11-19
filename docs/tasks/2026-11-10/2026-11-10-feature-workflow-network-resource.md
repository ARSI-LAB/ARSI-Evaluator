# 工作流网络资源实施

日期：2026-11-10

类型：feature

状态：网络资源已实现并通过本阶段验收；整个插件化改造尚未完成。

依据 [网络资源设计](../../design/2026-11-10/2026-11-10-workflow-network-resource.md)，继续未完成的插件化改造。用户已批准 network.runtime 的职责和依赖调整，不重复申请确认。

## 实施与验收

1. 新增网络资源、模板校验及凭据声明；保证原始代理凭据不写入计划。
2. 将模型和 Benchmark 的网络客户端创建、释放移至资源；补齐预热和恢复调用。
3. 接回 --network、默认网络文件、导出与续跑。
4. 本地回归、类型/构建/依赖检查及 WSL Ray/Jobs 验收。
5. 后续继续原入口、Playbook、AgentBundle 与 HF 凭据迁移，不把此阶段完成视为整个改造交付。

工作区原有大量未提交修改保留；没有提交或推送授权。

## 实际变化

- 新增 `network.runtime`，模型和 Benchmark 改为借用其客户端；删除这些调用方各自创建、释放网络客户端的代码。
- `workflow-network.ts` 为缺失的网络依赖装配 run/worker 资源。CLI、SDK、检查和导出接入 `--network`。显式资源绑定优先。
- 网络文件读取与执行节点展开分开，模板检查验证字段和字面值但不要求提交端提供变量值。改变凭据值不改变计划指纹。
- 预热允许创建提供者明确声明的客户端依赖，正常结束、异常、取消均释放；去重包含依赖配置。Benchmark 预热借用 `ray.connection`，不创建模型执行任务。
- 恢复身份保存网络模板，恢复时创建短期客户端。retry 读取保存的计划，run --resume 仍要求配置和模板匹配。
- Benchmark 的原生 Ray 准备 worker 支持按名称获取缺失网络变量；协调端校验任务、节点、包和插件版本、取消状态及名称声明。客户端日志同时过滤完整凭据 URL 和解码后的密码。
- 中英文工作流使用指南、插件开发和架构说明已更新。

## 验证

- 本地相关回归：14 个文件、90 项通过、1 项跳过。日志 `.scratch/workflow-network-regression.log`。
- 预热和取消补充回归：4 个文件、33 项通过。日志 `.scratch/workflow-network-warmup-regression.log`。
- 最终网络模板、CLI、运行内核回归：3 个文件、53 项通过。日志 `.scratch/workflow-network-final-tests.log`。这些集合有重叠，不累计为独立测试总数。
- WSL 实际 Ray：auto/local 两项通过，覆盖变量仅在提交端提供、Benchmark batch 准备、执行、模型分组、补测、产物、清理恢复和取消。日志 `.scratch/workflow-wsl/workflow-network-ray.log`。
- WSL 实际 Ray Jobs：一项完整流程通过，包含新增 Benchmark 预热、执行、失败补测、集群结果丢失后恢复和在线补测。日志 `.scratch/workflow-wsl/workflow-network-jobs-warmup.log`。
- `pnpm typecheck`、`pnpm build`、`pnpm check:dependencies` 通过；依赖违规为 0。`git diff --check` 通过。
- 本阶段没有重跑全仓库默认测试集及 Docker 业务环境测试；此前记录的默认测试基线失败不能记为已解决。Ray/Jobs 使用本机 WSL 隔离容器与受控模型服务，不代表多机集群或模型质量验收。

## 后续工作和授权边界

1. AgentBundle 本机 Jobs 自动挂载仍未接入。已询问用户是否增加 `deployment.bundles`，由 Benchmark 模板生成、部署器检查挂载，并支持不同分组的 bundle。该新增部署契约尚未获确认，不实施相关代码。
2. HF_TOKEN 的业务资源声明及旧 hfToken 配置仍待迁移。
3. 旧 CLI/SDK/config/Ray 外层入口、原 Playbook 和相关测试仍待迁移、删除；旧流程能力要在声明式 Benchmark 入口完成验收。
4. 最后执行完整检查和 Docker/Ray 验收，再交付整个改造。当前没有提交或推送。
