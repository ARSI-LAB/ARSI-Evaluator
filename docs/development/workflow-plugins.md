# 工作流插件开发

用户操作见[自定义评测流程](../users/workflows.zh-CN.md)。公共接口从 `arsi-evaluator` 包根导入。插件加载仍使用 Cordis 和显式 patch，导入和注册阶段不能启动评测工作。

## 三个注册入口

- `ctx.evaluator.registerStep(definition)`：声明步骤的输入、输出、资源要求和执行函数。
- `ctx.evaluator.registerResource(provider)`：声明模型客户端、会话、浏览器、记忆服务等资源的创建和释放。
- `ctx.evaluator.registerWorkflow(template)`：把简洁参数展开成可编辑的声明式流程。`example` 提供 `init --workflow` 的初始参数。

现有 Benchmark 的 Solver、Environment、Verifier、Metrics 等实现通过包根的 `registerNativeResource(ctx, role, name, validate, factory)` 注册成 `native.<role>.<name>` 资源。它是 Benchmark 组件的装配工具；通用工作流不要求实现这八类接口。原 `ctx.evaluator.register(role, ...)` 接口已删除。

```ts
import type { Context } from "@deepseek-ai/cordis";
import { jsonPort, textPort, workflowObject } from "arsi-evaluator";

export const inject = ["evaluator"];

export function apply(ctx: Context) {
  ctx.evaluator.registerStep({
    type: "example.normalize",
    version: "1",
    apiVersion: 1,
    effects: "pure",
    inputs: { text: textPort() },
    outputs: { request: jsonPort("arsi.application-request/v1") },
    resources: {},
    validateConfig(value) {
      const config = workflowObject(value);
      if (Object.keys(config).length) throw new TypeError("No configuration fields are accepted");
      return config;
    },
    async execute(inputs) {
      return { request: { prompt: String(inputs.text).trim() } };
    },
  });
}
```

## 数据和步骤边界

步骤只读取 `inputs` 中显式绑定的数据、自己的 `config`，以及 `context.resource(name)` 声明过的资源。返回值必须是可序列化 JSON；不能返回进程、模型客户端或内存会话。端口声明 `protocol` 和校验函数，私有答案、测试和裁判材料声明 `visibility: "private"`。编译器拒绝私有输出流向公开输入。

协议不匹配时增加转换步骤。可选或有条件的输出，需要消费者使用可选输入或相同条件。删除步骤时编译器会指出后续失效引用。内核不会靠全局可变字典猜测前一步产生了什么。

数值评分建议使用 `scoreSetPort()`，每项包含 `subject`、`metric`、`value`、`valid`、`unit`、`direction`、`scorer`、`evidence`。无效评分使用 `value: null`，不能自动当作零分。同一指标的单位、方向和评分器不同，汇总步骤会拒绝混算。

`collectionPort()` 表示 JSONL 集合产物及行数，`forEach` 可直接读取。使用 `context.artifacts.write/read` 保存和读取产物；读取时检查内容摘要。`StepDefinition.validateResume` 适用于数据文件等来源校验，在已完成 run 的续跑中也调用，只能读取，不分配评测资源或写产物。

## 资源生命周期

资源配置使用常量或前序输出引用，首次使用时创建；同一作用域内同一绑定只创建一次。支持 `run`、`worker`、`attempt`、`block`、`step`。有状态资源通常使用 `attempt`；需要跨独立样例共享时，提供者必须声明 `sharing: "shared"`，并负责并发安全。`run` 和 `worker` 资源不能使用随迭代变化的参数。`worker` 资源在独立样例之外声明，由当前执行 worker 创建和释放；不同 worker 不共享进程内对象。

提供者通过 `resources` 声明依赖的 capability，不能依赖生命周期更短的资源。工厂返回 `{ value, identity, dispose }`；`value` 是运行中的实例，`identity` 是不含认证的恢复信息。分配外部命名空间、目录或会话前，先调用 `context.checkpoint(identity)` 保存所有权。

释放使用独立超时和未取消的 signal，并按依赖逆序进行。取消后迟到的工厂结果仍须释放。`recover(identity, context)` 确认上次中断的资源已清理；不能确认时保留失败，不能假装清理完成。`validateResume` 可核对资源依赖的来源和运行时身份；`warmup` 只准备依赖，不能调用被测模型或开始评测。

`effects: "external-write"` 的步骤默认不能自动重放。只有插件保证写入幂等且能核对外部状态，才声明 `replay: "safe"`。重试以整个失败执行单元的新 attempt 为单位，不从任意中间步骤继续。

## 模板、检查与测试

模板的 `expand(parameters)` 必须只做校验和配置展开，不下载数据、启动进程或读取模型密钥。`inspect` 编译计划；`--dry-run` 编译后调用资源的 `preview` 维护操作，读取来源但不执行评测。模板可声明 `overrideParameters(parameters, overrides)`，在环境变量展开前处理快捷参数；传入参数不包含认证值。未声明覆盖函数的模板明确拒绝快捷覆盖。将认证环境变量名写进资源参数，通过 `ResourceProvider.credentials(config)` 声明名称，运行时用 `await context.runtime.credential(name)` 获取值。声明函数不读取凭据值、不执行 I/O。

Ray 根据已锁定的字面量、工作流输入和模型矩阵解析凭据声明。题目内容或步骤输出不能扩大允许读取的名称。节点已有认证优先，缺少时通过 HTTPS 按需读取；未声明的名称被拒绝。清理恢复沿用原派发允许的名称，再次解析值。凭据值不得放入资源 identity、步骤输出或产物，运行时读取到的值会加入日志和错误脱敏集合。

至少验证：插入与删除步骤后的引用、私有数据边界、不同样例状态隔离、失败/取消释放、续跑不重复成功样例，以及外部资源的恢复行为。外部插件需先编译再由 patch 加载；工作节点应部署相同插件版本，不能使用协调端的本机文件路径。

源码入口：`core/contracts/workflow.ts` 定义契约，`core/workflow` 编译和执行，`application/workflow.ts` 装配配置与注册表，`plugins/stores/workflow-local.ts` 保存记录和产物。Benchmark 的执行细节位于 `plugins/workflows/benchmark`。通用内核不按 Benchmark 名称或类别增加条件分支。

## 准备队列与执行顺序

独立样例的 `forEach.admission` 可引用声明 `workflow.admission/v1` 的资源。资源实现 `WorkflowAdmission.order(units, signal)`，按就绪顺序产生执行身份；每个身份必须恰好出现一次。内核只在执行槽空闲时拉取下一个身份，保留上游准备队列的 lookahead 限制。重复、遗漏或未知身份会导致流程失败。该接口不改变步骤顺序，也不能用于有状态的顺序遍历。

`benchmark.evaluate` 的默认配置已经连接这项能力。自定义流程移除 admission 后按输入顺序执行；保留它可以让先完成准备的样例先运行。

## 远端执行

独立样例的 `forEach.executor` 可引用提供 `workflow.executor/v1` 的资源。`WorkflowUnitExecutor.recoveryIdentity()` 返回不含认证的恢复信息；内核先保存派发回执，再调用 `execute(request, host)`。请求包含锁定计划、JSON 绑定和执行身份，不包含资源句柄。后端通过 `host.store` 提交检查点和产物。

`executeWorkflowUnit()` 执行指定独立样例，保留同一套步骤、超时和资源释放逻辑。编译及 worker 执行时都拒绝引用协调端 run/block 资源。工作节点的 `worker`、`attempt` 等资源由节点重新创建；`context.workerId` 可用于日志定位。

内置 `ray.connection` 持有 Ray 驱动和认证 HTTPS 通道；`executor.ray` 通过 `resources.connection` 借用它。Benchmark 准备器借用相同连接，执行器按准备回执选择节点，`benchmark.ray-executor` 将已验证的远端产物导入原生 Store。节点配置增加 `workflowWorkerEntry`，指向安装包的 `dist/application/ray/workflow-worker.js`。`pluginPatchPath` 和相对路径基础目录使用节点本地配置；模型认证优先使用节点配置，缺少时按资源声明经 HTTPS 获取；包摘要、插件与模板版本必须匹配。Ray 消息只发送路由身份，完整计划经 HTTPS 获取。

节点在分配资源前保存本地日志。取消和心跳丢失会取消执行并尝试释放资源；清理未确认的派发须由原节点恢复，不能直接重跑。节点恢复锁与恢复标记会阻止同一旧 attempt 迟到后再次分配资源。后端短期使用每次派发一个 Node 进程，因此 worker 资源只在该进程内复用。

控制消息限制为 2 MiB，产物按 512 KiB 分块传输，单个产物限制为 256 MiB。传输检查产物摘要；断线重试不重复创建产物。大型输入应使用集合产物，而不是在计划中展开全部样例。

### 补测输入与派发校验

就绪资源可实现 `WorkflowAdmission.reuseInputs(unit)`，返回决定成功样例是否可复用的稳定业务输入。必须包含题目内容或引用、模型/应用配置和锁定来源等影响结果的数据；准备轮次、节点放置和临时产物 ID 不属于业务输入。未实现时保留完整输入比较。

内核把该声明与样例、variant、repetition 一起计算业务输入指纹。`WorkflowUnitRequest.dispatchFingerprint` 另外保护完整传输绑定与业务指纹；节点还检查计划、插件版本和路由身份。声明稳定业务输入不能用来绕过来源校验或允许复用不同题目的结果。

### 网络资源与预热依赖

需要网络访问的资源声明 `resources.network: { capability: "network.access/v1" }`。应用层为未绑定的端口配置 `network.runtime`；显式绑定可选择不同代理或下载源。配置中的 `template` 保存未展开变量，资源通过 `runtime.credential(name)` 在执行节点解析，创建并释放网络客户端。使用者借用客户端，不调用其 `dispose`。

资源提供者的 `availableDuringMaintenance: true` 只适用于无评测状态的依赖客户端。预热为声明的依赖创建实例，在结束、异常和取消后逆序释放；模型调用、容器或记忆会话不能使用此标记提前分配。预热去重包含资源配置及依赖配置，使用不同网络的两个资源分别准备。依赖前序步骤输出时返回 `deferred`。

## 进度事件

插件调用 `context.log(message, progress?)` 发布诊断。可选的 `progress` 使用包根导出的 `ProgressEvent`，包含任务阶段、任务/attempt 身份、结构化 failure 或实时工具预览。内核对文本、嵌套错误和预览做认证脱敏，再交给 CLI、SDK 或远端通道。

实时输出必须标记 `transient: true`，通过 `live` 描述操作状态与有限预览行，不作为评测证据保存。正式诊断可进入 Ray Jobs 驱动日志；预览只通过内存进度通道传递。Ray 校验事件与派发身份一致，不允许节点发布其他题目的进度。日志观察回调抛错时 SDK 会取消工作并释放资源。

## 离线报告

步骤可声明 `report.rebuild(config, context)`，返回 Markdown 字符串或 `{ markdown, files }`；`files` 是相对文件名到 UTF-8 内容的映射，用于逐题报告和指标等附件，禁止绝对路径和目录穿越。报告快照同时保存附件并调整相对链接；`report.dependencies(config)` 列出仅用于报告渲染的资源提供者名称。它们用于记录来源、加载模块和校验版本，不会自动创建评测资源。上下文提供已保存的运行记录、只读产物、运行目录和进度回调，不提供认证解析或 `resource()`。

资源释放后，应用层调用报告接口生成运行目录中的 `report.md`。成功的步骤报告可以通过 `context.reuse` 复用；同次运行已经失败的 Reporter 不会自动再次调用。显式 `report` 命令允许重建失败报告，只加载所选报告模块及其声明的依赖。`workflow-reporting.json` 保存本机插件位置，不作为 Ray 节点派发参数或续跑上传内容。

显式续跑在 `reports/` 保存历史报告；补测和离线重建更新当前报告。报告出错写入 `report-errors.json`，已提交的评测结果仍然保留。没有离线报告接口时生成通用摘要。

## 维护操作

资源提供者通过 `maintenance` 声明操作，每项提供 `resources`（所需依赖端口）、可选 `credentials(config)`（该操作使用的凭据名称）、`validateRequest` 和 `execute(config, request, context)`。返回 `{status: "passed" | "failed" | "incomplete", output: {...}}`。操作只借用自己列出的依赖；这些提供者还必须声明 `availableDuringMaintenance: true`。避免把容器、记忆会话等评测状态标成维护客户端。

`doctor` 与 `cleanup-images` 由 Benchmark 运行资源声明。CLI 把用户命令转为请求，`application/workflow-maintenance.ts` 遍历静态配置；不能解析的步骤输出返回 `deferred`，缺少该操作返回 `not-required`。预热使用同一遍历器调用 `warmup` 钩子。钩子可返回维护结果 `{ status, output, summary?, details? }`，不返回值表示准备成功。`summary` 是简短说明，`details` 是逐项失败原因；应用层脱敏后通过 Jobs 传输，CLI 直接展示，失败或未完成返回退出码 1。检查、清理均不执行步骤，不能读写评测产物。依赖在成功、失败和取消后逆序释放。

Ray Jobs 的 `maintenance` 提交携带操作名和参数，不接受运行或恢复 ID。协调端重新编译计划、校验插件版本并调用同一维护执行器。凭据继续按资源声明通过内存通道读取，结果和日志脱敏。

原生组件的 `configTransport.secretFields` 声明支持 `{credential: "ENV_NAME"}`。计划及派发参数保存引用，工厂创建前异步读取值，不能把解析后的认证回填进配置。Ray 只允许传递已安装插件声明的字段引用。

## 自动重试策略

独立单元的 `forEach.retry` 可声明 `{policy: "retryResource", maxAttempts: 3}`。资源提供 `workflow.retry/v1` 能力，其值实现 `shouldRetry({caseId, variantId, repetition, attemptId, ordinal, errors}, signal)` 并返回布尔值。未配置 retry 的流程不自动重试。配置、导出、Ray 派发均保留策略资源与次数上限。

内核只在失败且 attempt 清理确认后调用策略，并重新执行整个单元。次数包含首次执行，按持久化 ordinal 计算；手动补测不重置自动额度。取消、未确认清理、成功后清理失败都不重新评测；外部写入仍须声明可安全重放。Benchmark 模板默认使用其运行资源的流式中断判定，最多执行 3 次。


`workflow.admission/v1` 资源可提供 `failureSignal`，在后台准备失败时中止当前执行块。内核会停止派发、取消占用中的执行槽并释放资源，将原因记为失败。不要在正常准备完成时中止这个信号，也不要用它代替用户取消信号。


执行器可声明 `prepare(request, context)`，返回完整 `bindings` 和可选 `nodeId`，用于重试前刷新准备回执。内核随后重新计算派发摘要、校验题目身份并保存恢复信息。该方法必须响应 signal，并在返回前等待自己的准备/取消操作结束；业务输入指纹不变。Benchmark 模板通过 `benchmark.ray-executor.config.selectionBinding` 指定需要替换的回执绑定，常规模板使用 `prepare.outputs.selection`。


## 本机配置来源

`context.runtime.origins` 是可选的本进程诊断信息，包含 `configurationFile`、`patchFile` 和按资源名记录的 `resourceFiles`。资源创建时可通过 `context.binding` 读取自己的绑定名。仅用于展示配置位置和生成修复命令，不应写入步骤输出、恢复身份或远端请求。

Jobs 和直接调用内核时可能没有来源信息。插件应提供字段说明或提示使用提交端原命令，不能把内部模板标签当作文件名，也不能推测实验名。配置路径解析始终使用 `runtime.resolvePath()`。
