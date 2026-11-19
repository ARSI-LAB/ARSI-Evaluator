# 工作流插件化实施

日期：2026-11-10

类型：feature

状态：进行中，尚未交付。

## 目标和授权

执行[实施设计](../../design/2026-11-10/2026-11-10-workflow-runtime-implementation.md)，用户已授权架构调整及不兼容接口迁移，要求操作保持简单。没有提交或推送授权；不修改旧设计正文，不删除历史结果。禁止将阶段性实现视为完整交付。

## 初始状态

- 基线提交：2816a57。
- 工作区仅存在先前规划生成的未跟踪 docs/design，未发现代码修改。
- 系统 Node 为 24.18.0，仓库要求 >=24.19.0；pnpm 为 11.22.0，与仓库一致。
- 当前工作区尚未安装 node_modules。

## 工作清单

- [x] 安装匹配运行时和锁定依赖，记录基线验证。
- [ ] 实现流程契约、编译与检查、注册和资源生命周期。
- [ ] 实现步骤执行、完成判定、控制结构、结果存储和恢复。
- [ ] 验证 Harbor 多步、记忆状态及双模型配对。
- [ ] 实现简单模板配置及 CLI/SDK 操作。
- [ ] 迁移所有现有评测、仓库插件、准备、补测、报告和 Ray。
- [ ] 删除旧接口/执行路径，迁移 Playbook 和正式文档。
- [ ] 交付三个可运行示例并完成验证。

## 验证记录

- 已用 pnpm install --frozen-lockfile 安装锁定依赖，prepare 构建通过。该次使用系统 Node 24.18.0，有 engine 警告。
- 已下载 Node 24.19.0 到 .scratch/toolchain/node-v24.19.0-win-x64，后续验证通过该 node 直接调用 D:/software/nodejs/node_modules/corepack/dist/pnpm.js（系统 pnpm.ps1 会固定调用旧 Node，不能仅改 PATH）。
- 现有 engine、harbor-multistep、verification-runtime、registry-lifecycle 四文件：99 项测试通过。
- 新 workflow-runtime 集成测试：10 项通过，涵盖输入检查、私有绑定、动态资源、部分失败续跑、产物、超时、迟到释放、清理恢复、状态隔离。
- 新契约、编译器、执行器、Store、注册扩展、基础步骤和模板已多次通过全仓类型检查。

## 已完成的开发与实际状态

- 新增 core/contracts/workflow.ts 与 core/workflow/{values,catalog,compile,resources,execute}.ts。
- 新增 config/workflow-schema.ts，应用层 workflow.ts，文件 Store、基础步骤、model.client 和 application.evaluate 模板。
- Cordis 注册表暂时新增三个接口；原注册和旧执行路径还存在，属于迁移中状态，不能按已完成交付。
- CLI 正在接入新配置的 run/inspect/dry-run；尚未完成 warmup/report/SDK 和旧路径删除。
- 发现并修复了资源创建就绪前暴露、root 评分完成但清理失败后重复执行的问题。
- 已建立 workflow-memory、workflow-compare、workflow-pelican 三个独立 patch 插件和示例 YAML；构建生成产物但不默认加载，避免与显式 patch 重复。
- 原 core/execution 的 engine/run-task/run-attempt-step/attempt-resources 已移到 plugins/workflows/benchmark。现有 runTask 改用通用 executeWorkflow 驱动 prepare/begin/solve/transfer/verify/finish；公开任务、求解结果、验证结果按端口传递。外层来源选择、准备、调度、结果存储仍为 Benchmark 原实现，完整的新配置迁移尚未完成。
- Ray worker 调用位置随文件移动更新，尚未支持通用工作流单元远端派发。

## 待处理的技术问题

- 源码新增 LocalWorkflowStore/read 边界校验；需继续验证原子持久化、并发运行锁和崩溃后的锁恢复。
- plan.sources 已记录插件包和模板身份，纳入指纹。续跑先检查原计划和记录，再写文件；已复用带死进程回收和所有权检查的文件锁。
- 模型资源当前实现 OpenAI-compatible HTTP；还需接入已有网络和模型能力，不能丢失现有 provider 行为。
- executeWorkflow 已拒绝自动重放未声明幂等的 external-write，并保存单元输入摘要，避免错误复用输入已变化的配对结果。尚未实现可替换 Scheduler、集合产物引用、完整持久化一致性检查。
- 部分失败传播与声明的 required 输出仍需增加故障场景验证。

## 下一步

继续把 Benchmark 的来源、准备、调度、指标和报告接入声明式流程；迁移公开配置/接口/结果消费；实现通用 Ray 派发、补测和重新评分。不得将已完成的示例、局部迁移和保留旧路径视为全部完成。

## 第二阶段记录

- 已通过新工作流 16 项测试（runtime 12、application 1、memory 1、comparison 2）；随后 HTTP memory 新增 1 项，通过。
- 双模型评分故障后仅重新调用裁判；一侧模型失败保留 missing-counterpart，并在模型恢复后重新配对评分。已测试。
- 新资源 checkpoint 在外部分配前持久化名称；HTTP 记忆参考协议使用每个 attempt 独立命名空间，两样例并发及删除通过实际本地 HTTP 测试。
- 鹈鹕插件的 2 项测试通过，包括用本机真实 Chrome 渲染 PNG、检查视觉裁判收到图片；生成模型及裁判均受控，不能记为真实模型验收。
- Benchmark 迁移后的 engine/Harbor multistep/verification-runtime/timeout-outcomes 共 109 项通过。
- 修复 step-evidence 中创建 readline 后先 await 文件写入导致错过输入行或结束事件的竞态；将 step-start 写入提前到创建读取器之前。
- 两个旧时序测试调整为从 solve 阶段计时、等待清理开始事件；保证迟到 session 得到未取消的释放信号，而不依赖固定微任务次数。
- 新 SDK run 接入工作流并保留迁移中的旧路径；新增 inspect/warmup、离线 report，SDK 与 workflow-application 合计 21 项通过。
- 新模型资源从每次调用的 runtime.credential 取认证，支持 SDK env 隔离；inspect/warmup/report 不产生模型请求，续跑拒绝配置变化时不会覆盖原 plan.json。
- 该阶段 build 通过，check:dependencies 无违规；第一次默认测试集结束：2207 通过、23 失败、78 跳过，不能记为全量通过。

## 尚未完成的接口与行为

- 新旧配置、注册 API 和两套结果仍共存；当前不能视为完成“不保留旧兼容路径”的目标。
- Benchmark 子步骤虽已使用通用内核，但工厂绑定仍在原 Benchmark 装配中，尚未完成可通过 YAML 替换其步骤及接入外层通用工作流。
- 通用 Scheduler/Ray、任务集合引用、完整 source/data/asset 锁定、补测/重新评分、doctor/init/正式文档和 Playbook 迁移均待完成。
- model.client 目前仅 OpenAI-compatible；现有多 provider/network 行为仍需迁移。
- 浏览器资源正常完成/取消会关闭子进程并删除临时 profile；跨进程中断后的自动恢复尚未实现，不能声明所有资源都可自动恢复。
- warmup 对动态步骤输出依赖只报告 deferred；尚无数据准备步骤的专门预热计划。
- 真实 Docker/Ray/远程模型测试未执行；未经用户授权不提交或推送 Git。

## 第三阶段记录

- 在 `.scratch/baseline-2816a57` 解压原始提交并复用依赖，复现了其中 14 项基线失败：Kernel SDK Windows 路径 11 项、python3 不存在 1 项、Node 内置 fetch 安全回归 2 项。没有修改这些测试或放宽断言。
- 总超时测试原先只给准备和求解合计 50ms，持久化 I/O 会在求解前耗尽预算；调整为 2s，仍检查总超时的 agent_timeout、部分轨迹和清理。其余超时失败正在用较低并发全量复核。
- 新模型资源使用现有 NetworkRuntime 和网络重试，支持每次 SDK 调用独立的代理环境与认证，不再依赖全局 fetch；补充 temperature/maxAttempts 校验。
- inspect --output 导出可直接修改的 YAML，跨目录保留 pathBase 和结果位置；运行测试验证导出配置与展开配置一致。现有 inspect 也支持写入文件，拒绝覆盖。
- 新增资源 sharing 声明；跨样例共用资源必须显式声明安全共享。编译时拒绝 run 资源引用随迭代变化的参数，拒绝不同条件之间未经处理的必需输出引用。
- 修复内层顺序遍历覆盖外层 variant/repetition；增加隔离、条件和嵌套循环测试。新 runtime/application/memory/comparison 合计 19 项通过。
- 新增 benchmark.evaluate 模板和 benchmark.runtime/attempt/操作资源。来源选择、每题显式操作、提交、指标、报告现已由通用内核执行；Benchmark 私有 TaskRef 和验证材料保留在资源内，不交给 solve 输入。
- 新 Benchmark 路径 3 项测试通过：实际 LocalEnvironment 和原 Fixture Solver/Benchmark、展开后插入预处理并删除报告、失败保留无敏感值的证据。该路径目前只支持 local；原 Ray 和旧公开入口仍待迁移，不应宣称完成原能力全部迁移。
- 新 Benchmark 恢复分别记录 runtime 和 attempt 所有权；attempt 释放后如原结果清理未确认则保留 unconfirmed，恢复通过原 Environment/Verifier 的 recoverAttempts 执行。
- 第二次全量测试使用 --maxWorkers=2：2221 通过、14 失败、78 跳过；失败均为已在原始提交复现的 14 项。日志 `.scratch/workflow-validation.log`。这不是最后代码状态的全量验证，之后仍有修改。

## 当前下一步与授权边界

继续完成通用调度、Benchmark 准备/续跑/补测/报告和 Ray，再迁移配置、公开接口、Playbook 和正式文档、删除旧路径。需进一步检查新 Benchmark 生命周期、性能评分、复用原组件工厂代码、崩溃恢复和源锁定。当前代码仍处于迁移中，未经验证的能力不能按完成交付。用户已授权计划内架构调整，不需为这些步骤重复确认；仍未授权 Git 提交或推送。

## 第四阶段记录

- 新模板提供 example 参数；init --workflow 可生成配置，保持已有 --benchmark 入口。doctor 对新配置执行静态流程检查。SDK 返回报告产物路径。
- 新 retryWorkflow/SDK retry/CLI retry --run <目录> 从保存的计划恢复，核对当前插件和模板版本；支持按 caseId 选择失败样例，不重跑成功样例。真实本地 HTTP 测试通过“a 成功、b/c 失败；只重试 b；再重试 c”。不支持运行中的补测请求队列，尚不能替代原 retry-control 能力。
- 迁移 warmupSelectedTasks 到 Benchmark 插件目录，原应用及 Ray 调用方更新路径；Benchmark 新资源调用同一预热实现，不创建评测目录或调用求解。补齐内层顺序预热不覆盖外层 variant/repetition 的行为。
- 原预热和 Ray 预热、新工作流等六文件共 52 项通过；之后新增资源状态修改仍需复核。
- WorkflowStore 读取时检查产物实际摘要、重复记录、时间字段和完成状态，避免将损坏的证据继续用于续跑。复用只看同一单元的最后一次 attempt；上游结果变化会触发后续评分重算。
- 资源记录增加 pending 和 dependencies；依赖尚未创建完成时不调用父资源工厂，恢复按依赖逆序进行，避免先清理依赖资源。相关四文件 21 项测试通过。

## 第五阶段记录

- 删除 EvaluatorRegistry 的 register(role)/prepare/create/entries 等旧组件注册接口；步骤、资源、模板使用同一目录。原 Benchmark 的八类实现改为 native.* 资源，由 Benchmark 目录中的辅助函数绑定工厂参数。仓库组件、外部 aisbench/docops、夹具及调用方同步修改。
- 注册迁移后构建、类型检查、依赖边界通过；插件加载、生命周期、CLI、工作流应用和 Benchmark 五文件 87 项通过。修正 Ray Jobs 源码入口对新资源工具的 dist 相对路径。
- Benchmark 增加 prepare-selection 显式步骤，复用原 planRun、prepareTasks 和 materialize；批量准备等待完成，流水线后台产生准备回执。当前流水线按 case 顺序等待回执，尚未恢复原按就绪顺序占用执行槽和 lookahead 背压，后续通用 Scheduler 要继续处理。
- Benchmark 组件现在由各次 session 创建和逆序释放，不再等整个插件注册表关闭才释放 Solver 等实例。原生指标实例的生命周期和分点报告还需继续完善。
- Benchmark 报告步骤开始调用所选 Reporter；超时由原 finalizeAttemptOutcome 判定，允许有效的 Agent 超时零分提交。新 Benchmark 8 项测试第一次运行 7 通过，批量准备 1 项超过默认 5s；将新文件 I/O 集成场景预算改为 15s，待复核。原 Reporter 的分点报告和相对证据链接还需迁移，不能记为报告行为全部保留。
- 增加 JSONL collection 产物契约、forEach 读取集合，以及 data.cases-jsonl；application.evaluate 可以选择 casesFile，公开请求与私有答案分开。Step.validateResume 只读检查来源，完成后的续跑也拒绝数据变更。类型检查通过，相关集成测试待跑。
- 鹈鹕 SVG 检查改为分别解析 URL 和 href，接受带引号的本地渐变引用，拒绝未加引号的外部地址；测试已补，待复核。
- 当前全量测试会话 75766，日志 .scratch/workflow-validation-latest.log。测试期间上述集合和 SVG 仍有修改，因此该轮结果不是最终全量验收。

## 当前未完成范围

通用 Scheduler/Ray、在线补测控制、重新评分、旧配置/公开入口和结果消费迁移、正式文档及全部 Playbook 仍未完成；原 Benchmark 非默认 variant/repetition 目前明确拒绝，避免错误共用求解器和覆盖原生指标。该限制须继续通过执行身份和组件配置改造解决。仍不提交或推送 Git，继续计划内开发。


## 第六阶段记录

- JSONL 数据集合、来源摘要复核、计划输出端口、results.rescore 已实现。重新评分生成新运行，复用公开文本响应并保留原 case/variant/repetition；受控 HTTP 测试确认不重新请求被测模型、不修改源结果。
- Benchmark 的报告生成和分点报告逻辑已移入插件目录，使用原 Reporter 的报告 bundle。通用报告离线读取已提交指标；Benchmark 报告索引链接到原生证据目录。证据仍使用插件内部 Store，尚未完成通用远端产物传输。
- 运行中补测接入现有 RetryControl 请求事务及 IPC：先持久化请求再入队，同一 requestId 不重复执行，活动样例不被重启。CLI 区分 pending/accepted/rejected，拒绝请求返回非零退出码。
- 新增 workflow list，init --workflow 支持六个模板的初始化与无密钥静态检查；用户可以 inspect --output 导出配置后增删步骤。中文和英文用户指南、步骤/资源开发指南已新增，注册示例已修改。
- 浏览器在启动进程前保存资源目录和运行状态；同机未启动渲染的中断资源可恢复。渲染中进程中断仍需人工确认清理，不会假定残留进程已经退出。
- 新增 WorkflowAdmission 及 forEach.admission。执行槽按需拉取就绪身份，Benchmark 准备回执不再被后台全部取走。测试验证先准备好的 b 可在较慢的 a 前执行，lookahead 保持有效；重复、遗漏身份和忽略取消的 provider 都有失败处理。
- Benchmark 原生 manifest 已记录模型、组件和实现来源，便于报告展示。已修复未完成续跑重复写锁定来源的问题；完成续跑现在也检查原生轨迹摘要。两项回归通过。
- 13:42 构建和 9 文件 79 项测试通过（包含真实 Chrome 渲染；模型服务受控）。之后准备队列、补测回执与取消清理 3 文件 38 项通过。类型检查通过，依赖检查 0 违规。随后构建、续跑与证据校验回归 3 文件 40 项通过。当前代码再次通过 typecheck/check:dependencies；全量验证会话 51630，日志 .scratch/workflow-validation-current.log，待记录结果。
- 上一轮全量测试日志 .scratch/workflow-validation-latest.log 为 2230 通过、16 失败、78 跳过。其中 14 项为已复现的原始基线问题；另 2 项已在聚焦复测中通过。之后仍有代码修改，不能把该轮当成当前验收结果。

## 等待确认与仍未完成的迁移

已向用户询问 Ray 的资源放置规则：推荐新增 worker 作用域，节点各自创建模型客户端，attempt 继续独占记忆和容器，全局共享状态使用服务；备选是 run 资源只有一个实例，相关步骤固定在同一节点。这个选择影响资源共享语义，收到答复前不实现依赖该选择的远端调度代码。真实 Docker/Ray 测试环境也已询问，未获得配置。

通用 Scheduler/Ray、旧配置/公开入口和结果消费迁移、全部 Playbook、Benchmark variant/repetition 与通用证据传输仍未完成。原有 Benchmark/Ray 路径仍在，不能宣称满足“删除旧路径”的最终目标。继续完成独立验证；没有提交或推送 Git。

- 本阶段文档检查覆盖 428 个本地链接；历史提案中 3 个已移动源码链接改为基线提交链接，历史结论正文没有修改。git diff --check 已通过。


## 第七阶段验证与恢复边界

- 修复迟到资源清理在运行已结束后继续写结果的问题：资源记录使用快照，最后一次保存前关闭 writer，迟到资源仍释放，但不再修改已返回对象或覆盖续跑结果。回归验证释放后返回值、保存次数和磁盘记录保持一致，3 文件 40 项通过。
- 13:53 的全量测试为 2247 通过、15 失败、77 跳过（真实 Chrome 已启用）。其中 14 项是原始基线失败，新增迟到清理断言在该轮旧执行器缓存下失败；当前实现已通过聚焦回归。由于运行期间修改了代码，该轮不作为最终全量验收。
- 已重新构建并冻结代码进行全量验证：会话 97854，日志 .scratch/workflow-validation-stable.log。该轮结束前不修改实现；其结果待记录。
- 当前没有实施 worker 作用域或 Ray 放置策略，等待用户答复。下一步按所选策略继续远端调度、产物传输和旧入口迁移，而不是将本地实现视为完整交付。


## 当前验证结果（14:07）

- 冻结生产代码后的全量测试：2247 通过、15 失败、77 跳过，247 文件；日志 .scratch/workflow-validation-stable.log。工作流取消和迟到清理回归在这轮通过。
- 其中 14 项失败与原始提交基线一致：Kernel SDK Windows 路径 11 项、缺少 python3 1 项、Node 内置 fetch 安全回归 2 项。未修改这些断言，未将失败记为通过。
- 另外 1 项是 agentbundle-runtime-files 中 Pi 安装测试超过默认 5 秒。该测试执行完整 SDK 复制及子进程，同文件另外两项已设置 30 秒；现在给漏设的这一项同样设置 30 秒，断言不变。该文件独立复测 3 项通过，日志 .scratch/workflow-runtime-copy-validation.log。没有因此宣称刚才全量测试全部通过。
- 最新生产代码构建通过；typecheck、check:dependencies 和 git diff --check 通过。当前文档 425 个本地链接均存在。
- 真实 Chrome 渲染已在全量中执行；生成和裁判使用受控模型服务。真实 Docker/Ray/远程模型测试未执行，仍待环境验收。
- 实现和任务保持未完成状态，等待 Ray 资源作用域选择；后续仍需远端派发/产物传输、原入口与配置/结果迁移、Playbook 迁移和 Benchmark variant/repetition。用户可先查看中文工作流指南，但当前代码不能作为完整迁移交付。
- 所有改动仍在工作区，未提交、未推送。
