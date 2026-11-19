# 工作流远端执行续篇

日期：2026-11-10

状态：进行中，未完成。

继续[前一任务](2026-11-10-feature-workflow-runtime.md)，实施[worker 设计补充](../../design/2026-11-10/2026-11-10-workflow-worker-execution.md)。用户批准 worker 作用域，并指定本机 WSL 验收。未授权 Git 提交或推送。

- 已核对工作区：前一任务改动仍在，未恢复或覆盖。
- WSL Ubuntu-22.04 和 Docker Desktop 正在运行，Docker 29.8.0 可用。WSL 默认没有 Linux Node，Python 为 3.10.12、未安装 Ray；已有 evaluator-ray-warmup:20261028 镜像提供 Python 3.12.14 / Ray 2.58.0，Node 24.14.0 需升级。
- 待完成：worker 作用域、通用远端单元、Ray 传输与恢复、原有流程完整迁移、旧入口删除、Playbook 与文档更新、WSL 真实验证。

## worker 与通用派发进展

- 新增 worker 作用域；同一执行槽复用固定配置客户端，不同槽各自创建实例，样例状态仍使用 attempt。拒绝动态样例配置和长生命周期资源依赖短生命周期资源。
- 新增独立样例入口 executeWorkflowUnit，复用本地步骤执行代码。校验计划、插件版本、输入指纹及执行身份；不传递 run/block 资源对象。
- forEach.executor 选择 workflow.executor/v1 资源。派发前保存恢复回执，远端资源记录绑定派发所有者；断线后不把清理状态当作成功。
- 新增 executor.ray、认证 HTTPS 检查点与分块产物传输、节点本地恢复日志和恢复锁。节点使用本地插件配置与认证，检查包摘要；application.evaluate 模板可以通过 scheduler 选择 Ray。
- 当前传输限制：单个控制消息 2 MiB，单个产物 256 MiB；超过时明确失败。尚未完成大规模记录的增量传输，不能宣称无限规模支持。

## 已验证

- Windows typecheck、build、check:dependencies 通过，依赖违规为 0。
- 工作流及节点配置聚焦回归：8 文件，70 通过、1 跳过。日志 .scratch/workflow-worker-validation.log。
- WSL Docker 真实验收：Harbor 共享/独立验证 4 项，多步骤状态/私有材料隔离 1 项，Compose 超时/取消收集 2 项全部通过。首次容器内执行 3 项因 Compose 插件缺失及测试宿主地址错误失败，WSL 原生 Node 复测通过；未修改生产代码规避失败。日志 .scratch/workflow-wsl/docker-native-validation.log；前 4 项在 WSL 副本 .scratch/docker-validation.log。
- WSL 真实 Ray 第一轮通过：2 模型 × 2 样例、产物回传、指定失败样例补测，成功样例没有重跑。使用受控模型服务，不属于真实模型质量评分验收。日志 .scratch/workflow-wsl/ray-validation.log。
- 正在增加远端清理失败恢复与跨分块二进制产物验收。新增夹具首次因 patch 格式错误失败，修正夹具后正在复测，尚未记为通过。

## 下一步

继续远端清理/取消验收、修正验证发现的问题，然后处理 Benchmark 的 run 资源引用、原生证据传输、variant/repetition、旧入口和 Playbook 迁移。当前 Benchmark 新工作流仍限制 local，旧配置和执行入口仍存在；整个改造未完成。没有 Git 提交或推送。

## 14:54 验证补充

- WSL 真实 Ray 第二轮通过：跨分块 1.1 MB 二进制产物回传、远端释放失败后在原节点恢复；恢复没有再次创建命名空间，也没有新增 attempt。日志 .scratch/workflow-wsl/ray-recovery-validation.log。
- 第三轮增加真实取消后再次通过：资源分配后取消，Node worker 中止工作并释放命名空间；结果记录为 cancelled / cleaned，全部资源有 released 回执。日志 .scratch/workflow-wsl/ray-cancel-validation.log。
- 后续新增了编译阶段的远端资源边界检查，以及 local Ray 重新启动后的同机配置摘要校验与节点 ID 重新绑定；这两项尚需后续验证，不能直接使用上一轮结果覆盖。

## Benchmark 分组与证据导出

- 本机 WSL 的真实 Ray auto/local 两种模式均通过模型矩阵、失败补测、分块产物、清理恢复和取消验收，2 项完整测试耗时约 68 秒。日志 .scratch/workflow-wsl/ray-placement-validation.log。
- 原 Ray 准备、预热、失败、超时与节点配置相关回归 11 文件 97 项通过。日志 .scratch/workflow-ray-regression.log。
- benchmark.evaluate 增加 variants（按组覆盖 services、solver）和 repetitions。各组使用独立 Solver、原生 run ID、原生结果目录和报告，单组默认行为保留。
- Benchmark 分组后的 pipeline 不同时启动所有组的准备队列，避免把 lookahead 和准备并发按组数放大。13 项 Benchmark 回归通过，包括 2 模型 × 2 次重复、各组评分不同、独立报告、续跑不重复求解和 pipeline 先启动一个组。日志 .scratch/workflow-benchmark-groups-final.log。
- 正在导出 Benchmark 原生文件清单、轨迹、验证文件和原生记录到工作流私有产物。取消后允许资源清理在 writer 关闭前保存证据；关闭后仍拒绝迟到写入。这部分已通过类型检查，回归日志 .scratch/workflow-benchmark-artifacts.log 正在生成。
- 仍未完成 Benchmark 的新 Ray 路径、旧入口/旧配置迁移、全部 Playbook 和最终全量验收。没有 Git 提交或推送。

## 新确认与下一阶段

用户已明确批准共用 ray.connection 资源（原准备器和新执行器借用连接、模板自动装配）。对应设计已补充，下一步实现连接资源、请求路由、借用连接的生命周期和 Benchmark 准备节点复用。

Benchmark 证据导出及取消后保存回归已通过：3 文件 39 项，日志 .scratch/workflow-benchmark-artifacts.log。仍未完成整个迁移，不提交或推送。

## 共用连接与 Benchmark 远端步骤

- ray.connection 负责 Python 驱动、HTTPS 请求路由和释放；executor.ray 通过显式资源依赖借用连接。application.evaluate 仍只填写 scheduler。
- 原 RayScheduler 新增借用连接方式，动态申请节点镜像保护；关闭准备器只注销本 run 的请求处理器，不关闭共用驱动。
- 共用连接后，WSL 真实 Ray auto/local 两种模式的矩阵、失败补测、分块产物、清理恢复和取消全部通过（2 项，约 69 秒）。日志 .scratch/workflow-wsl/shared-ray-validation.log。
- 本地 Benchmark 与 Ray 准备器回归 21 项通过，包含准备器关闭后连接仍可供执行使用。
- 正在接入 Benchmark 远端显式步骤、私有选题清单、原节点准备回执校验和原生结果导入；本次类型检查与依赖检查通过，WSL 真实 Benchmark Ray 验收正在运行。未验证部分不记为完成。
- 仍需旧入口/配置/Playbook 迁移、文档更新及最终全量验收。没有 Git 提交或推送。

## Benchmark Ray 补测验收

- 用户已批准区分业务输入与派发参数。WorkflowAdmission.reuseInputs 由 Benchmark 返回锁定来源、题目引用、实验指纹和 Solver 来源；dispatchFingerprint 仍校验完整绑定。未声明复用输入的其他插件保留原有完整输入比较。
- 本地运行时、worker、Benchmark 回归 3 文件 41 项通过。准备回执变化复用成功样例；业务来源变化触发执行；派发参数改变仍被拒绝。日志 .scratch/workflow-input-identity.log。
- WSL 真实 Ray auto/local 均通过原生 Benchmark 模型分组、准备与执行共用连接、显式步骤、证据导入、原生指标、部分失败补测及完成续跑。第一次两个分组求解 2 次，补测只增加 1 次，成功分组记录不变，随后续跑仍为 3 次。还覆盖通用应用矩阵、取消和清理恢复。2 项完整测试耗时约 133 秒，日志 .scratch/workflow-wsl/benchmark-retry-ray-validation.log。
- 正在删除原节点 worker 与新 Benchmark 步骤中重复的准备回执读取代码，使用同一个摘要和归属检查函数；这项提取后的验证待运行。
- 整个改造仍未完成：旧入口/配置/Playbook、Ray Jobs 部署迁移及最终全量验收仍待处理。没有 Git 提交或推送。

## 凭据读取确认及验证状态

- 用户明确同意增加资源凭据名称声明与异步按需读取，节点本地配置优先，缺少时走现有 HTTPS，不写入计划/结果/恢复日志。这是保留原 Ray Jobs 提交端认证用法所需；尚未实施，下一步按设计补充执行。
- 提取准备回执共用读取函数后，原 Ray 准备/失败/时限回归 5 文件 28 项通过。日志 .scratch/workflow-ray-receipt-regression.log。
- 增加派发节点身份记录后，修复 local Ray 重建后恢复时不应把旧节点 ID 当作执行目标校验的问题；实际执行仍严格校验节点身份。WSL auto/local 全链路复测 2 项通过（约 160 秒），日志 .scratch/workflow-wsl/shared-ray-final-validation.log。
- Windows 构建通过，依赖违规为 0。默认测试集正在运行：已看到此前 Kernel 环境问题，以及 sampling/CLI 的 5 秒超时、batch-preparation 断言失败；需待完整输出后逐项复测，未记为通过。
- 尚未迁移 Ray Jobs 部署、旧 CLI/API 路径及全部 Playbook；整个改造未完成，没有 Git 提交或推送。

## 异步凭据读取实现与验收

- 新增 ResourceProvider.credentials 名称声明；运行时 credential 改为异步，更新模型客户端、Benchmark、HTTP 记忆服务和工厂调用方。Ray 仅接受锁定输入或模型矩阵中的声明，拒绝题目和步骤输出扩大允许列表。
- 节点优先使用本地值，其次经认证 HTTPS 获取；恢复回执只保存名称，恢复时重新读取。远端值只进入内存缓存和日志脱敏集合。
- WSL 真实 Ray auto/local 两种模式均通过（2 项，约 139 秒），覆盖节点认证优先、提交端独有凭据、Benchmark 求解、失败补测、取消、清理恢复及整个测试目录的凭据泄露扫描。日志 .scratch/workflow-wsl/credential-ray-validation.log。
- 本地回归先有 22 项通过、1 项测试断言错误（无记录时 read 抛 ENOENT，而非返回 undefined）；修正断言后，核心/worker 30 项通过。日志 .scratch/workflow-credentials-core.log。Benchmark、记忆、模型比较 3 文件此前均通过。
- 上轮默认测试最终为 2258 通过、17 失败、80 跳过及 1 个未处理错误；14 项已复现为原提交的环境失败。其余 sampling/CLI 超时和 batch-preparation 写锁问题串行复测 3 文件 98 项通过，未再次出现。不能把全量测试记为通过。
- 用户已批准 Jobs 网关内存凭据和完整产物分块续跑，下一阶段实现。旧 CLI/API/配置及 Playbook 迁移、最终检查仍未完成。没有提交或推送。

## Jobs 认证及续跑传输阶段

- 网关新增 JobsCredentialVault，input.json 只写凭据名称；删除原 retry-auth 文件写入。原协调入口和补测入口经 HTTPS 获取凭据，并在退出时释放内存项。重启后必须重新提供凭据，同一 Job ID 允许重新提供值而不改变业务输入摘要。
- 网关认证回归 5 文件 18 项通过；构建通过。验证了未授权/未提供名称拒绝、临时文件不含凭据、网关重启清空内存、重复提交重新提供认证。日志 .scratch/workflow-jobs-credentials-tests.log。
- 新增 JobsSeedUploads 和 uploadJobsSeed，按 512 KiB 分块上传完整文件，校验路径、连续偏移、重复块内容、大小和 SHA-256；提交后的上传不可更改。排除进程锁及 retry-control.json。
- 续跑上传的受控回归及核心凭据脱敏 2 文件 14 项通过；通过真实 HTTPS 网关上传二进制文件后的综合回归 5 文件 29 项通过。日志 .scratch/workflow-jobs-seed-tests.log、.scratch/workflow-jobs-transport-tests.log。类型与依赖检查通过，diff 空白检查通过。
- 随后补充已完成上传的重试回执识别，相关重跑待执行。当前分块上传接口尚未接入正式工作流 Jobs 提交入口；原部署器仍使用旧元数据 seed，不能记为完整 Jobs 工作流已支持。
- 下一步：工作流 Jobs 提交/运行/预热/补测、跨宿主配置与恢复路径、结果下载合并；随后删除旧 CLI/API/配置路径并迁移 Playbook。仍无 Git 提交或推送。

## Jobs 工作流入口与文件写入复测

- 提取 executeWorkflowPlan 与受控补测执行函数到 application/workflow-execution.ts，文件加载调用同一入口；Jobs 可传入已校验计划、执行目录与异步凭据读取，不重新解释用户文件。
- 新增 executeWorkflowJob，重编译并校验包/插件/计划版本，使用 Jobs 固定的 run 目录。缺失集群结果时从已校验完整 seed 恢复；仍有集群结果时保留较新的集群状态。运行和网关下载入口已接入 kind: workflow，但客户端配置/正式提交 API/预热/补测尚未接入。
- 工作流 Jobs 受控测试与 worker 回归 2 文件 9 项通过；恢复到新的测试宿主目录后，成功样例不重跑，仅补测失败样例。日志 .scratch/workflow-job-entry-tests.log。网关及入口综合回归 4 文件 13 项通过，日志 .scratch/workflow-jobs-entry-local-tests.log。
- 本地提取后的测试出现一次 Windows run.json rename EPERM，在线补测因此超时。已让 LocalWorkflowStore 使用现有 fileRetry，并在失败后清理临时文件。应用/核心串行复测 35 项通过；故障注入覆盖 EPERM、EBUSY 可重试，EIO 保留原快照并清理临时文件。日志 .scratch/workflow-snapshot-retry-tests.log、.scratch/workflow-credential-store-tests.log。
- WSL 真实 Jobs 首次使用的 Dashboard 端口落入 Ray worker 预留区，已改为 28265/28443。随后发现网关使用不存在的 dist/infrastructure/ray/jobs-entry.js，已改为实际发布的 application/ray/entries/jobs-entry.mjs（补测同改）。当前真实 Jobs 重跑中，尚未记为通过。
- 新增工作流结果下载函数，先验证整个远端快照及产物，复制产物后最后发布 run.json；该函数还需回归测试和正式客户端接入。
- 旧 CLI/API/配置与 Playbook 迁移仍未完成，不提交、不推送。

## Jobs 客户端与日常入口接入

- 新增 runWorkflowJobs，保存无凭据值的提交回执，支持重新连接、完整产物上传和经校验的结果下载；更新本地 run.json 前验证整个远端快照。丢失集群结果时，网关返回 404，客户端使用此前完整校验的本地结果恢复。
- WSL 真实 Jobs 客户端通过 1 项完整测试；随后改用 YAML 和 runWorkflow 入口再次通过，模型请求为 a、b、b，成功样例没有重跑。日志 .scratch/workflow-wsl/workflow-jobs-client-ray-validation.log、.scratch/workflow-wsl/workflow-jobs-yaml-ray-validation.log。认证值未出现在测试的 Jobs 文件或日志中。
- YAML 支持 deployment.kind: ray-jobs，提交计划使用可移植根路径，本地输出目录与网关证书路径保留在提交端。导出配置保留部署信息和输出位置。本地网关、配置、上传、worker 及下载回归 7 文件 31 项通过，日志 .scratch/workflow-jobs-config-tests.log。
- 正在接入 Jobs 预热、在线补测和停止后的选择性补测；提取本地补测执行函数，供集群入口直接调用，避免下载结果在提交机执行。该部分类型检查通过，行为测试尚未完成。
- Benchmark Jobs 模板、跨宿主配置、原 CLI/API/配置路径和 Playbook 迁移仍待完成；整个改造尚未交付，没有提交或推送。

## Jobs 模板及补测阶段验收

- Jobs 预热调用资源 warmup，停止后的补测调用提取的 executeWorkflowRetry；在线补测通过网关交给当前协调进程。相同请求 ID 复用请求回执，不再次创建补测任务。
- 本地补测/应用/运行时/网关回归 5 文件 39 项通过；随后 Benchmark 与应用模板回归 2 文件 26 项通过。日志 .scratch/workflow-jobs-retry-tests.log、.scratch/workflow-benchmark-jobs-tests.log。
- Ray 配置新增部署侧连接参数，提交计划不含部署证书和临时目录。Benchmark 模板按组件传输声明移除本机字段，集群工厂补齐缓存路径；准备器与执行器仍借用同一连接。
- WSL 真实 Jobs 通过预热、通用应用节点执行、完整产物恢复、按题目补测、重复请求、原生 Benchmark 准备/执行/证据导入及失败补测。1 项完整集成测试约 55 秒，日志 .scratch/workflow-wsl/workflow-benchmark-jobs-ray-validation.log。
- 为支持首次运行尚未下载结果时的在线补测，客户端提交前保存计划与部署回执；网关返回运行中快照作为请求回执，不把它伪装为本地完整结果。该新增路径正在 WSL 验证。客户端提交锁防止同一运行并发启动重复 Jobs。
- 待完成：管理式 AgentBundle 构建参数、网络配置迁移、旧 CLI/API/配置执行路径删除、Playbook/测试整体迁移、最终默认测试与真实 Docker/Ray 回归。没有提交或推送。

## 首次运行在线补测验收

- WSL 真实 Jobs 扩展测试通过（约 62 秒）：首次 Job 尚未下载 run.json 时提交在线补测，远端协调进程接收失败题目，其他题目继续执行，最后只有所选失败题目增加一次执行。此前预热、节点执行、完整产物恢复及 Benchmark 补测均仍通过。日志 .scratch/workflow-wsl/workflow-jobs-online-ray-validation.log。
- 本地应用、Benchmark、Jobs 入口、网关及结果下载 6 文件 30 项通过；类型、构建和依赖边界通过，git diff --check 通过。日志 .scratch/workflow-jobs-online-tests.log 及同前缀 typecheck/build/dependencies 日志。
- 正在复测直接 Ray auto/local，确认 Jobs 连接配置没有改变原直接连接行为。
- 发现网络客户端职责需要调整，已向用户提出 network.runtime 资源方案，等待确认前不实施。目标为保留 --network，模板和 worker 使用同一份未展开模板，网络客户端由资源生命周期释放。
- 任务尚未完成；原入口、配置和 Playbook 迁移等剩余事项仍保留。

## 发布目录与直接 Ray 回归

- 直接 Ray auto/local 共 2 项完整测试通过，约 129 秒，覆盖模型矩阵、凭据、Benchmark、选择性补测、产物、清理恢复和取消。日志 .scratch/workflow-wsl/workflow-jobs-shared-ray-regression.log。
- 发布验证脚本改用 registerNativeResource，SDK 示例改为 benchmark.evaluate 工作流；验证 canonical Jobs/worker 发布文件存在。
- 仅复制 dist、playbook、package.json 并链接现有依赖的独立目录验证发现：原生 attempt 新增 workflow/run.json 后，原节点上传白名单遗漏该文件。增加此精确路径，仍拒绝锁文件、任意 workflow 子文件和路径穿越；协议回归 6 项通过。
- 修复后，独立发布目录的 13 项检查全部通过，无跳过，含包摘要、SDK、离线报告、Pi 实际受控请求、Jobs 认证入口、HTTPS 证据上传、准备回执校验和 AgentX Python 命令。日志 .scratch/workflow-distribution-check-v2.log。该验证使用本机现有依赖，未执行全新机器从包管理器安装。
- 网络资源调整仍等待用户回复；未修改 network.runtime 相关代码。检查 Playbook 时还发现 HF_TOKEN 需要纳入 Benchmark 的显式资源凭据声明，这将在配置迁移时处理，不能把所有旧 Playbook 记为已迁移。
