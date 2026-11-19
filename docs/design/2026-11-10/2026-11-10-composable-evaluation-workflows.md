# 可组合评测流程设计提案

日期：2026-11-10

状态：待用户确认；本次仅阅读代码和编写方案，未实施架构调整。

## 1. 目标与范围

用户通过配置选择步骤插件、声明输入输出连接和执行顺序。新增一种评测流程时，通常只需新增插件和流程配置，不修改核心执行器。现有评测成为内置流程之一，继续支持当前 Benchmark、Solver、环境、评分、准备队列、补测和报告能力。

覆盖三种新增场景：

- 鹈鹕测试：生成 SVG/HTML、提取文件、渲染、检查作品、多模态评分、汇总。
- 记忆系统：启动服务、按会话写入历史、查询或交互、评分、释放资源。
- AI 应用比较：固定应用和样本，对多个模型分别运行，保存轨迹，再逐项评分或进行成对比较。

“方便接入任何流程”指扩展业务步骤无需修改核心，并不表示任意插件可以无条件互换。插件必须满足声明的数据类型、资源能力、执行位置和恢复要求。

用户提供的[知乎文章](https://zhuanlan.zhihu.com/p/2080037810652947650)读取失败（HTTP 403），未核实文章的特定实现。公开的[原始鹈鹕项目](https://github.com/simonw/pelican-bicycle)使用提示词生成 SVG；[auto-pelican 项目](https://github.com/haowang02/auto-pelican)展示生成 SVG 动画、按时间渲染采样、静态统计和多模态评分的流程。下文将这些作为流程表达能力的例子，不假定与知乎文章完全相同，也不指定所谓通用官方评分标准。

## 2. 当前代码的具体限制

| 位置 | 当前行为 | 对新需求的影响 |
| --- | --- | --- |
| [config.ts](../../../src/core/contracts/config.ts)、[components.ts](../../../src/core/contracts/components.ts) | 配置和运行组件固定包含 Benchmark、Environment、Solver 等字段 | 单纯 HTTP 应用测试或离线评分仍受固定角色组合约束 |
| [create-components.ts](https://github.com/evolving-foundry/ember-evaluator/blob/2816a571b341eb7d4fc4a408aa48d1510a75812a/src/application/plugins/create-components.ts) | 按固定角色创建组件，Verifier 在创建 Benchmark 时传入 | 无法按流程引用创建任意数量的步骤和模型绑定 |
| [engine.ts](https://github.com/evolving-foundry/ember-evaluator/blob/2816a571b341eb7d4fc4a408aa48d1510a75812a/src/core/execution/engine.ts) | 调用 Benchmark 锁定来源、枚举任务、准备依赖，再调度 attempt | 整个 run 仍以 Benchmark 任务为中心 |
| [run-task.ts](https://github.com/evolving-foundry/ember-evaluator/blob/2816a571b341eb7d4fc4a408aa48d1510a75812a/src/core/execution/run-task.ts) | 准备任务、创建求解环境、执行多步循环、归档与保存 | 通用运行保障与现有评测的调用顺序写在一起 |
| [run-attempt-step.ts](https://github.com/evolving-foundry/ember-evaluator/blob/2816a571b341eb7d4fc4a408aa48d1510a75812a/src/core/execution/run-attempt-step.ts) | 固定求解、收集/传输、打开验证环境、验证 | 用户无法直接在任意两个步骤之间插入新的业务步骤 |
| [task.ts](../../../src/core/contracts/task.ts) | PreparedTask 包含 solveEnv、verifyEnv、verification、transfer；PreparedStep 重复这一结构 | 多步能力是多次求解/验证，不是任意步骤组合 |
| [benchmark.ts](../../../src/core/contracts/benchmark.ts) | Benchmark 同时提供来源、任务准备、验证及多步结束判断 | 新流程被迫适配现有整套 Benchmark 契约 |
| [result.ts](../../../src/core/contracts/result.ts) | Phase 是固定枚举，AttemptRecord 以 solve/verdict 为主要字段 | 难以完整表达多个候选模型、多次评分、渲染结果或记忆状态 |

[Benchmark 开发指南](../../development/benchmarks.md#未来记忆评测的接口边界)已说明 prepare 在环境创建前执行，现有接口不能任意新增环境就绪后的阶段。当前多步执行还在核心中处理 workdirFiles 和 bash setup.sh。

值得保留的实现包括 Cordis 注册和生命周期、显式 patch 加载及版本校验、环境与运行时安装、来源摘要、准备队列、证据文件清单、失败与取消处理、补测事务、Ray 调度及离线报告。迁移应复用这些能力，并重新安排调用位置。

## 3. 推荐结构

采用“核心执行器 + 必需运行服务 + 可选能力组件 + 步骤插件 + 声明式流程”。

### 3.1 核心执行器

核心负责读取已校验的流程计划、执行通用控制结构、传递显式输入、记录结果，并管理超时、取消、资源作用域和恢复。不认识 Harbor、鹈鹕、记忆系统等业务名称，不固定要求存在 solve 或 verify。

业务步骤按配置数组顺序执行；输入引用只负责传值，不暗中改变执行顺序。前向引用、越过作用域的引用、缺少输入等错误在启动前拒绝。

首个完整版本支持：

- sequence：有序执行。
- forEach：对样本、模型变体或会话重复执行子流程，设置有界并发。
- when：根据已声明的结果选择分支；分支输出需显式声明，跳过不能伪装为成功。
- 有上限的迭代：用于多轮会话、Harbor 阈值停止和有限次数改进，明确最大轮数、停止条件与状态传递。

这些是核心提供的控制结构，不允许普通插件自行创建绕过调度、记录和取消管理的隐藏子流程。复合流程由模板展开或通过受控子流程接口执行。首期不提供任意 DAG、任意脚本表达式、无限循环或跨机器迁移活跃会话。

### 3.2 必需运行服务与可选组件

所有流程自动获得运行身份、记录存储、调度、取消/超时、资源释放、日志脱敏和产物登记。Store 与 Scheduler 的具体实现仍可替换，并提供默认实现。

Environment、模型客户端、浏览器、记忆客户端、评分器、Metrics、Reporter 按流程实际引用创建。纯 HTTP 评测不需要创建 Docker 环境；读取历史产物评分不需要创建 Solver，也不解析无关模型凭据。

“所有评测加载通用组件”不等于把八类组件全部强制实例化。不可删除的是运行保障，可替换的是保障的实现，可增删的是业务步骤和可选能力。

### 3.3 步骤插件与流程模板

在现有注册表增加 step 角色。步骤负责一项可独立配置的操作，例如 models.generate、artifacts.extract、browser.render、memory.ingest、memory.query、judge.vision、scores.aggregate。

现有 Environment、Solver、Verifier、Store、Scheduler 等角色仍可作为步骤调用的能力组件，不把它们全部改写成同一个 run(context) 接口。现有 Benchmark 接口只服务于内置 benchmark-evaluation 流程及其兼容入口，新流程不要求实现它。

流程模板是可展开、可检查的配置，随插件包注册或由用户直接编写。它不是接管整个运行生命周期的黑盒 Workflow.run()。插件包可以同时注册步骤、现有组件和模板；patch 仍只决定加载哪些模块，不决定步骤执行顺序。

按步骤 id 的模板替换、插入或删除在编译前完成，最终得到唯一展开后的配置；启动前显示并校验最终计划。直接编写完整步骤数组始终可用，避免将扩展能力依赖于复杂模板 patch 语法。

## 4. 插件如何组合而不互相依赖实现

每个步骤定义至少包含：

| 项目 | 作用 |
| --- | --- |
| 插件标识、版本、配置校验 | 定位实现，拒绝错误参数，支持来源记录和版本核对 |
| 输入和输出端口 | 声明数据类型、schema 版本、必需/可选性；外部数据在运行时校验 |
| 能力需求 | 声明模型服务、环境、网络或资源句柄等实际依赖 |
| 执行约束 | 指明可在协调端或 worker 执行，资源能否跨步骤共享 |
| 失败和重试语义 | 声明是否无副作用、可幂等重试、需恢复状态或禁止自动重试 |
| 执行方法 | 只接收绑定的输入、授权能力、signal、记录工具和资源作用域 |

端口采用有版本的协议和明确的校验器。编译器不猜测任意 JSON Schema 之间的语义兼容性；只有相同协议、已声明兼容版本或显式转换步骤才连接。TypeScript 类型不能代替 YAML 配置和插件边界上的运行时校验。

输出分三类：

1. 可序列化数据，如问题、回答、评分和统计值。
2. 产物引用，如 SVG、图片、轨迹和快照，包含内容摘要、媒体类型和存储定位。
3. 活跃资源引用，如浏览器或记忆会话，由执行器在本地资源表中管理；持久化记录不包含对象实例。

不提供供所有插件随意写入的全局 context.data。步骤只能读取配置绑定的输入、返回自己的输出；例如评分步骤可读取生成和渲染两个步骤的输出，而不是只能读取紧邻前一步。

删除 renderer 后，若 visionJudge.image 仍指向其输出，dry-run 报告具体节点和缺失端口。用户可以改接已有图片，或换用只需要 SVG 源码的评分插件。无需依赖该输出的可选步骤可以直接删除。

## 5. 三种流程示例

### 5.1 鹈鹕测试

流程：题目输入 → 生成 SVG/HTML → 提取产物 → 渲染图片/动画帧 → 评分 → 汇总/报告。

下面是拟议语法示意，当前代码尚不支持，插件名也属于拟议名称。省略模型服务、通用 Store/Scheduler 默认配置等内容：

```yaml
workflow:
  steps:
    - id: cases
      uses: data.inline
      config:
        items:
          - id: pelican
            prompt: Generate an SVG of a pelican riding a bicycle

    - id: evaluate
      forEach:
        items: { from: cases.items }
        as: sample
        variants:
          - { id: a, service: candidate-a }
          - { id: b, service: candidate-b }
        concurrency: 2
      steps:
        - id: generate
          uses: models.generate
          inputs:
            prompt: { from: sample.prompt }
            service: { from: variant.service }
        - id: extract
          uses: artifacts.extract-svg
          inputs:
            response: { from: generate.response }
        - id: render
          uses: browser.render
          inputs:
            document: { from: extract.document }
        - id: score
          uses: judge.vision
          inputs:
            image: { from: render.image }
          config:
            service: judge
            rubric: pelican-v1
      outputs:
        score: { from: score.assessment }

    - id: summarize
      uses: scores.aggregate
      inputs:
        results: { from: evaluate.results }
```

forEach 对 items 与 variants 生成稳定的样本/变体组合身份。每个组合在独立 case 作用域执行并保存结果；evaluate.results 在所有组合终止后产生，保留 sampleId、variantId、状态、输出和证据引用。汇总插件必须显式处理失败、缺失评分和有效样本数。

动画版可将 browser.render 换成按固定时间采样的步骤，再接视频/多帧评分。渲染模型生成的 HTML 时，使用受限浏览器环境，默认不访问宿主文件或外网。记录浏览器版本、字体、视口和采样时间，以便解释结果差异。

评分规则、裁判模型和提示词独立版本化；既支持逐图评分，也支持把同一样本的两个作品交给成对裁判。默认不能把渲染截图反馈给生成模型；若增加“观察后修改”，应定义成不同的流程并记录版本。

### 5.2 记忆系统

流程：读取会话材料 → 创建独立记忆命名空间/服务 → 写入历史 → 等待写入完成 → 逐轮查询 → 评分 → 汇总。

- case 可以是一整个会话，不必强制等于一个问题；会话内多轮顺序执行，多个会话可并发。
- 写入和查询通过显式 resource 输入引用同一个会话资源；返回的数据与服务句柄分开。
- 默认按 run/case/variant/attempt 隔离记忆，模型 A、B 的测试状态不互相污染。
- 在不支持快照的情况下，中断后从新命名空间重跑整段会话；不从中间问题继续并假定远端状态仍有效。
- 确实需要跨样本累积学习时，将整个连续会话定义为一个恢复单元；共享写入要求顺序、幂等键和快照/恢复协议，不能只配置一个全局对象。
- 释放资源由作用域退出触发，不依赖用户把 cleanup 写成最后一个普通步骤。

### 5.3 两个模型在同一 AI 应用中的比较

流程：锁定测试样本和应用版本 → 对每个模型运行同一应用 → 保存响应、应用状态及轨迹 → 按样本配对 → 评分 → 汇总。

将模型作为变体输入，将应用当作被测对象。应用步骤可以调用 HTTP 服务、SDK 或 CLI，不要求伪装成 Agent Benchmark。记录应用版本、模型绑定、提示词、工具/记忆配置和预算，重复运行次数也进入组合身份。

独立运行后再按 sampleId 配对，允许某个模型失败时保留另一侧结果；不把缺失侧当零分或获胜。成对评分可配置匿名化、交换展示顺序及重复裁判；这些属于评分流程，不写入核心。

## 6. 执行状态、资源、失败和恢复

### 6.1 执行和资源作用域

作用域包括 run、case/episode 和内部步骤/迭代。步骤的资源可以由 case 持有，供后续步骤使用；scope 关闭时逆序释放，失败和取消也执行。共享连接可属于 run，带评测状态的会话默认属于 case。

资源创建后立即登记释放动作，不能等步骤成功返回后才登记。取消后停止接纳后续步骤，等待在途工作终止，再收集可用证据并释放；清理使用独立且有上限的时间预算。清理失败与业务失败分别记录，禁止把未确认释放的状态视为可安全重试。

同进程第三方插件属于受信代码，能力参数不会构成恶意插件沙箱。被测 Agent/生成代码使用环境边界隔离；私有答案、裁判凭据和未来轮次材料不传给公开求解输入。类型标签不能取代文件、进程及网络隔离。

### 6.2 结果协议

为流程运行引入显式格式版本，具体字段在实施前的契约评审中冻结。通用记录至少包含：

- workflow 版本/展开计划摘要、插件与输入来源摘要。
- run、case、variant、attempt、节点路径与迭代编号。
- 步骤状态、时间、输入输出引用、错误、用量、证据文件和清理状态。
- 分别记录业务评分与执行状态；没有评分时明确表示未评分，不能补零或伪造通过。

评分作为有版本的 Assessment 输出，支持多个维度、单位、方向、裁判信息和证据引用；多个模型输出分别保留。核心不再要求所有输出是 SolveResult/VerifyResult，也不要求新增步骤必须加入固定 Phase 枚举。CLI 用节点路径显示执行进度，可另保留通用的诊断类别。

现有 benchmark-evaluation 的规则负责生成与旧语义一致的 solve、verdict、evaluationKind 和结果展示；包括 Agent 超时有效零分、性能证据不冒充质量分数等规则，不推广成所有流程的默认判断。

### 6.3 重试和断点

首期以 case/episode 为恢复单元，保存步骤记录用于诊断，不将“记录了输出”误认为“可以从下一步恢复”。无状态且输出已可靠保存的子流程可以后续增加检查点恢复。

有副作用的步骤默认不自动重试。需要幂等键、服务状态核验或完整快照才能开启；不能保证外部服务 exactly-once。崩溃发生在外部写入成功、日志尚未提交之间时，状态标记为不确定，按协议核验或重建。

流程顺序、配置、输入、相关插件版本和评分规则参与兼容检查。更改评分时建议创建引用旧产物的新评分运行，保留原始评分；不修改历史结果。更改流程后的恢复必须有显式兼容策略，否则开启新 run。

### 6.4 Ray 和准备队列

首期保持一个有状态 case/episode 在同一 worker 内执行。传输已编译的子流程、绑定配置及产物引用，不传 JS 闭包、对象句柄或协调端绝对路径。worker 继续校验本地插件版本、patch 摘要与准备凭证。

泛化 Scheduler 的任务载荷与返回值；BenchmarkRunPlan 不再是所有任务调度的前提。准备队列仍在执行前物化依赖，区分“依赖已就绪”与“活跃服务已启动”，不能在共享镜像准备时写入某个 case 的记忆状态。

跨机器迁移活跃会话不在首期范围；无快照的 case 在 worker 丢失后从头重新执行。保留现有 attempt 分配、上传确认与过期结果隔离，避免重试后旧 worker 覆盖新结果。

## 7. 当前代码的迁移安排

| 模块 | 拟修改内容 |
| --- | --- |
| core/contracts | 新增 workflow、step、端口/产物引用和作用域契约；修改运行/调度/结果契约以表达通用 case |
| core/workflow（新增） | 实现计划校验、顺序/循环/分支执行和输入绑定；不导入具体业务插件 |
| core/execution | 将通用 deadline、取消、资源、attempt 记录能力提取给流程执行器；最终移除固定业务调用链 |
| core/preparation、recovery、results、progress | 保留成熟行为，调整为按计划、case 和节点身份工作；Benchmark 专属判断迁入内置流程 |
| application/plugins | 继续使用 Cordis 和 patch；增加步骤/模板注册，按引用创建组件，按步骤绑定模型服务 |
| config | 支持流程配置、引用和模板展开；结构校验仍不导入或执行插件，由 application 提供已注册声明 |
| plugins/steps、plugins/workflows（新增） | 放通用业务步骤和内置流程模板；旧 Benchmark 方法通过明确桥接步骤调用 |
| plugins/benchmarks 等现有目录 | 保留题目协议、求解器、环境、验证器；不重复实现其业务代码 |
| application/run、report、retry、warmup、ray | 改用流程入口和通用结果；按计划进行预热，离线只创建报告/评分实际需要的组件 |
| src/index.ts 与依赖检查脚本 | 明确导出新契约，更新规则和外部 API 迁移说明；不靠新增内部旧别名维持两套执行器 |

已有 benchmark-evaluation 流程应展开为可见的来源、选题、准备、环境、求解、产物、验证和汇总步骤。共享/独立验证环境、私有验证运行时和多步停止策略使用复合子流程表达。不能仅新增一个步骤后把整个旧 Engine 包进去并作为最终方案。

允许在迁移阶段短暂保留旧执行器用于行为对照；完成迁移后删除旧业务编排。旧 YAML 转换入口可以保留，因为它属于已有用户契约：只转换为新的内置流程，执行路径只有一套。当前八类插件的公开接口通过内置流程继续支持；内部调用方直接改用新接口。

历史结果保留版本化读取与离线报告，原文件不回写。跨执行版本的未完成旧 run 不承诺透明续跑；不兼容时明确拒绝并说明使用旧版本续跑或新建 run。必须在发布前列出支持矩阵，不能把“当前流程继续可运行”等同于“所有历史中断现场都可恢复”。

## 8. 分阶段实施和验收

以下是确认架构后的建议实施顺序，不表示已经开始开发。启动实施时新建当日 task 文档，不修改本设计的交付后正文。

| 阶段 | 工作 | 完成条件 |
| --- | --- | --- |
| 1. 冻结契约与配置样例 | 确定步骤端口、计划格式、case 身份、资源和结果协议，以及公开 API/旧配置/旧结果支持矩阵 | 四种流程（当前、鹈鹕、记忆、应用比较）都能用同一套契约表达；确认外部契约影响 |
| 2. 跑通本地流程 | 实现注册、编译、顺序执行、作用域、forEach、记录及必要分支/有限迭代 | 无 Benchmark/Environment/Solver 的纯数据流程可运行；无效引用在资源分配前拒绝；取消和失败能收尾 |
| 3. 迁移现有评测 | 用步骤调用旧组件，迁移 Harbor 单步/多步、独立/共享验证、准备队列和评分规则 | 现有正常、失败、超时、取消、证据、报告与恢复测试保持其业务语义；删除重复执行路径 |
| 4. 完成三个新场景 | 提供鹈鹕、记忆和 AI 应用双模型比较的插件与配置 | 新场景不修改核心；可以替换渲染器/裁判，删除无依赖的步骤，完成独立复评分 |
| 5. 远端与恢复验收 | 调整 Ray worker、上传、补测、预热与旧结果读取 | 节点丢失、重复上传、插件版本不符、过期 attempt、清理失败均有明确行为；真实 Docker/Ray 验收通过 |

阶段 2 的本地结果是开发里程碑，不代表完成“保留现有能力”的最终验收；后续迁移不能只验证一个简单 Solver。

重点复用并更新现有测试：engine、resume、task-retry、retry-control、registry-lifecycle、harbor-lifecycle、harbor-multistep、verification-runtime、agentx-reports 及相关 Ray 测试。增加保护实际新增行为的流程测试：删除依赖步骤、端口不兼容、条件跳过、部分失败、状态隔离、副作用重试、资源创建中途失败、离线评分不加载生成器凭据。

实现后运行 pnpm check:dependencies、pnpm typecheck、pnpm build、pnpm test --run。Docker、Ray、真实模型和记忆服务单独记录环境与结果，未执行不得记为通过。

本次验证仅包括阅读源码与测试、核对现有约束、检查本设计格式与相对链接。未运行测试、未构建、未调用模型或启动服务，未提交 Git。

## 9. 备选方案与需要确认的决策

| 方案 | 收益 | 限制与代价 |
| --- | --- | --- |
| 在当前 Engine 添加生命周期 hook | 改动较小，可以插入固定阶段的操作 | 主流程仍固定；新场景不断新增 hook，无法满足完整目标 |
| 每个 Workflow 插件接管整次执行 | 插件作者可以任意写流程 | 插件需要重复实现调度、记录、恢复和释放；用户难以用配置组合内部步骤 |
| 步骤插件 + 声明式流程 + 核心运行保障（推荐） | 用户可按数据契约组合步骤；当前流程和新流程共用运行保障 | 涉及核心执行、配置、结果、Scheduler 和 Ray，迁移成本较高 |

推荐确认的架构范围：增加步骤与流程契约；将当前固定业务顺序移入内置 benchmark-evaluation；按流程引用装配组件；引入可表达多个步骤/模型/评分的结果协议；保留明确的旧配置和旧结果边界，最终只维护一个执行器。

这是核心数据流、模块职责与持久化协议的调整。依照用户 AGENTS.md 中“架构调整必须先说明方案并征得我的明确同意”，需要用户批准后才能实施。尚未确定的具体字段和破坏性公开 API 变更必须在阶段 1 列明，不能将本提案的批准解释为无限扩大改造范围的授权。
