# WorkBuddy 评测

> [English](./workbuddy.md) | 中文

WorkBuddy 包含 Code、Office、Web 和 Security 四种场景，通过 Harbor 任务协议执行。使用 `benchmark.name: workbuddy` 和 `benchmark.scenario` 选择场景，默认 `code`、版本 `1.0`。

[用户文档](../README.zh-CN.md) · [Benchmark 目录](README.zh-CN.md) · [Harbor 执行规则](harbor.zh-CN.md)

## 选择场景

| 场景 | 主要条件 | 配置 |
| --- | --- | --- |
| Code | Docker、任务内测试及 Python verifier 运行时 | [Code 示例](../../../playbook/workbuddy/workbuddy-code.yaml) |
| Office | Docker、能交付文件的 Agent；模型评分可选 | [Office 示例](../../../playbook/workbuddy/workbuddy-office.yaml) |
| Web | Docker、模型裁判；视觉检查需裁判支持图片 | [Web 示例](../../../playbook/workbuddy/workbuddy-web.yaml) |
| Security | Linux 原生文件系统、Docker、任务网络策略 | [Security 示例](../../../playbook/workbuddy/workbuddy-security.yaml) |

在仓库根目录运行 `node dist/cli.js doctor <config.yaml>`，再执行 `node dist/cli.js run <config.yaml>`。模型变量和全局 CLI 见[安装与入门](../quick-start.zh-CN.md)。Office 文件交付应使用 SimpleAgent 或具备文件操作能力的 AgentBundle；Dify 的文件限制见[Solver 指南](../solvers.zh-CN.md#使用-dify)。

## WorkBuddy 的上游 CompositeVerifier

Office、Code、Web 使用 `harbor-python`，调用固定提交的上游 `workbuddy_bench.judge:CompositeVerifier` 和数据集内的共享插件，不复制上游判分规则。Sec 使用原有 shell verifier。相关来源、校验和、任务数量和元数据扩展均在 Playbook 中声明。

四个场景并非都调用模型。以下以当前固定的 [Tencent/workbuddy-bench 提交 `625b223`](https://github.com/Tencent/workbuddy-bench/blob/625b2233093ae4f23e76be28c1f341d41cc70373/configs/README.md#current-dataset-entry-points) 和 Playbook 锁定的 v1.0 数据集为准：

| 场景 | 上游默认模型裁判 | 原生评分方式 |
| --- | --- | --- |
| Code | 关闭；原生 verifier 不调用模型 | 根据 `tests/verifier.toml` 运行 pytest、任务脚本或结构化报告规则，使用其产生的成绩 |
| Office | 可选，默认关闭 | 始终运行文件与业务规则检查；显式提供裁判服务后才加入 `tests/judge.yaml` 的 rubric 判定 |
| Web | 默认开启；70 题均有模型裁判检查项 | 按任务 checklist 分配 rule、LLM、VLM、agent 裁判；普通失败累计扣分，fatal 项失败归零 |
| Sec | 关闭；不使用 CompositeVerifier 的模型裁判 | `tests/test.sh` 调用任务自带 scorer，进行 PoC 验证、YARA 匹配或 ground truth 比对 |

Code Profile 通过 `environment.config.buildPipConstraints` 为已确认不兼容的题目限制镜像内 Python 依赖：`workbuddy/bug_fix-medium-incorrect_linenos_on_fstring` 使用 `pytest<8`；`workbuddy/feature-medium-add_support_for_dependencies` 使用 `pytest<8`、`anyio<4.15`。约束在原 Dockerfile 安装依赖之前生效，不屏蔽 pytest 警告，不修改评分规则。其他 Code 题目保持原依赖要求，包括明确要求 pytest>=9 的题目；Office、Web 和其他 Profile 没有这些默认约束。

约束变化会生成新的任务镜像缓存标识；旧运行需使用新输出目录重新评测。用户可为某题配置空数组禁用其默认约束。直接选择 `harbor` 或自定义 Profile 时，需要显式配置这些限制。预构建镜像及 `imageOverrides` 指向的镜像不执行题目 Dockerfile，应提前制作兼容镜像；完整配置语义见 [Docker 依赖约束](../faq/docker.zh-CN.md#如何限制旧题目镜像中的-python-依赖)。

WorkBuddy Profile 不默认收集 `/logs/artifacts` 或 `/workspace/output`。只有题目或接入配置明确声明交付文件位置时，Evaluator 才保存对应文件；没有声明时不检查猜测的目录，也不因此警告。模型按题目要求生成的文件仍可由共享容器内的 grader 正常读取，日志、轨迹和评分结果照常保存。需要向外部选择器交付文件时，应按题目提供准确的 `artifacts` 收集声明；`artifacts = []` 表示不收集交付文件。归档包含文件只代表导出成功，外部选择器仍需读取 tar 内实际内容才能比较交付质量。

### 提交错误与评分环境故障

Code 的官方 `script_verifier` 任务在读取提交时，可能因 CSV 表头、空记录、编码或缺失输出触发未捕获异常。Evaluator 仅在官方 CompositeVerifier、code_lite manifest、原生 `build_error` 和 task verifier traceback 同时匹配时，将已识别的提交验证失败计 0 分、`passed:false`，并纳入指标分母。报告的“提交错误计零分”列出原因；`verdict.details.scoring` 为 `submission-failure-zero`，原始状态与奖励保持可查。该分数是 Evaluator 的失败处理，不是上游完整执行得到的原生分数。

依赖导入、pytest 收集、裁判服务、传输或原因不明的 `judge_error` 不会因状态名或任意 KeyError 自动变成零分。它们保留无效评分；`run.onError: continue` 下继续运行其他可执行任务，并生成包含失败记录的报告。认证、存储和清理未确认等要求停止调度的错误仍会停止。全部题目为正常评分或提交错误零分时，运行正常完成、退出码为 0；存在真实无效评分时，报告仍生成，退出码为非零。

Python worker 失败、异常退出或评分超时后，已有诊断会使用独立的有界信号脱敏并保存到 attempt 的 `verifier/`；`evaluator-worker.json` 保存 worker 错误、stderr 和清理诊断。归档失败会与最初评分错误分别记录到结果中，不能据此宣称文件已经保存。自定义 Python runtimeImage 更新 worker 时，也要包含同版本的 `/bridge/workbuddy.py`。

Profile 默认值和 Python 运行时文件变化会改变实验摘要；新旧配置不能混合续跑，应新建运行目录。

上游的 [Office 默认配置](https://github.com/Tencent/workbuddy-bench/blob/625b2233093ae4f23e76be28c1f341d41cc70373/configs/bench/wb-bench-office-v1.0.yaml) 为 `llm_judge.enabled: false`。本仓库的 Office Playbook 默认不绑定 judge；数据集中存在 `judge.yaml` 并不表示一定调用模型。启用时按每题声明的 `score_merge` 对规则分与 rubric 分做归一化加权；未启用时保留规则分，不把缺省模型评分记成零分，也不固定套用 80% / 20%。上游另有可选的运行后 `host_side` 白盒模型评分；本接入直接执行原生 verifier，不追加第二轮白盒评分。

[Web 默认配置](https://github.com/Tencent/workbuddy-bench/blob/625b2233093ae4f23e76be28c1f341d41cc70373/configs/bench/wb-bench-web-v1.0.yaml) 开启模型裁判。原生 Web 插件遇到所需模型检查项却没有裁判路由时会报错，不能降级为纯规则成绩。视觉检查需要支持图片输入的裁判模型。原生扣分为 `max(0, 1 - 普通失败项 penalty 之和)`，fatal 项失败时为 0；框架保存上游输出的奖励，不自行重新计算。

Web 或需要开启 Office rubric 评分时，在原有 `services` 中增加独立服务：

```yaml
judge:
  model: ${JUDGE_MODEL_NAME}
  base_url: ${JUDGE_MODEL_ENDPOINT}
  api: openai-completions
  api_key: ${JUDGE_MODEL_API_KEY}
```

在 `benchmark.verifier` 绑定裁判服务。保留当前 Benchmark 名称和其他配置；用户 YAML 不接受顶层 `verifier`：

```yaml
benchmark:
  name: workbuddy
  scenario: office
  verifier:
    name: harbor-python
    service: judge
    config:
      importPath: workbuddy_bench.judge:CompositeVerifier
      requireService: true
```

运行前设置 `JUDGE_MODEL_NAME`、`JUDGE_MODEL_ENDPOINT`、`JUDGE_MODEL_API_KEY`。不自动复用 Solver 凭据；需要同一个服务时，也应在 YAML 中显式绑定。`requireService: false` 只允许不绑定服务，若仍设置 `service: judge`，模型路由仍会注入并使 Office 开启 rubric 评分。关闭 Office 模型裁判时同时移除 service 绑定和未使用的 judge 服务块，避免配置加载仍要求其环境变量。比较结果时检查保存的实验配置及 `score.json` 中的 `llm_judge_enabled`、`score_merge`。

Python verifier 首次运行构建固定上游提交及冻结依赖的运行镜像，构建耗时计入验证时限；各执行节点需要 Docker 和对应的网络访问。这是执行上游 Python verifier 的运行时镜像：Code 和未开启模型裁判的 Office 也需要它，构建镜像本身不表示调用了裁判模型。镜像配方和 worker 随构建包发布并纳入包摘要。桥接 worker 通过进程与文件 RPC 调用 EnvironmentSession，不接触 Docker socket；启用时裁判凭据在验证阶段通过标准输入传入。

Python verifier 采用任务声明的 `verifier.import_path`；未声明时由 YAML 的 `importPath` 选择类，并用 `runtimeImage: registry/image@sha256:...` 提供包含该类、Harbor 依赖及 `/bridge/worker.py`、`/bridge/workbuddy.py` 的固定运行镜像。默认构建会按这些文件的内容更新镜像缓存；显式固定旧 `runtimeImage` 时，需要重新构建镜像才能使用新的 worker 失败处理。`serviceEnv` 可指定服务的环境变量映射，字段为 `baseUrl`、`key`、`model`，其值均为变量名。默认映射为 WorkBuddy 的 `WORKBUDDY_VERIFIER_LLM_*`。

## Sec 与 Windows / WSL

Sec 归档含安全样本，**不要解压到 Windows 目录或 WSL 的 `/mnt/c`、`/mnt/d` 共享目录**。Sec Playbook 使用 `source.hostPlatform: linux`，Windows 进程会在解压前拒绝运行。可以提交到 Linux Ray Jobs 协调端，或在 WSL 中运行评测器，并把 YAML、缓存、输出放在 Linux 文件系统中，例如 `~/evaluator-experiments/`、`~/.cache/harbor/`。不要关闭 Defender 来运行实验。

Sec 枚举完整 60 题，包含 51 道单步骤和 9 道多步骤任务。多步骤的公开指令和验证入口分别位于 `steps/<name>/instruction.md`、`steps/<name>/tests/test.sh`；各步骤共享任务环境，逐步加载公开 `workdir` 文件，不会提前向 Agent 提供后续步骤材料。`dotnet-3stage-rat-loader` 分析三阶段加载器，但评测步骤为 `unpack`、`analyze` 两步。

阶段执行和奖励规则采用固定上游 [Harbor `527d50d`](https://github.com/harbor-framework/harbor/blob/527d50deb63a5d279e8c20593c18a2cbc7f61f9e/src/harbor/trial/multi_step.py)：每步运行原生验证器，`min_reward` 不满足时停止后续步骤。默认对已有验证结果按奖励键取均值，缺失维度记 0；没有验证结果的步骤不进入均值分母。`final` 使用最后执行步骤的验证结果。Agent 超时或异常后仍验证已留下的文件；有有效奖励时保存该奖励及原始错误，不自动覆盖为零分。没有产生奖励的验证器错误仍如实保留。

Sec Profile 按[官方场景配置](https://github.com/Tencent/workbuddy-bench/blob/625b2233093ae4f23e76be28c1f341d41cc70373/configs/bench/wb-bench-sec-v1.0.yaml)将求解及验证时限乘 2，使用 `dev` 求解、`root` 验证。整题保护上限为 36000 秒，避免旧的 6000 秒上限提前截断官方阶段时限。阶段时限可被显式 run 配置覆盖，比较成绩时应保留实际配置。官方默认每题 3 次独立尝试；Evaluator 的任务故障重试不能替代独立尝试，应执行三次完整独立 run，分别保存结果。SimpleAgent 可通过 `services.default.contextWindow: 200000` 配置官方上下文阈值，该字段不限制单次回复长度；不同 Solver 的提示、工具及压缩实现仍由各自 harness 决定。

任务的 HTTP/HTTPS 白名单与 `no-network` 验证策略按声明执行。下一步求解前停止验证进程、删除私有测试及验证日志，再恢复求解网络。每步的轨迹、原生 session、验证输出、用量及错误保存在 `steps/<name>/`；根轨迹供现有指标和离线报告使用。旧 51 题 run 的来源和配置与完整 60 题不同，不能混合续跑。

## 下载与故障处理

裁判镜像构建和任务镜像构建是不同链路。下载源、代理、锁文件 URL 和证据权限分别见[下载 FAQ](../faq/downloads.zh-CN.md)和 [Docker FAQ](../faq/docker.zh-CN.md)。通用容器、网络、产物交付和评分汇总规则见 [Harbor 指南](harbor.zh-CN.md)。
