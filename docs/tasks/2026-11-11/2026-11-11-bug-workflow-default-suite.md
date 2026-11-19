# 工作流改造后的默认测试集复验

日期：2026-11-11

类型：bug / 验证

状态：已完成，完整默认测试集通过。

## 目标与范围

继续[前次交付](../2026-11-10/2026-11-10-feature-workflow-bundle-deployment.md)：完整重跑默认测试集，确认阶段超时测试修复后整套通过；若有失败，修复后重新执行完整测试集。逐项核对跳过条件，单独说明未执行原因。

保留现有工作区修改，不提交、不推送；不修改历史任务记录。只处理本次发现的失败和必要的测试问题，不新增架构方案。

## 实施与验收

- 使用 Node.js 24.22.1、pnpm 11.22.0。
- 第一轮执行 `pnpm test --run --reporter=verbose --reporter=json --outputFile.json=.scratch/workflow-default-20261111-01.json`，日志为 `.scratch/workflow-default-20261111-01.log`。
- 不通过命令行覆盖并发数、测试时限或 hook 时限；使用仓库默认配置，报告参数只影响输出。
- 等待整套完成后再修改代码，避免运行中加载不同版本的模块。若修改源代码，按影响范围完成类型检查、构建和回归，再完整重跑。
- 跳过项以本轮 JSON 结果为准，再核对源码中的平台、工具和环境开关条件；此前的 WSL 验证不计作本轮默认集通过。

## 当前进展

第一轮完整默认集：265 文件、2399 用例，2316 通过、1 失败、82 跳过，耗时 356.63 秒。此前的阶段超时覆盖测试通过。

唯一失败是 `cli.test.ts` 的报告历史用例：它串行执行首次失败运行、失败续跑、成功补测、离线报告、成功续跑共五次 CLI 操作，超过默认 5 秒用例预算；提前结束后，afterEach 删除目录与尚未完成的写入冲突，产生 ENOTEMPTY。

修复只为该测试设置 30 秒预算，保留全部报告内容、历史目录和退出码断言；不修改生产代码、业务超时、全局测试时限或并发数。专项复测通过，实际用时 7.515 秒；该次定向运行按名称过滤的 40 项不计入默认集跳过统计。类型检查与 git diff --check 通过。

第二轮以相同默认参数完整执行，日志和 JSON 分别为 `.scratch/workflow-default-20261111-02.log`、`.scratch/workflow-default-20261111-02.json`：2315 通过、2 失败、82 跳过，耗时 375.06 秒。CLI 报告历史与此前的阶段超时覆盖测试均通过。新增发现：

- `task-retry.test.ts` 的继续执行用例需要串行保存四个 attempt，在全套负载下超过默认 5 秒（5066ms），随后清理目录与后台写入冲突。为该文件的重试集成场景设置 30 秒测试预算，保留重试次数、错误分类、清理和结果断言。
- `batch-preparation.test.ts` 的 20 槽补位用例最终存在未完成记录（19809ms），原断言没有输出记录错误。用例主动阻塞任务，分段等待预算合计 20 秒，却继承夹具的 10 秒整题时限，会使调度验证受到业务时限干扰。只为此用例设置 60 秒整题预算，保留测试自身 30 秒预算及验证完成、持久化完成后才能补位的断言；失败时列出具体任务、状态和错误，避免只有布尔值。

上述修改均在测试中；生产超时默认值及全局 Vitest 配置不变。

专项命令 `pnpm test --run tests/integration/batch-preparation.test.ts tests/integration/task-retry.test.ts tests/integration/timeout-outcomes.test.ts --reporter=verbose` 全部通过：3 文件、48 用例，耗时 44.01 秒。20 槽用例用时 16.841 秒，继续执行重试用例用时 2.549 秒。日志为 `.scratch/workflow-retry-admission-20261111.log`。修改后的 `pnpm typecheck` 和 `git diff --check` 均通过。

第三轮完整默认集：2310 通过、7 失败、82 跳过，耗时 544.25 秒。日志和 JSON 分别为 `.scratch/workflow-default-20261111-03.log`、`.scratch/workflow-default-20261111-03.json`。7 项均为 Vitest 用例超时，分别位于 `network-recovery`、`sampling`、`workflow-benchmark`、`workflow-application`、`workflow-offline-report`、`jobs-results`、`jobs-seed`；前两轮这 7 项均通过。本次已修改的 CLI 历史、20 槽补位和重试测试均通过。

第三轮 00:37:09 开始；检查 Windows 进程确认，另一个工作区于 00:38:19 启动了独立完整 Vitest 测试集，与本轮持续重叠。失败项耗时明显上升，例如 100 题测试从前两轮约 116/118 秒变为超过 180 秒，模型分组测试从约 7/6 秒变为超过 20 秒。保留全部失败记录，不停止另一工作区进程，也不据此继续放宽测试时限；等待该进程结束后，保持代码不变，执行第四轮完整默认集以核对负载影响。

第四轮日志和 JSON 分别为 `.scratch/workflow-default-20261111-04.log`、`.scratch/workflow-default-20261111-04.json`：2308 通过、9 失败、82 跳过，耗时 497.10 秒。100 题并发、模型分组、随机采样恢复通过；其他工作区仍有定向测试运行，不能把这一轮描述为完全无外部负载。

9 项失败均为默认 5 秒用例预算超限，部分提前清理产生 ENOTEMPTY；没有新的业务断言错误。继续修复：

- CLI 补测、流程应用运行/续跑、离线报告历史、验证依赖顺序均需多轮真实持久化，相关四个测试文件设置 30 秒用例预算。OfficeQA 的执行/离线报告/续跑组合用例单独设置 30 秒。保留已有较短的显式用例时限，不改变业务截止时间、断言或全局 Vitest 配置。
- Jobs 上传和下载各对 1,200,123 字节 Buffer 使用 `toEqual` 深度比较，改为 `Buffer.equals` 检查完整内容，避免逐元素 JavaScript 比较开销；这两个测试仍保留默认 5 秒预算，文件大小和分块传输场景不变。

专项命令 `pnpm test --run tests/integration/cli.test.ts tests/integration/workflow-application.test.ts tests/integration/workflow-offline-report.test.ts tests/integration/verification-runtime.test.ts tests/integration/jobs-seed.test.ts tests/integration/jobs-results.test.ts tests/integration/officeqa-pro-v2.test.ts --reporter=verbose`：7 文件、84 用例全部通过，耗时 43.20 秒。上传和下载分别用时 387ms、241ms（第四轮为 6614ms、6040ms）；日志为 `.scratch/workflow-io-regression-20261111.log`。再次执行类型检查和差异格式检查，均通过。

第五轮按相同默认配置完整执行，日志和 JSON 分别为 `.scratch/workflow-default-20261111-05.log`、`.scratch/workflow-default-20261111-05.json`：**235 文件通过、30 文件全部跳过；2317 用例通过、0 失败、82 条件跳过（共 2399）**，耗时 359.46 秒，进程退出码 0，JSON 的 success=true。此前的阶段超时覆盖测试及本次发现的所有失败用例均通过。

## 最终验收

- 完整命令：`pnpm test --run --reporter=verbose --reporter=json --outputFile.json=.scratch/workflow-default-20261111-05.json`。没有指定测试文件、名称过滤、并发或超时覆盖参数；使用默认 4 worker。
- 两组专项：48/48、84/84 通过；CLI 报告历史的早期单项复测通过，其名称过滤产生的 40 项跳过不计入默认集统计。
- `pnpm typecheck`、`git diff --check` 通过。本次只修改测试及任务记录，没有修改生产代码，因此未重新执行生产构建。
- 保留原工作区改造；未提交或推送。未新增 skip，也未把此前 WSL/Docker/Ray 验证计作本轮通过。

## 默认集跳过项

最终 JSON 中有 82 项条件跳过，分布于 39 个文件；其中 30 个文件全部跳过，另外 9 个文件仍有其他用例正常执行。没有 todo。逐用例名称及原因保存在 `.scratch/workflow-skipped-20261111-05.json`；源码条件按文件列在下表。

| 类别 | 用例数 | 本轮条件 |
| --- | ---: | --- |
| Docker 实测 | 42 | 对应 opt-in 开关或测试镜像未配置；部分还要求 Linux、非 root 用户或工具。 |
| Windows 平台限制 | 22 | 用例明确排除 Windows，涉及 POSIX Shell、权限、umask 或进程信号。 |
| AgentX | 8 | 未配置 AGENTX_TEST_PYTHON。 |
| APT | 3 | 要求 Linux 且 EVALUATOR_APT_TESTS=1，本轮两项均不满足。 |
| 真实 Harness | 3 | 未配置运行时、镜像和输出目录三项专用变量。 |
| Ray | 3 | 未启用真实 Ray/Jobs 开关；需要专用 Linux 环境。 |
| Chromium | 1 | 未配置 EMBER_TEST_CHROMIUM；其余鹈鹕流程测试已执行。 |

这些测试本轮未执行，不计为通过；下表采用互斥分类，平台条件与 Docker 条件同时存在的用例只计一次。

| 测试文件 | 跳过数 | 本轮未执行原因 |
| --- | ---: | --- |
| [tests/integration/agentbundle-deepagents-docker.test.ts](../../../tests/integration/agentbundle-deepagents-docker.test.ts) | 1 | 未启用 EVALUATOR_TEST_DOCKER=1；运行还要求可用的 uv。 |
| [tests/integration/agentbundle-jiuwenswarm-docker.test.ts](../../../tests/integration/agentbundle-jiuwenswarm-docker.test.ts) | 1 | 未启用 EVALUATOR_TEST_DOCKER=1，且未配置 JIUWENSWARM_CHECKOUT；运行还要求可用的 Linux uv。 |
| [tests/integration/agentx-bridge.test.ts](../../../tests/integration/agentx-bridge.test.ts) | 8 | 未配置 AGENTX_TEST_PYTHON；默认测试不安装真实 AgentX 的 Python 依赖或下载 tokenizer。 |
| [tests/integration/apt-download.test.ts](../../../tests/integration/apt-download.test.ts) | 3 | 要求 Linux 且 EVALUATOR_APT_TESTS=1；本轮为 Windows 且未启用开关。 |
| [tests/integration/checkout-build.test.ts](../../../tests/integration/checkout-build.test.ts) | 3 | Windows 上显式跳过；夹具使用 POSIX 可执行脚本模拟 pnpm 构建。 |
| [tests/integration/dataset-permissions.test.ts](../../../tests/integration/dataset-permissions.test.ts) | 4 | Windows 上显式跳过；验证 POSIX umask、文件/目录权限和可执行位。 |
| [tests/integration/docker-arm64.test.ts](../../../tests/integration/docker-arm64.test.ts) | 2 | 未启用 EVALUATOR_TEST_DOCKER=1。 |
| [tests/integration/docker-base-image.test.ts](../../../tests/integration/docker-base-image.test.ts) | 1 | 未启用 EVALUATOR_TEST_DOCKER=1。 |
| [tests/integration/docker-cpu.test.ts](../../../tests/integration/docker-cpu.test.ts) | 2 | 未启用 EVALUATOR_TEST_DOCKER=1。 |
| [tests/integration/docker-evidence-ownership.test.ts](../../../tests/integration/docker-evidence-ownership.test.ts) | 5 | 要求 EVALUATOR_TEST_DOCKER=1、Linux 和非 root 用户；本轮为 Windows 且未启用开关。 |
| [tests/integration/docker-main-only.test.ts](../../../tests/integration/docker-main-only.test.ts) | 3 | 未启用 EVALUATOR_COMPOSE_DOCKER_TESTS=1。 |
| [tests/integration/docker-node-path-docker.test.ts](../../../tests/integration/docker-node-path-docker.test.ts) | 1 | 未启用 EVALUATOR_COMPOSE_DOCKER_TESTS=1。 |
| [tests/integration/docker-pull-proxy.test.ts](../../../tests/integration/docker-pull-proxy.test.ts) | 1 | 未启用 EVALUATOR_TEST_DOCKER=1。 |
| [tests/integration/docker-runtime-upload.test.ts](../../../tests/integration/docker-runtime-upload.test.ts) | 2 | 要求 Linux 且 EVALUATOR_TEST_DOCKER=1；本轮两项条件均未满足。 |
| [tests/integration/docker-runtime-user.test.ts](../../../tests/integration/docker-runtime-user.test.ts) | 1 | 要求 Linux 且 EVALUATOR_TEST_DOCKER=1；本轮两项条件均未满足。 |
| [tests/integration/docker-solver-permissions.test.ts](../../../tests/integration/docker-solver-permissions.test.ts) | 1 | 未启用 EVALUATOR_TEST_DOCKER=1。 |
| [tests/integration/docops-verification.test.ts](../../../tests/integration/docops-verification.test.ts) | 1 | 未启用 EVALUATOR_TEST_DOCKER=1。 |
| [tests/integration/dsh-docker-tool-outputs.test.ts](../../../tests/integration/dsh-docker-tool-outputs.test.ts) | 2 | 要求 EVALUATOR_TEST_DOCKER=1、Linux 和非 root 用户；本轮为 Windows 且未启用开关。 |
| [tests/integration/harbor-compose-docker.test.ts](../../../tests/integration/harbor-compose-docker.test.ts) | 2 | 未启用 EVALUATOR_COMPOSE_DOCKER_TESTS=1。 |
| [tests/integration/harbor-compose-timeout-docker.test.ts](../../../tests/integration/harbor-compose-timeout-docker.test.ts) | 2 | 未启用 EVALUATOR_COMPOSE_DOCKER_TESTS=1。 |
| [tests/integration/harbor-docker.test.ts](../../../tests/integration/harbor-docker.test.ts) | 4 | 未启用 EVALUATOR_HARBOR_DOCKER_TESTS=1。 |
| [tests/integration/harbor-multistep-docker.test.ts](../../../tests/integration/harbor-multistep-docker.test.ts) | 1 | 未启用 EVALUATOR_HARBOR_DOCKER_TESTS=1。 |
| [tests/integration/humaneval-program.test.ts](../../../tests/integration/humaneval-program.test.ts) | 1 | Windows 上显式跳过 Python 执行时限用例；其余 Python 用例照常执行。 |
| [tests/integration/live-progress-docker.test.ts](../../../tests/integration/live-progress-docker.test.ts) | 1 | 未启用 EVALUATOR_LIVE_PROGRESS_DOCKER_TESTS=1。 |
| [tests/integration/network-allowlist-docker.test.ts](../../../tests/integration/network-allowlist-docker.test.ts) | 1 | 未启用 EVALUATOR_HARBOR_DOCKER_TESTS=1。 |
| [tests/integration/officeqa-docker.test.ts](../../../tests/integration/officeqa-docker.test.ts) | 2 | 未启用 EVALUATOR_OFFICEQA_DOCKER_TESTS=1。 |
| [tests/integration/onboarding.test.ts](../../../tests/integration/onboarding.test.ts) | 1 | Windows 上显式跳过；该 doctor 用例使用 POSIX Python 替身脚本。 |
| [tests/integration/real-harness-task-retry.test.ts](../../../tests/integration/real-harness-task-retry.test.ts) | 3 | 未配置 EVALUATOR_TEST_REAL_HARNESS_RUNTIME、EVALUATOR_TEST_REAL_DSH_IMAGE、EVALUATOR_TEST_REAL_HARNESS_OUTPUT。 |
| [tests/integration/simpleagent.test.ts](../../../tests/integration/simpleagent.test.ts) | 2 | Windows 上显式跳过 Bash 路径与任务 skills 两个用例。 |
| [tests/integration/workflow-bundles-docker.test.ts](../../../tests/integration/workflow-bundles-docker.test.ts) | 1 | 未启用 EVALUATOR_BUNDLE_MOUNT_TESTS=1。 |
| [tests/integration/workflow-jobs-ray.test.ts](../../../tests/integration/workflow-jobs-ray.test.ts) | 1 | 未启用 EVALUATOR_WORKFLOW_JOBS_TESTS=1；要求隔离的 Linux Ray/Docker 环境。 |
| [tests/integration/workflow-pelican.test.ts](../../../tests/integration/workflow-pelican.test.ts) | 1 | 未配置 EMBER_TEST_CHROMIUM，未运行真实浏览器用例；其他鹈鹕流程用例正常执行。 |
| [tests/integration/workflow-ray.test.ts](../../../tests/integration/workflow-ray.test.ts) | 2 | 未启用 EVALUATOR_WORKFLOW_RAY_TESTS=1；要求隔离的 Linux Ray 环境。 |
| [tests/integration/workspace-baseline-symlinks.test.ts](../../../tests/integration/workspace-baseline-symlinks.test.ts) | 1 | 未启用 EVALUATOR_TEST_DOCKER=1。 |
| [tests/integration/workspace-transfer-docker.test.ts](../../../tests/integration/workspace-transfer-docker.test.ts) | 3 | 未配置 EVALUATOR_DOCKER_TEST_IMAGE。 |
| [tests/unit/docker-apt-mirror.test.ts](../../../tests/unit/docker-apt-mirror.test.ts) | 6 | Windows 上显式跳过；用例实际执行 POSIX shell/APT 配置脚本。 |
| [tests/unit/docker-task-build.test.ts](../../../tests/unit/docker-task-build.test.ts) | 2 | Windows 上显式跳过两个文件模式/umask 用例；其他构建用例正常执行。 |
| [tests/unit/hermes-runtime.test.ts](../../../tests/unit/hermes-runtime.test.ts) | 2 | Windows 上显式跳过 POSIX Hermes 安装描述用例；Windows 拒绝安装的用例照常执行。 |
| [tests/unit/kernel-profile-options.test.ts](../../../tests/unit/kernel-profile-options.test.ts) | 1 | Windows 上显式跳过 POSIX replay 进程树取消用例。 |
