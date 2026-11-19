# 源码架构与执行流程

> [English](./architecture.en.md) | 中文

本文说明当前实现的模块职责、调用关系和资源所有权，随代码变化维护。新增代码的仓库规则见 [AGENTS.md](../../AGENTS.md)，组件接口和加载方法见[插件开发与加载](plugins.md)，新增题库的具体步骤见 [Benchmark 开发指南](benchmarks.md)。

## 目录职责

| 位置 | 负责的行为与主要入口 |
| --- | --- |
| [src/index.ts](../../src/index.ts) | 显式导出包根 API 和公共类型；内部模块直接引用所属实现，不通过包根转引 |
| [src/cli.ts](../../src/cli.ts)、[cli/](../../src/cli) | 安装进程信号处理、定义和分派命令、显示终端进度、设置退出码 |
| [application/](../../src/application) | 完成运行、报告、预热、补测、诊断等用户操作；创建和释放组件，选择本地执行或 Ray Jobs |
| [config/](../../src/config) | 读取 YAML、展开环境变量和 Profile、校验与脱敏；不创建 Cordis Context 或运行组件 |
| [core/](../../src/core) | 定义契约，编译和执行声明式工作流；提供选题、准备、恢复、结果和产物处理工具 |
| [plugins/](../../src/plugins) | 实现步骤、资源、模板以及 Benchmark 领域组件；原生评测编排位于 workflows/benchmark |
| [runtimes/](../../src/runtimes) | 保存特定外部程序的安装描述、调用桥接、输入输出协议和资源，如 Pi、DSH、AgentBundle、AgentX |
| [infrastructure/](../../src/infrastructure) | 实现进程、Shell、容器、网络、数据下载、安装锁、IPC、传输和摘要读取等 I/O 能力 |

core 的契约位于 `contracts/`；声明式执行在 `workflow/`，Benchmark 队列工具在 `execution/`，准备在 `preparation/`，恢复和补测资格在 `recovery/`，选题在 `selection/`，结果和来源规则在 `results/`，文件清单与轨迹在 `artifacts/`。完整目录树见[仓库目录结构](../../AGENTS.md#仓库目录结构)。

## 声明式工作流入口

`application/workflow.ts` 读取模板参数或完整步骤 YAML，装配 Cordis 注册目录，再交给 `core/workflow/compile.ts` 检查前序引用、协议、私有数据、作用域和插件版本。展开后的计划记录每个子流程的输出协议，并以摘要锁定。`execute.ts` 调用步骤和资源接口，不按 Benchmark 类型分支。`LocalWorkflowStore` 保存 run.json 与不可变产物，应用层负责运行目录写锁。

资源按首次使用创建，按依赖逆序释放；独立单元保存 case、variant、repetition 和输入摘要。失败单元重新开始一个 attempt，清理失败不会撤销已经提交的业务结果。恢复先处理未释放资源，再检查来源，然后复用成功单元。公开文本输出可由 results.rescore 模板读取，在新 run 中重新评分。

Benchmark 的 prepare/begin/solve/transfer/verify/finish 位于 `plugins/workflows/benchmark`，通过窄资源接口保存私有验证材料。声明式 Benchmark 支持本地、直接 Ray 和 Ray Jobs。准备与样例执行共用 ray.connection，集群凭据通过认证 HTTPS 按需读取；Jobs 续跑使用完整产物及摘要校验。CLI 与 SDK 均通过工作流入口执行，旧 Engine、bootstrap 和配置加载入口已删除。具体步骤和资源契约见[工作流插件开发](workflow-plugins.md)。

应用层 `workflow-network.ts` 将网络模板装配为 `network.runtime` 资源。模型和 Benchmark 借用客户端，网络资源负责创建和释放。计划只保存未展开模板；执行节点解析代理、源和凭据。预热按提供者声明创建无评测状态的依赖，恢复操作根据已保存模板创建短期客户端。

config 负责配置文件读取和解析，不加载插件模块。[plugin-patch.ts](../../src/config/plugin-patch.ts) 读取 patch、校验条目并计算 patch 摘要；[load-module.ts](../../src/application/plugins/load-module.ts) 按 patch 所在目录定位模块、读取版本或计算文件摘要并执行动态 import。配置文件读取仍有 I/O，不能把整个 config 当作纯函数集合。core 也包含文件读写，并通过契约触发组件 I/O；其约束是不依赖应用装配和具体组件实现。infrastructure 可以使用 Evaluator 契约，但不决定题目得分、补测资格或调度策略。

维护操作由资源提供者声明。`workflow-maintenance.ts` 只创建操作列出的无评测状态依赖；Benchmark 插件调用自身诊断和镜像清理方法，通用网络探测位于 infrastructure/network，Ray 节点网络探测位于 infrastructure/ray。Jobs 传递相同维护请求并返回独立结果。Bundle 名称由 Benchmark 模板收集到 deployment.bundles，部署器只检查目录并按名称创建只读挂载。

## 允许的源码依赖

下表描述仓库源码之间的允许关系，不限制 Node 内置模块和第三方包。

| 调用方 | 允许引用的目录 |
| --- | --- |
| core | core |
| config | config、core |
| infrastructure | infrastructure、core、允许清单中的 config 模块 |
| runtimes | runtimes、infrastructure、core、允许清单中的 config 模块 |
| plugins | plugins、runtimes、infrastructure、core、允许清单中的 config 模块 |
| application | application、config、core、plugins、runtimes、infrastructure |
| cli | cli、application、core |

`src/index.ts` 和 `src/cli.ts` 是公开导出和进程入口，不受上表的目录限制。其他内部模块不得引用包根或用 `arsi-evaluator` 自引用绕过规则。config、infrastructure、runtimes 还禁止引用 `core/execution/`。

运行 `pnpm check:dependencies` 检查这些限制。规则和 config 允许清单维护在 [check-dependencies.mjs](../../scripts/check-dependencies.mjs)，[dependency-baseline.json](../../scripts/dependency-baseline.json) 必须保持为空。新增 config 文件不会自动获得其他层的引用权限。

检查覆盖静态导入、类型导入、再导出、字符串动态 import、可解析 require、缺失的相对模块和可执行导入循环；纯类型引用仍受目录规则约束，但不计入初始化循环。以下内容需要另外检查：

- plugins 内部允许跨角色引用，脚本不能判断引用是否有合理的业务用途。
- config 允许清单不是对函数无副作用的自动证明。
- 变量拼出的模块地址、`assets/` 中的代码、Python 依赖和资源 URL 不由导入图完整覆盖。
- 资源复制、进程入口、取消和清理行为需要构建、集成及分发验证；零依赖违规不能替代这些验证。

## 运行流程与资源所有权

CLI `run` 和 SDK `Evaluator.run()` 调用 [application/workflow.ts](../../src/application/workflow.ts)。

1. `openPluginRegistry` 创建 Cordis Context，加载内置入口、随包发布的插件及显式 patch；同一次操作复用该注册表。
2. `readWorkflowConfiguration` 将模板参数展开为步骤和资源，装配网络依赖，交给 `compileWorkflow` 校验。模板决定步骤顺序，内核不识别 Benchmark 名称。
3. [workflow-execution.ts](../../src/application/workflow-execution.ts) 获取运行目录写锁，打开工作流 Store 和补测控制，再调用核心执行器。部署为 Jobs 时由应用层提交计划，节点不读取提交端的本机路径。
4. [execute.ts](../../src/core/workflow/execute.ts) 顺序执行步骤，并在 `forEach` 中按并发限制调度样例。资源仅在声明的端口中可见，按 run、worker、attempt、step 作用域创建和释放。输出必须通过插件声明的协议校验。
5. 应用层在完成、失败或取消后调用离线报告接口，再关闭注册表和写锁；已保存结果随应用异常返回，调用者可定位部分结果。

持久化、取消、资源清理、协议校验、脱敏和恢复记录由内核提供，不是用户可删除的步骤。数据读取、应用调用、记忆读写、渲染、评分和业务报告可以由步骤插件替换。删除产生下游必需数据的步骤会在编译时失败，需要同时修改后续输入绑定。

Benchmark 模板以 `benchmark.runtime` 持有题库、选题、准备及原生 Store；attempt 资源持有公开任务、私有验证材料和执行环境。Solver 只接收公开任务，私有材料由评分步骤通过声明的私有端口使用。Environment、Solver 等已有组件由 `registerNativeResource` 注册并通过资源工厂创建，创建失败与正常退出都释放对应 Cordis effect。

工作流根目录保存 `plan.json`、`run.json`、产物和 `report.md`。Benchmark 原生证据位于 `benchmark-evidence/<run-id>`；模型分组和重复实验位于各自 `benchmark-groups` 子目录。工作流状态与题库评分各有自己的持久化记录，不能用原生 manifest 代替工作流完成状态。

离线报告通过 [workflow-report.ts](../../src/application/workflow-report.ts) 加载已保存的报告步骤及其声明的渲染依赖，校验来源与版本，读取保存的产物。它不创建模型、容器或评测资源。Benchmark 报告继续调用 Metrics/Reporter；没有专用报告步骤时生成通用摘要。

## 补测、Ray 与 Docker

补测由 [application/retry-control/mailbox.ts](../../src/application/retry-control/mailbox.ts) 处理请求文件、锁、事务和 IPC。核心执行器按样例预留队列并保存请求绑定，成功后才提交队列；重复请求不会重复派发。关闭时先停止接收并等待在途事务。

自动重试由资源插件判断资格，内核限制次数并等待前一 attempt 清理。Benchmark 派发前重新准备失败题目，更新准备凭证和节点位置；派发参数重新校验，业务输入指纹保持不变。准备资源的失败信号会停止派发并取消当前执行块。

续跑先恢复未释放资源，再校验业务输入和来源，最后复用完成样例。若原生评分已提交但工作流输出尚未保存，`admission.reconcile` 校验原 attempt 的有效结果和产物，再恢复输出；证据不匹配不会直接复用。网络恢复使用保存的模板，运行时环境变量和凭据按当前值读取，不重新加载已改动的本机网络 YAML。

Scheduler 只负责 Benchmark 准备、容量和维护操作。执行块由 `executor.ray` 派发给工作流 worker；准备与执行共享 `ray.connection`。节点保留准备凭证，执行前验证完整参数。

| 操作 | 实现位置 |
| --- | --- |
| 提交、跟踪 Ray Jobs 和下载远程结果 | `application/ray/`，调用 `infrastructure/ray/` 客户端 |
| 将 attempt 调度到 Ray 节点 | `plugins/resources/ray-executor.ts`，通过 ray.connection 使用 Python driver |
| 节点加载插件并执行任务 | `application/ray/workflow-worker.ts` 执行工作流；node-worker.ts 仅执行 Benchmark 准备与维护 |
| 准备 Docker 镜像、运行时及会话 | `plugins/environments/docker/environment.ts` |
| 会话内执行、传输、阶段切换和关闭 | `plugins/environments/docker/session.ts` |
| 共用 Docker 命令、镜像和构建工具 | `infrastructure/containers/` |

Ray Jobs 部署与 工作流执行器的样例调度处于不同层次。Jobs 入口直接调用 application 的操作函数，不通过 CLI 参数解析执行。Docker 准备实现仍包含多种镜像策略；现有拆分不表示每种策略已有独立模块。

Docker 的 `materialize()` 和按需 `prepare()` 共用 `prepareDependencies()`，准备主容器、网关和 Compose 服务的镜像及运行时。`prepare()` 有凭证时先校验本地镜像，再把已确定的镜像交给 `startSession()`。启动主容器和网关时使用 `--pull never`，Compose 还使用 `--no-build`。启动失败时先清理已创建的容器、Compose 项目和网关，再释放镜像租约。启动成功时，容器、网关、Compose 项目和租约交给 `DockerSession.dispose()`。

Docker 读取构建目录中的文件和权限来计算镜像缓存键。缓存未命中时，`taskImage()` 将目录复制到快照，核对内容和权限后才运行构建。AgentX 使用打包时组装的 bridge 目录，其中包含共享的 `reasoning_effort.py`。

本地 `taskImage()` 在构建任务快照时启动[包源转发服务](../../src/infrastructure/containers/build-package-relay.ts)，通过构建参数指定原 Dockerfile 指令使用的公共 PyPI 或 npm 包源。服务按请求重试和回退，构建完成或取消时由 `taskImage()` 关闭。镜像命中本地缓存或从仓库下载时跳过这一步。

## Benchmark 与插件注册

Benchmark 分为 `agent-harness/`、`inference-engine/`、`operator/`，各自保存所属 Profile 并在本类 `index.ts` 注册。分类不增加 YAML 类别字段，也不在核心执行流程中按类别分支。具体新增位置见 [Benchmark 开发指南](benchmarks.md#新需求的修改入口)。

[plugins/index.ts](../../src/plugins/index.ts) 组合注册入口。Benchmark、Solver、Environment、Verifier、Store、Scheduler 使用各自入口；Metrics 和 Reporter 分别由 [metrics/index.ts](../../src/plugins/metrics/index.ts) 和 [reporters/index.ts](../../src/plugins/reporters/index.ts) 注册。外部插件通过显式 `--patch` 加载，省略参数不扫描默认目录，配置方法见[插件开发与加载](plugins.md)。

同一功能可以跨角色目录。例如 AgentX 的输入和证据在 `plugins/benchmarks/inference-engine/agentx/`，负载调用在 `plugins/solvers/agentx-replay.ts`，安装和桥接在 `runtimes/agentx/`，指标与报告分别在 metrics 和 reporters。`evidence/` 直接解析保存的结果，不通过注册入口加载安装器或采样进程；共享版本信息来自无 I/O 的 `runtimes/agentx/versions.ts`。

构建时，[build-plugins.mjs](../../scripts/build-plugins.mjs) 扫描仓库根目录下的 `plugins/*/arsi-evaluator-plugin.json`，把构建产物和 patch 写到 `dist/plugins/<id>/`，并生成默认插件列表 `dist/bundled-plugins.patch.yaml`。运行时由注册表加载这份列表。CLI 命令由宿主定义。

## 构建、发布与维护

[package-runtime.mjs](../../scripts/package-runtime.mjs) 在 TypeScript 编译后复制 Profile、Python、运行时资源及许可证，生成进程入口和完整性清单。源码没有 `adapters/`；发布包中的少量旧路径由构建生成，服务于已有部署。具体兼容路径和独立安装包的验证命令见[发布进程入口](plugins.md#发布进程入口)。

Pi 构建只重写 runner 依赖副本，准备模块继续使用正式目录中的依赖和资源。兼容目录包含独立运行所需文件和清单。内置 Benchmark 的 Profile 和专属资源由打包脚本显式复制。兼容文件和仓库插件产物都在计算包摘要前生成。

修改跨模块调用时运行依赖检查、类型检查和相关测试；改动构建或运行时资源时还要构建并验证实际安装包。测试位置、组件验收和真实环境要求见[插件开发与加载](plugins.md)、[运行时与并发检查](runtime-validation.md)及[仓库开发规范](../../AGENTS.md#开发流程)。

职责、调用关系或所有权发生变化时更新本文及对应英文版本；组件细节在插件/Benchmark 指南维护，用户操作在用户指南维护。日期目录中的 design/task 保存决策与当次验证证据，不作为长期架构说明的唯一入口。

## 多模态输入传递

Benchmark 在 `PublicTask.attachments` 声明公开文件及输入策略，并通过来源锁和环境初始文件准备字节。核心检查声明与 Solver 能力；`runtimes/multimodal` 从实际执行环境读取附件、验证摘要并渲染指定 PDF 页，各 Harness Runner 将内容转换成 SDK 消息。具体契约和验证见[多模态插件开发](multimodal.md)。
