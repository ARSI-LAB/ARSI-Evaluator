# 工作流重构合入 11 月 19 日 master

以 `0481ba6` 为基线，处理工作流入口与上游 CLI 扩展、网络诊断、多模态输入和超时评分的冲突。保留上游 `arsi-evaluator` 包名，并将可选流程插件加入构建目录。

Benchmark 在协调端创建结果 Store 后安装用户选定的包装器。续跑和补测读取原计划的插件配置。Ray Jobs 在协调端恢复插件，执行节点加载对应版本。通用工作流收到 Benchmark Store 包装器会在运行前报错。

## 验证结果

- Windows 使用 Node.js 24.22.1、pnpm 11.22.0。依赖边界检查、类型检查、构建通过。
- 默认测试集执行 2,737 项，2,614 项通过，123 项按测试声明跳过，0 项失败。
- WSL 另行通过 6 项 Kernel 工作流测试、11 项插件扩展测试，以及 1 项使用真实 Docker Compose 验证 bundle 只读挂载与移除的测试。本次没有重新执行真实 Ray 集群用例。

## 默认测试集中跳过的用例

| 测试文件 | 跳过数 | 跳过条件或本次验证情况 |
| --- | ---: | --- |
| [agentbundle-deepagents-docker.test.ts](../../../tests/integration/agentbundle-deepagents-docker.test.ts) | 1 | 未启用 EVALUATOR_TEST_DOCKER=1；运行还要求可用的 uv。 |
| [agentbundle-jiuwenswarm-docker.test.ts](../../../tests/integration/agentbundle-jiuwenswarm-docker.test.ts) | 1 | 未启用 EVALUATOR_TEST_DOCKER=1，且未配置 JIUWENSWARM_CHECKOUT；运行还要求可用的 Linux uv。 |
| [agentx-bridge.test.ts](../../../tests/integration/agentx-bridge.test.ts) | 8 | 未配置 AGENTX_TEST_PYTHON；默认测试不安装真实 AgentX 的 Python 依赖或下载 tokenizer。 |
| [apt-download.test.ts](../../../tests/integration/apt-download.test.ts) | 3 | 要求 Linux 且 EVALUATOR_APT_TESTS=1；本轮为 Windows 且未启用开关。 |
| [checkout-build.test.ts](../../../tests/integration/checkout-build.test.ts) | 3 | Windows 上显式跳过；夹具使用 POSIX 可执行脚本模拟 pnpm 构建。 |
| [claudecode.test.ts](../../../tests/integration/claudecode.test.ts) | 2 | 本地及 Docker 实测需设置 `EVALUATOR_CLAUDECODE_TEST`。 |
| [cli-attachments.test.ts](../../../tests/integration/cli-attachments.test.ts) | 8 | 未设置 `EVALUATOR_CLI_ATTACHMENTS_TEST` 选择真实 CLI。 |
| [codebuddy.test.ts](../../../tests/integration/codebuddy.test.ts) | 2 | 本地及 Docker 实测需设置 `EVALUATOR_CODEBUDDY_TEST`。 |
| [codex.test.ts](../../../tests/integration/codex.test.ts) | 2 | 本地及 Docker 实测需设置 `EVALUATOR_CODEX_TEST`。 |
| [dataset-permissions.test.ts](../../../tests/integration/dataset-permissions.test.ts) | 4 | Windows 上显式跳过；验证 POSIX umask、文件/目录权限和可执行位。 |
| [docker-apt-mirror.test.ts](../../../tests/unit/docker-apt-mirror.test.ts) | 6 | Windows 上显式跳过；用例实际执行 POSIX shell/APT 配置脚本。 |
| [docker-arm64.test.ts](../../../tests/integration/docker-arm64.test.ts) | 2 | 未启用 EVALUATOR_TEST_DOCKER=1。 |
| [docker-base-image.test.ts](../../../tests/integration/docker-base-image.test.ts) | 1 | 未启用 EVALUATOR_TEST_DOCKER=1。 |
| [docker-cpu.test.ts](../../../tests/integration/docker-cpu.test.ts) | 2 | 未启用 EVALUATOR_TEST_DOCKER=1。 |
| [docker-evidence-ownership.test.ts](../../../tests/integration/docker-evidence-ownership.test.ts) | 6 | 要求 EVALUATOR_TEST_DOCKER=1、Linux 和非 root 用户；本轮为 Windows 且未启用开关。 |
| [docker-main-only.test.ts](../../../tests/integration/docker-main-only.test.ts) | 3 | 未启用 EVALUATOR_COMPOSE_DOCKER_TESTS=1。 |
| [docker-node-path-docker.test.ts](../../../tests/integration/docker-node-path-docker.test.ts) | 1 | 未启用 EVALUATOR_COMPOSE_DOCKER_TESTS=1。 |
| [docker-pull-proxy.test.ts](../../../tests/integration/docker-pull-proxy.test.ts) | 1 | 未启用 EVALUATOR_TEST_DOCKER=1。 |
| [docker-retained-images.test.ts](../../../tests/integration/docker-retained-images.test.ts) | 1 | 未启用 `EVALUATOR_RETAINED_IMAGES_TEST=1`。 |
| [docker-runtime-ca.test.ts](../../../tests/integration/docker-runtime-ca.test.ts) | 1 | 未启用 `EVALUATOR_TEST_DOCKER=1`。 |
| [docker-runtime-upload.test.ts](../../../tests/integration/docker-runtime-upload.test.ts) | 2 | 要求 Linux 且 EVALUATOR_TEST_DOCKER=1；本轮两项条件均未满足。 |
| [docker-runtime-user.test.ts](../../../tests/integration/docker-runtime-user.test.ts) | 1 | 要求 Linux 且 EVALUATOR_TEST_DOCKER=1；本轮两项条件均未满足。 |
| [docker-solver-permissions.test.ts](../../../tests/integration/docker-solver-permissions.test.ts) | 1 | 未启用 EVALUATOR_TEST_DOCKER=1。 |
| [docker-task-archive.test.ts](../../../tests/integration/docker-task-archive.test.ts) | 1 | 未启用 `EVALUATOR_RETAINED_IMAGES_TEST=1`。 |
| [docker-task-build.test.ts](../../../tests/unit/docker-task-build.test.ts) | 2 | Windows 上显式跳过两个文件模式/umask 用例；其他构建用例正常执行。 |
| [docops-verification.test.ts](../../../tests/integration/docops-verification.test.ts) | 1 | 未启用 EVALUATOR_TEST_DOCKER=1。 |
| [dsh-docker-tool-outputs.test.ts](../../../tests/integration/dsh-docker-tool-outputs.test.ts) | 2 | 要求 EVALUATOR_TEST_DOCKER=1、Linux 和非 root 用户；本轮为 Windows 且未启用开关。 |
| [harbor-compose-docker.test.ts](../../../tests/integration/harbor-compose-docker.test.ts) | 2 | 未启用 EVALUATOR_COMPOSE_DOCKER_TESTS=1。 |
| [harbor-compose-timeout-docker.test.ts](../../../tests/integration/harbor-compose-timeout-docker.test.ts) | 2 | 未启用 EVALUATOR_COMPOSE_DOCKER_TESTS=1。 |
| [harbor-docker.test.ts](../../../tests/integration/harbor-docker.test.ts) | 4 | 未启用 EVALUATOR_HARBOR_DOCKER_TESTS=1。 |
| [harbor-multistep-docker.test.ts](../../../tests/integration/harbor-multistep-docker.test.ts) | 1 | 未启用 EVALUATOR_HARBOR_DOCKER_TESTS=1。 |
| [harbor-pipeline.test.ts](../../../tests/integration/harbor-pipeline.test.ts) | 1 | 测试要求 Linux 的 Git 和 shell 行为。 |
| [hermes-runtime.test.ts](../../../tests/unit/hermes-runtime.test.ts) | 2 | Windows 上显式跳过 POSIX Hermes 安装描述用例；Windows 拒绝安装的用例照常执行。 |
| [humaneval-program.test.ts](../../../tests/integration/humaneval-program.test.ts) | 1 | Windows 上显式跳过 Python 执行时限用例；其余 Python 用例照常执行。 |
| [jiuwenswarm-multimodal.test.ts](../../../tests/integration/jiuwenswarm-multimodal.test.ts) | 1 | 未配置 `EVALUATOR_JIUWENSWARM_TEST_PYTHON`。 |
| [kernel-operations-run.test.ts](../../../tests/integration/kernel-operations-run.test.ts) | 4 | 测试需要 POSIX 可执行脚本。已在 WSL 单独通过 4 项。 |
| [kernel-profile-options.test.ts](../../../tests/unit/kernel-profile-options.test.ts) | 1 | Windows 上显式跳过 POSIX replay 进程树取消用例。 |
| [kernel-profile-run.test.ts](../../../tests/integration/kernel-profile-run.test.ts) | 2 | 测试需要 POSIX 可执行脚本。已在 WSL 单独通过 2 项。 |
| [kernel-worker-environment.test.ts](../../../tests/integration/kernel-worker-environment.test.ts) | 5 | 测试需要 Linux 和 Python 3。 |
| [live-progress-docker.test.ts](../../../tests/integration/live-progress-docker.test.ts) | 1 | 未启用 EVALUATOR_LIVE_PROGRESS_DOCKER_TESTS=1。 |
| [multimodal-docker.test.ts](../../../tests/integration/multimodal-docker.test.ts) | 1 | 未启用 `EVALUATOR_TEST_DOCKER=1`。 |
| [multimodal-runners.test.ts](../../../tests/integration/multimodal-runners.test.ts) | 2 | 两项分别需要 `EVALUATOR_DEEPAGENTS_TEST_PYTHON` 和 `EVALUATOR_DSH_TEST_RUNTIME`。 |
| [network-allowlist-docker.test.ts](../../../tests/integration/network-allowlist-docker.test.ts) | 1 | 未启用 EVALUATOR_HARBOR_DOCKER_TESTS=1。 |
| [network-doctor.test.ts](../../../tests/unit/network-doctor.test.ts) | 1 | 此用例验证 POSIX 可执行文件的 ENOENT 行为。 |
| [officeqa-docker.test.ts](../../../tests/integration/officeqa-docker.test.ts) | 2 | 未启用 EVALUATOR_OFFICEQA_DOCKER_TESTS=1。 |
| [onboarding.test.ts](../../../tests/integration/onboarding.test.ts) | 1 | Windows 上显式跳过；该 doctor 用例使用 POSIX Python 替身脚本。 |
| [package-manager.test.ts](../../../tests/unit/package-manager.test.ts) | 2 | 这两个用例验证 Unix 符号链接和 shell 启动器。 |
| [real-harness-task-retry.test.ts](../../../tests/integration/real-harness-task-retry.test.ts) | 3 | 未配置 EVALUATOR_TEST_REAL_HARNESS_RUNTIME、EVALUATOR_TEST_REAL_DSH_IMAGE、EVALUATOR_TEST_REAL_HARNESS_OUTPUT。 |
| [simpleagent.test.ts](../../../tests/integration/simpleagent.test.ts) | 2 | Windows 上显式跳过 Bash 路径与任务 skills 两个用例。 |
| [trae.test.ts](../../../tests/integration/trae.test.ts) | 2 | 本地及 Docker 实测需设置 `EVALUATOR_TRAE_TEST`。 |
| [workflow-bundles-docker.test.ts](../../../tests/integration/workflow-bundles-docker.test.ts) | 1 | 默认未启用 `EVALUATOR_BUNDLE_MOUNT_TESTS`。此用例已在 WSL 中使用真实 Docker 单独通过。 |
| [workflow-jobs-ray.test.ts](../../../tests/integration/workflow-jobs-ray.test.ts) | 1 | 未启用 EVALUATOR_WORKFLOW_JOBS_TESTS=1；要求隔离的 Linux Ray/Docker 环境。 |
| [workflow-pelican.test.ts](../../../tests/integration/workflow-pelican.test.ts) | 1 | 未配置 EMBER_TEST_CHROMIUM，未运行真实浏览器用例；其他鹈鹕流程用例正常执行。 |
| [workflow-ray.test.ts](../../../tests/integration/workflow-ray.test.ts) | 2 | 未启用 EVALUATOR_WORKFLOW_RAY_TESTS=1；要求隔离的 Linux Ray 环境。 |
| [workspace-baseline-symlinks.test.ts](../../../tests/integration/workspace-baseline-symlinks.test.ts) | 1 | 未启用 EVALUATOR_TEST_DOCKER=1。 |
| [workspace-transfer-docker.test.ts](../../../tests/integration/workspace-transfer-docker.test.ts) | 3 | 未配置 EVALUATOR_DOCKER_TEST_IMAGE。 |
| [zcode.test.ts](../../../tests/integration/zcode.test.ts) | 2 | 本地及 Docker 实测需设置 `EVALUATOR_ZCODE_TEST`。 |
