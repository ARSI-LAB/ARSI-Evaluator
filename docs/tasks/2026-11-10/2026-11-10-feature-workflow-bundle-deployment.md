# 工作流插件改造、旧入口迁移与验收

日期：2026-11-10

类型：feature

状态：代码改造完成。最终验证及限制见末节；此前各节记录阶段状态，不作为当前待办。

继续整体插件化改造，网络资源阶段已交付，见 [前篇](2026-11-10-feature-workflow-network-resource.md)。本次先完成已批准的 bundle 部署声明、模板收集、Jobs/导出/补测传递、脚本挂载及 WSL 验证，再继续 HF 凭据和旧入口迁移。保留其他未提交修改，不提交或推送。

## 已完成与验证

- Benchmark 模板收集实际 Solver 分组的 bundle；显式目录覆盖、导出绝对路径、Jobs 预热/运行/补测传递同一映射。启动脚本校验 bundle.yaml，按名称挂载只读目录，通过摘要判断是否需要重建；删除固定 jobs-agentbundle.yaml 和部署器中的 Solver 分支。
- WSL Docker 实测通过：三个容器读取两个不同父目录下的 Bundle，写入被拒绝；删除一个映射并重建后挂载消失。受控测试不调用真实模型。
- 原生 secretFields 支持 hfToken: {credential: HF_TOKEN}，只在创建工厂前解析；Ray 准备、执行及 Jobs 协调端均按声明获取。修复 Profile 默认缓存目录在展开导出后无法重新读取的问题。
- HF 仅提交端提供的真实测试通过：Ray auto/local 两种模式 2 项，Jobs 1 项。包含准备、执行、续跑、补测和凭据不落盘检查。首次新夹具字段名 requireHfCredential 被敏感字段规则拦截，改为 requireDatasetAccess 后通过。
- 已批准并实现 [资源维护操作](../../design/2026-11-10/2026-11-10-workflow-resource-maintenance.md)。doctor 与 cleanup-images 由 Benchmark 资源声明，操作列出依赖和凭据；应用层共享预热遍历和资源关闭。网络探测移至 infrastructure，Benchmark 诊断移至 plugins/workflows/benchmark。CLI 保留 cleanup images --yes，并增加 --execute 同义选项。
- 维护回归最终 7 文件 47 项通过；此前一轮涉及网络资源的 6 文件 48 项通过。真实 WSL Jobs 维护、预热、运行、恢复及在线补测 1 项通过（workflow-maintenance-auth.log）。维护凭据只扫描操作声明，修复仅用于检查的资源没有获取凭据的问题。
- 维护阶段类型检查、构建通过；依赖检查 0 违规。Windows 全量运行因多处时限失败中止，日志保留于 .scratch/workflow-bundles-full.log，不记为通过，也不将这些失败全部归为基线。

## 当前继续项

- 用户已批准 [有次数上限的自动重试](../../design/2026-11-10/2026-11-10-workflow-bounded-retry.md)。已实现 forEach.retry、策略资源接口与 Benchmark 的流式中断规则。类型检查与构建通过，3 文件 45 项核心/Benchmark 回归通过；WSL Ray Jobs 包含真实远端中断后自动新建 attempt 的 1 项测试通过（workflow-automatic-retry.log）。
- 随后迁移 Benchmark 初始化、Playbook 和 CLI/SDK 旧入口，迁移相关测试，删除旧 Engine/application/Jobs 分支。55 份 Benchmark Playbook 已转换为 schemaVersion: 2 / benchmark.evaluate，使用 apiKeyEnv 和 HF 凭据引用，并显式保留原结果位置；使用官方网络配置、占位模型参数进行无认证编译检查，55 份通过。初始化命令已改为生成同一格式，相关旧测试与入口尚未迁移，不能宣称整体迁移完成。
- 最终仍需默认测试集、真实 Docker/Ray 完整回归和独立发布检查。既有真实验证不替代后续代码变化后的检查。

## 授权边界

已获得 Bundle、维护操作与有限自动重试接口的明确授权；保留此前 worker、ray.connection、network.runtime、业务输入指纹和内存凭据等决定。不新增未批准的架构方案，不提交或推送 Git，不修改已交付历史设计/任务正文。

## CLI 与 SDK 阶段记录

- SDK 已删除旧运行入口选择，始终返回工作流结果；配置/执行/释放异常保留阶段和已保存的结果。19 项 SDK 回归通过，覆盖取消、回调错误、释放错误、离线报告、续跑与 Jobs 路由。
- CLI 已删除旧配置与旧结果格式分支，run/inspect/warmup/doctor/report/retry 调用新工作流；主机全量镜像清理保留独立应用函数，带 YAML 的清理由资源维护操作处理。
- 用户批准[模板参数覆盖与资源预览](../../design/2026-11-10/2026-11-10-workflow-cli-parameters.md)。已实现 overrideParameters、Benchmark preview、内存 CLI 密钥，新增覆盖/选题/无认证预览测试。第一轮发现模板参数预解析错误接受 apiKeyEnv 的问题，已修复，4 项快捷参数测试通过。
- CLI 切换后的 SDK、应用和维护 3 文件 37 项通过；配置导出迁移后 9 项通过。初始化、镜像清理测试继续迁移中；旧 application/Engine/Jobs 源码和其他旧测试仍待删除或迁移，未完成最终全量验收。
- 修复 managedLocal Jobs 补测先连接已停止网关的问题：先核对本地回执，再启动集群并读取连接凭据。受控回归通过；本次尚未验证完整管理集群停启。

- Jobs 网关与协调进程已删除旧 config/serviceAuth 提交、旧独立补测入口、旧 warmup/image-cleanup 路由及旧结果下载分支；只接收工作流计划和资源维护请求。构建脚本及发布探针同步删除 jobs-retry-entry，网关拒绝未声明字段。
- Jobs 切换后 Windows 回归 5 文件 19 项通过，4 项因平台或工具条件跳过。新增 WSL 无模型认证预览先失败：公共工厂仍尝试读取未声明模型认证；已修复 requireCredentials=false 不读取模型凭据。随后 WSL 真实 Jobs 完整受控场景 1 项通过（83 秒），包括预览、维护、预热、运行、上传证据恢复、自动重试和在线补测，日志 workflow-cli-preview.log。
- 发现新模板漏掉旧工厂入口的服务引用检查，已在 Benchmark 配置校验中调用纯服务引用检查；新增未知 judge 服务的回归。首轮回归夹具缺少 base_url，补齐后 5 文件 23 项回归通过。
- 用户已批准[结构化进度](../../design/2026-11-10/2026-11-10-workflow-progress.md)。已接入 WorkflowEvent.progress、插件日志、SDK/CLI、Ray attempt 通道及 Jobs 正式日志/内存预览。内核脱敏错误详情和实时输出；远端检查任务身份，预览不进入结果或 RPC 缓存。6 文件 69 项回归、类型检查、依赖检查通过，WSL 真实验证通过：Jobs 1 项（90 秒），直连 auto/local 2 项（127 秒），均验证远端阶段、实时工具预览、结构化错误和脱敏。旧 CLI 行为测试继续迁移。

- Jobs 客户端回归修复结果下载前释放锁与未处理 Promise 异常：在锁的 try/finally 中等待 follow 完成。

## 离线报告与命令回归

- 用户已批准[离线报告接口](../../design/2026-11-10/2026-11-10-workflow-offline-report.md)。步骤声明 report.rebuild 与渲染依赖；保存报告来源及版本，离线只加载选中模块。运行结束后复用已打开的注册表，不重复注册。Benchmark 读取原生证据并使用已有 Metrics/Reporter；取消时也生成部分报告。
- 运行入口报告移至根 report.md，显式续跑保存 reports/initial 与 resume-N，补测和离线重建更新当前报告。4 项专项回归通过；SDK 19 项通过。首轮发现测试仍预期通用摘要而非自定义报告，以及 Jobs mock 没有创建它声明的下载目录，已更新；重复注册问题已通过复用注册表修复。
- 运行 ID 索引由工作流应用入口登记；原生 Store 不再把同一 ID 指向嵌套的 Benchmark 证据目录。补测从保存的本机报告加载信息找回原 patch。Jobs 保存提交端加载位置，续跑上传排除它，结果下载保留已有提交端位置。
- CLI 测试已切换 schemaVersion: 2 和新结果路径；旧离线报告测试由新的插件选择、版本、取消、历史测试替代。完整 CLI 回归 41 项通过。
- 报告增加 UTF-8 附件和相对链接调整，逐题报告随历史快照保存；5 项报告专项、SDK 20 项以及 Jobs 下载/执行 2 项，共 27 项通过。类型、依赖和构建随后通过。WSL Jobs 报告与预热完整验证 1 项通过（97 秒，workflow-warmup-report.log）。旧生产引擎及其他旧测试尚未删除，整体目标仍未完成。


## 预热摘要及旧 Jobs 入口删除

- 用户批准[预热摘要与明细](../../design/2026-11-10/2026-11-10-workflow-warmup-summary.md)。warmup 返回维护结果，summary/details 可选；Benchmark 返回就绪统计与失败原因，CLI 直接展示，部分失败退出码 1。删除旧 application/warmup.ts。
- 回归发现插件直接读取环境变量的失败明细未脱敏，已按环境凭据规则处理完整维护结果；新增异步凭据解析和 Jobs 往返验证。6 文件 66 项通过、1 项新夹具因缺少 pathBase 失败；补齐后维护测试 7 项通过。构建曾与依赖 dist 的测试同时运行导致临时产物缺失，已结束构建后重测，不计入功能回归通过。
- DeepSWE 配置测试 28 项通过。Ray 节点参数测试已改用工作流提交，6 项通过。补测凭据 3 项通过，覆盖 Solver、Verifier、Benchmark judge：缺少当前凭据不新增 attempt，重新提供后读取当前值，保存文件无密钥。
- 删除旧 application/run.ts、application/retry.ts、application/ray/deployment.ts、warmup-result.ts，删除对应旧网关运行索引。Jobs 下载只处理摘要校验及完整快照；删除原生 manifest 合并、旧报告路径改写、仅打包元数据的 buildResumeSeed。
- 删除旧格式专用测试；使用新的工作流下载、完整 seed、维护返回值和真实补测测试覆盖可观察行为。删除后相关 6 文件 28 项通过（workflow-deployment-removal.log）。后续仍需对这些最新删除执行静态检查和构建，并复跑 WSL；前述 WSL 结果发生在这些删除之前。
- 剩余重点：127 处旧 runEngine 测试调用、旧配置加载与报告入口、独立发布消费者、长期文档及默认测试集。不能将本阶段完成视为整个插件化改造已完成。不提交、不推送。


## 旧引擎行为测试迁移

- 新增 tests/fixtures/engine/workflow.ts，仅把受控组件注册为资源并执行实际 Benchmark 模板，不复制运行逻辑；原生证据路径由返回值提供。6 个旧引擎测试文件改用此夹具，其他调用仍待迁移。
- 用户批准[后台准备失败信号](../../design/2026-11-10/2026-11-10-workflow-admission-failure.md)和[重试派发前准备](../../design/2026-11-10/2026-11-10-workflow-dispatch-preparation.md)。已实现 failureSignal 和执行器 prepare，刷新回执后重新校验派发参数，再保存恢复信息；原 prepareRetryTask 移入 Benchmark 准备模块供新流程和待删除旧引擎使用，避免两份重试准备代码。
- 修复原生状态在准备异常时仍为 running；正常结束仍完成状态保存和资源释放。后台准备失败及时取消占用中的执行槽，并保留实际失败题目的原生诊断。取消时等待批量准备退出再关闭 Store；批量超时只记录已开始准备的题目。
- 修复规划顺序校验、准备进度题号、续跑重复准备已完成题目、取消自动重试时空 attempt 消耗次数。题目规划失败且 onError=abort 时只处理实际失败题目，不给未准备题目制造失败记录。
- 迁移测试同时改正夹具：执行并发显式写入配置；超时使用配置允许的整秒；检查新的原生证据路径和工作流错误记录。旧 executeReady 模拟远端重试测试删除，其行为由真实 Ray/Jobs 的自动重试测试覆盖。
- 验证：内核 26 项通过；规划错误 8 项、验证运行时 16 项通过；4 文件迁移首轮 55 通过/29 失败，逐项修复后 79 通过/4 失败（均为批量准备），随后批量准备和派发共 25 项通过。准备取消及成功题目复用专项 2 项通过。最新类型检查通过。最新代码尚待构建、依赖检查和 WSL 验证。
- 后续仍需其余旧引擎调用、旧配置/报告 API、发布消费者、长期文档和全量验收。上述阶段结果不能代替整体完成。


## 重试准备验收与结果恢复

- 派发前准备改动的类型、构建与依赖检查通过；WSL 真实 Jobs 1 项通过（94 秒，workflow-dispatch-preparation.log），验证自动重试创建第二轮准备并保存新的 selection 产物。此证据早于以下结果恢复改动。
- engine、sampling、network-recovery、dataset-live-progress 继续迁移到实际 Benchmark 工作流；删除三个仅针对旧 scheduler.executeReady/setup 接口的断言，新远端握手与执行由工作流及真实 Ray 测试覆盖。
- 发现模型认证失败在 onError=continue 下仍继续派发，已接入资源失败信号；补任务完成计数、来源下载失败的原生诊断。旧选题测试夹具需显式声明实际 metrics 和并发；工作流失败读取持久化错误，配置非法仍直接拒绝。
- 用户批准[已提交结果恢复](../../design/2026-11-10/2026-11-10-workflow-result-reconciliation.md)。实现 admission.reconcile，清理后校验业务指纹再恢复原 unit 输出；Benchmark 校验原 attempt 和证据，LocalRunStore 提供只读 readAttemptEvidence。避免原生评分已保存、工作流输出未保存时再次调用模型。
- 类型检查通过；恢复行为测试仍在执行。前轮选题/引擎 84 项通过、10 项失败，包含 Windows 并发文件写入导致的 5 秒测试超时，以及确认的已提交结果重复执行问题；不能记为通过。网络测试 4 项通过、3 项失败，分别为高并发夹具 10 秒任务超时、Windows 短路径比较和手动请求早于工作流完成事件；正在修复夹具并重跑。
- 修复 locateRun 对当前目录和无分隔符已有目录的识别；新增运行索引回归待执行。整体迁移仍未完成，不提交、不推送。


## 旧运行入口删除后的验证

- 结果恢复、选题、引擎底层行为与运行索引 4 文件 125 项通过；在线补测、100 题并发统计、数据源进度与派发 4 文件 42 项通过。真实 WSL Jobs 1 项通过（114 秒，workflow-result-reconcile.log），覆盖最新证据导入、自动重试和续跑。
- 续跑夹具改为实际运行到第二题后中断，保留第一题成功记录与第二题未确认清理；10 项续跑回归通过。删除旧 manifest 对 evaluator 版本变化的例外测试，新工作流按保存的实现指纹校验。
- 删除 src/application/run-engine.ts、src/plugins/workflows/benchmark/run.ts、src/application/report/index.ts，以及对应包根导出；源码和测试中没有 runEngine/rebuildReport 调用。公开内核边界测试、发布 TypeScript 消费者改用工作流 API。
- 迁移 AgentX、OfficeQA、补测控制和真实 harness 测试入口。首轮 30 通过、3 失败、13 条件跳过；修复两处旧 YAML 夹具及补测控制启动故障后，33 项通过。正常评测在控制文件不可用时继续运行并发出诊断，显式补测仍要求请求事务成功。
- AgentX 离线业务报告和分点报告改为从重开的 Store 直接调用 Metrics/Reporter，不再依赖已删除旧应用入口；11 项通过。通用离线插件选择/版本/产物/历史仍由 workflow-offline-report 测试负责。
- 删除后类型和构建通过。旧 application/config.ts、config/load.ts、bootstrap/create-components、Ray 原生执行分支和相应配置/发布测试仍在迁移；当前不能宣称整个旧入口已经清理干净。长期文档与最终默认集仍待处理。


## 配置入口、组件工厂与 Scheduler 清理

- 配置测试改为 schemaVersion: 2 和实际 inspect/export 工作流；Profile 与 AgentX 配置 27 项、配置与补测凭据 58 项、选题配置 38 项、Benchmark 示例 5 项、Harbor 时限 9 项通过。数据集、裁判和 SimpleAgent 6 文件 86 项通过、2 项条件跳过。新增未使用服务无需密钥的 Benchmark 回归，16 项通过。
- 数据集凭据测试覆盖所有内置定义题库，保存和导出只含 credential 引用，打开资源时读取当前凭据，并验证轮换后的下载认证。
- 删除 application/config.ts、application/plugins/bootstrap.ts、config/load.ts、loaded.ts、export.ts、explain.ts 和包根旧导出。原 LoadedConfig 的有效调用改用 ExecutionConfig。删除未使用的 distributed-receiver；普通传输工具保留。
- 插件加载测试改为资源创建、模板校验和真实工作流失败释放；旧 YAML 装配测试不再维持旧入口。首轮 120 项通过、2 项失败、8 项条件跳过；修复绝对路径夹具及 doctor 漏组件组合校验。doctor 在凭据可用时先创建并校验组件，再做外部诊断；凭据缺失继续返回诊断明细，不使用伪造凭据。此修复随 Scheduler 回归通过。
- 删除 TaskScheduler.setup/executeReady/recoverAttempts、LocalScheduler 执行队列和 RayScheduler 原生执行分支。Ray node-worker 只保留原生准备入口，拒绝原生评测执行请求；实际评测由工作流 worker 完成。节点准备工厂移到 application/ray/preparation-components.ts，只创建 Benchmark、Environment 和 Solver。
- Scheduler 第一轮 65 项通过、6 项失败，失败来自新队列夹具错误填写 onError=abort；改为工作流规定的 stop 后 11 项队列回归通过，覆盖 50 题/25 槽补位、取消、活动步骤释放与准备输入失败。原生 Ray 执行测试迁往工作流；准备测试继续保留。
- 当前仍需：Ray 故障边界回归、发布包 HTTPS worker 探针迁移、ray-smoke 接受新结果格式、分组准备失败场景、长期文档、最终全量测试及 WSL。上述数字不代表整个改造验收通过；不提交、不推送。


## 默认测试与分组失败处理

- 旧 Scheduler 删除后的类型、依赖与构建检查通过。WSL 真实 Jobs 1 项通过（109 秒，workflow-scheduler-removal.log）。独立打包目录的 HTTPS worker、准备凭证、维护、Jobs、Pi、AgentX 探针共 13 项通过、0 跳过（workflow-distribution-v3.log）；该目录使用 npm pack 内容和当前安装依赖，不等同于全新下载依赖。
- 新工作流 Ray 故障回归 3 项通过，保留节点丢失、退休确认与架构不支持错误，防止提交端执行远端步骤。
- Windows 首轮默认集 2282 通过、26 失败、82 跳过（workflow-full-suite.log）。已将 doctor/network、在线 Jobs 补测等剩余旧 YAML、原生结果路径及协议夹具改为工作流格式；报告断言改为实际 Markdown 输出。
- 模型认证和流式取消测试在 Node 24.22.1 下重跑；原 Node 24.19.0 的内置 fetch 安全测试不通过。没有改变 package.json 的版本下限。校验后下载的运行时仅在 .scratch。
- 分组准备故障已复现：第一组元数据失败后错误创建了未准备题目的记录。准备阶段现在只保存实际规划失败，发出 admission 失败信号并停止后续分组。4 文件 31 项通过、1 条件跳过（workflow-planning-regressions.log），覆盖 batch/pipeline、分组、原单组规则和当前运行时网络变量。
- 修复 Kernel 产物清单在 Windows 上未转成相对 POSIX 路径；Python 测试以自身文件定位夹具，Windows 使用 python 并在同一盘符临时目录运行。Windows 17 项 profile 和 7 项 timing 分别通过；WSL 对应 24 项也通过。
- 最新 WSL 构建及真实 Jobs + Kernel 共 25 项通过（workflow-final-jobs.log），Jobs 耗时约 131 秒。真实浏览器鹈鹕流程 6 项通过（workflow-final-pelican.log），确认生成 PNG 并传给受控视觉裁判，不代表真实模型质量得分。
- ray-smoke 的接受脚本改为读取 run.json、工作流派发记录和嵌套原生证据；office Solver 改用资源注册，节点配置增加 workflowWorkerEntry。已检查脚本语法，尚未运行这套两节点接受脚本。
- SDK、架构、配置和插件指南已移除旧 API 及结果路径说明；完整 YAML 示例改为 schemaVersion 2，认证改用引用。修改文档的相对文件链接检查通过。仍需检查示例内容和剩余过时表述。

## 最终验收进展

- 第二轮默认集 2307 通过、6 失败、82 跳过；失败来自两个 doctor 来源路径断言及四个准备阶段测试超时。准备测试保留业务时限与并发断言，调整包含实际文件保存的启动等待，并在失败后等待释放。第三轮默认集正在运行，不能记为通过。
- WSL 真实直连 Ray auto/local 2 项通过（196 秒）；Docker Bundle 挂载 1 项通过（14 秒）。Docker 首次验证容器缺少 compose 插件，挂载本机插件后通过。
- 用户已批准运行时配置来源信息，见当日 workflow-configuration-origins 设计。应用层提供配置、patch 和按资源名保存的网络文件路径；不进入计划、指纹或 worker。doctor 使用真实路径生成可复制命令；无提交端来源时不再推测文件名，明确提示使用提交端配置。CLI doctor 转发诊断日志。相关 59 项通过，类型、依赖和构建通过。
- 最终分发包探针 13 项通过、0 跳过（workflow-distribution-v4.log），独立目录使用已安装依赖，不是重新下载依赖。Node 版本下限已改为 24.22.1 并按规定更新 package-lock；替代上文“没有改变版本下限”的阶段结论。
- 额外执行两个独立 Ray worker 的验收。首次被测试用只读源码挂载阻挡，改为构建产物挂载；随后发现 smoke 镜像缺少默认网络模板，已在 Dockerfile 增加 playbook/network。真实执行、续跑和最终默认集仍待结果，不提交、不推送。


## 最终真实执行与失败边界

- 两个独立 Ray worker 的正常运行、离线报告和续跑通过，保存两个不同节点 ID；续跑没有新增成功题目的 attempt。准备失败验收先因默认 onError=continue 与旧脚本中止预期不符而失败，显式改为 abort 后发现真实缺陷：准备异常被分配给其他题目并派发远端任务。
- 修复 Benchmark 准备 catch：onError=abort 时报告已批准的 admission 失败信号，停止执行块；资源关闭只保存真正失败题目的诊断。新增本地回归，相关 69 项通过；WSL 两节点准备失败验收通过，零派发（workflow-two-node-prepare-fail-v4.log）。类型、依赖和构建通过。
- 第三轮默认集 2314 通过、1 失败、82 条件跳过，并有该失败测试清理未等待造成的未处理异常。失败来自批量准备启动等待 1 秒；调整等待并在 finally 等待完整运行后，14 项通过。随后增加准备失败回归，正在执行最终默认集，不能沿用前轮数字宣称通过。
- 增加来源信息后的 WSL 真实 Jobs 验收 1 项通过（123 秒，workflow-origins-jobs.log），覆盖内存凭据、预览、维护、预热、运行、上传完整证据续跑、自动重试与在线补测。
- 55 份 Benchmark Playbook 无认证编译检查通过（workflow-playbooks-final.log）。模板发现命令通过；手工 init 被本机默认网络配置的未知 version 字段阻挡。改为使用内置网络模板校验示例，生成配置不依赖或修改用户网络文件；专项回归待结果。
- 文档修正删除的 Scheduler 执行接口、严格续跑要求和结果路径；历史设计仅修复已删除源码的链接，改为固定提交。


## 收尾复核

- 模板初始化使用内置网络校验后，相关 18 项通过；用户的默认网络文件未改动。准备流水线测试改为等待 Solver 实际开始，避免用瞬时 Store 记录数量判断，并在所有受影响门闩的 finally 中等待运行释放。准备两文件 51 项通过。
- 前一轮默认集 2315 通过、2 失败、82 跳过，另有未等待测试任务退出引发的锁异常；它在运行时加载过修复前模块，不能当作最终结果。已固定代码，重新构建后以默认 4 个 worker、单条测试与 hook 30 秒预算运行全部测试；业务阶段时限断言不变，结果待完成。
- 两节点最新正常运行通过（workflow-two-node-final-v2.log），评分、节点放置和产物通过校验。曾出现 Ray Client Server 启动失败，日志位于 workflow-ray-client-diagnostics.log；重启本次测试集群后续跑通过（workflow-two-node-resume-restarted.log），成功任务没有新增 attempt。该环境故障不记为首次通过。临时 Compose 项目已停止并移除，结果和诊断保留。
- 84 份新增/修改 Markdown 的相对文件链接无失效，git diff --check 通过。中英文工作流指南新增旧 YAML、注册接口、SDK 与历史结果的支持矩阵。


## 最终交付结果

- 当前 CLI/SDK 只使用工作流入口。步骤、资源、模板支持显式引用与编译校验；Benchmark 是内置模板，应用比较、记忆问答与 SVG/浏览器/视觉评分提供外部插件示例。旧引擎、旧配置加载/组件工厂、旧 Ray 原生执行分支及对应入口已删除，仓库内调用方和 55 份 Benchmark YAML 已迁移。
- 保留原有预热、诊断、镜像预览/清理、参数覆盖、选题预览、结构化进度、自动重试、在线补测、取消清理、已提交评分恢复及离线报告。最新批准的配置来源信息仅用于本机诊断，不进入计划或 worker。
- 最终类型检查、依赖检查（0 违规）、构建通过：workflow-final-init-types.log、workflow-final-init-dependencies.log、workflow-delivery-build.log。最终分发包 13 项通过、0 跳过：workflow-distribution-v5.log；测试目录使用当前安装依赖，未重新从网络安装依赖。
- 固定生产代码后的默认集执行 265 文件 / 2399 用例：2316 通过、1 失败、82 条件跳过，无未处理异常（workflow-delivery-default.log）。唯一失败为测试验证 3 秒阶段覆盖时同时设置 2 秒整题限制；将该测试整题预算改为 10 秒，保留独立的整题优先测试。受影响文件 18 项全部通过（workflow-timeouts-final.log），修改仅涉及测试，未再次执行整套默认集。不能把此前失败的全量日志写成一次全绿结果。
- 其他最终专项：模板/CLI 18 项、准备/取消/中止 51 项通过；55 份 Benchmark 配置编译通过。命令行实际执行 workflow list、init --workflow 和 inspect --output 成功，最后一次检查使用显式官方网络配置。
- WSL 真实验证通过：Docker Bundle 只读挂载与删除映射、Ray auto/local、Ray Jobs；两个独立 worker 的执行、离线报告、准备失败零派发，以及集群重启后续跑复用成功结果均通过。各轮日志和先后代码范围见上文。真实浏览器鹈鹕流程 6 项通过，生成 PNG 并交给受控视觉裁判。以上使用受控模型/数据验证执行行为，不代表实际模型质量或 NPU 性能验收。
- 已知环境限制：Ray Client Server 曾出现间歇性启动失败，服务日志已保留；本次测试集群重启后续跑通过。Windows 默认网络配置含不支持的 version 字段，未修改用户文件；运行时可使用有效的 --network 配置，模板生成现在不受该文件影响。
- 支持边界：Node 下限为 24.22.1；旧 YAML/插件注册/SDK 接口需要按指南迁移，旧 manifest 结果使用原版本读取/续跑，不改写历史文件。新工作流要求计划与实现指纹匹配。详见中英文工作流指南的迁移表。
- 临时两节点 Compose 项目已清理；git diff --check 和 84 份修改/新增 Markdown 的相对链接检查通过。所有改动留在当前工作区，未提交、未推送。
