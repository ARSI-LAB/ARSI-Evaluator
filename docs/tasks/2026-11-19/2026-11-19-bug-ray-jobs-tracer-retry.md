# 在 WSL 验证 Ray Jobs 的 Benchmark 轨迹、续跑和补测

承接[工作流合入 master 的验收记录](2026-11-19-feature-workflow-master-integration.md)。使用 Node.js 24.22.1、Python 3.12.14 和 Ray 2.58.0。测试使用受控题目和 Solver，启动真实的 Ray、Jobs 网关和 Tracer Collector。

## 实跑发现的问题

- 用户只指定 Collector URL 时，tracer 将协调端推算的默认 SQLite 路径与服务端实际路径比较，随后放弃写入。现在使用指定地址上已运行的 Collector；显式设置数据库时仍检查路径。启动本地 Collector 时仍验证它使用的数据库。
- 补测时，客户端将日志脱敏用的全部密钥传入模型认证检查，导致 `EVALUATOR_JOBS_TOKEN` 与自身比较后被拒绝。现在只用评测声明的凭据检查是否与网关令牌相同，补测原因仍使用完整的脱敏列表。
- 双节点验收脚本把运行锁计入回执数量，可能等到原 CLI 已退出才调用 `kill`。现在只读取工作流回执，确认远端状态为 RUNNING，检查提交端确实收到 SIGKILL，并核对续跑回执的 Job ID。

## 双 worker 命令行验收

- 两个独立 worker 各执行一道题，使用本地执行环境。提交端被终止后，`run --resume` 重新连接同一 Job，从两节点收回评分并离线生成报告。
- 另一次运行通过 `run --tracer <URL>` 连接独立容器里的 Collector。首轮 task-0 注入故障，task-1 成功。只补测 task-0 后两题均得 1 分。重复提交同一补测请求，再执行普通续跑，运行记录和 Collector 均保留原来的三个 attempt。

## 仓库回归用例

在专用 Linux 容器中从 `/workspace` 运行以下命令，已构建的仓库同时挂载到 `/opt/evaluator`。用例自行启动和停止 Ray，因此两个文件串行执行。

```sh
EVALUATOR_WORKFLOW_JOBS_TESTS=1 EVALUATOR_WORKFLOW_RAY_TESTS=1 \
  node node_modules/vitest/vitest.mjs run --no-file-parallelism \
  tests/integration/workflow-jobs-ray.test.ts tests/integration/workflow-ray.test.ts
```

Jobs 用例查询 Collector 的 SQLite 数据库，核对首次失败的 `start`、首次成功和补测成功的 `start/end`，以及补测结果的 attempt ID 和分数。测试还删除集群侧本次运行的副本，验证从提交端产物恢复。测试总时限涵盖额外的补测和普通续跑，评测的单题时限保持原配置。

上述 3 项真实 Ray 用例全部通过，0 项跳过。首次执行默认集时，Docker 镜像复用测试将三次操作共用的 15 秒预算耗尽。另一次默认集复跑中，批量准备测试的 300 毫秒定时器在两名 worker 进入前触发，Kernel 缓存测试在完成 513 次写入和淘汰前耗尽了 5 秒预算。

Docker 夹具现在为每次操作单独计时。批量准备夹具等待两名 worker 进入后推进测试时钟，再验证取消、清理和队列状态。Kernel 缓存用例保留真实磁盘读写，允许在 30 秒内完成。

最终 Windows 默认测试集执行 `pnpm test --run`，2,614 项通过，123 项按环境条件跳过，0 项失败。跳过项的逐文件原因见[默认集跳过清单](2026-11-19-feature-workflow-master-integration.md#默认测试集中跳过的用例)，其中 3 项真实 Ray 用例本次已在 WSL 单独通过。依赖边界检查、TypeScript 类型检查和构建均通过。
