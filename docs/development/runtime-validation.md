# 运行时与并发检查

> [English](./runtime-validation.en.md) | 中文

本文面向修改 Evaluator 的开发者。受控测试与手动容量测试分别记录，不将测试夹具作为普通用户默认配置。下列命令在仓库根目录执行。

[开发文档](README.md) · [用户并发指南](../users/concurrency.zh-CN.md)

## SimpleAgent 受控集成测试

构建后执行：

```bash
pnpm test --run tests/integration/simpleagent.test.ts --maxWorkers=1
```

测试在 suite setup 按运行时锁安装打包后的 Pi 及依赖，后续用例复用内容摘要对应的本地缓存，在真实子进程中运行 runner。首次准备需要可用的 npm 缓存或依赖下载条件，setup 有独立的安装预算；源码目录位于 WSL 的 Windows 挂载盘时，运行时依赖仍从宿主缓存加载。

模型请求发往测试启动的本地模拟服务，覆盖输出截断、上下文压缩、usage 缺失、取消、轨迹写入失败和扩展加载。用例原有的执行/取消限时与行为断言保持生效，不能将 suite setup 的安装耗时当作模型处理耗时。这项测试不代表真实模型成绩，也不通过新增 SDK 的高层入口；SDK API 回归见 [sdk.test.ts](../../tests/integration/sdk.test.ts)。

Pi 就绪探针使用 ESM 模块解析查找依赖，支持依赖位于包内或上层 `node_modules`，并检查固定版本。嵌套布局、hoisted 布局和版本不匹配回归见 [pi-runtime-probe.test.ts](../../tests/integration/pi-runtime-probe.test.ts)。

## Office Ray 多槽位手动检查

常规 [Office Ray Playbook](../../playbook/workbuddy/workbuddy-office-ray.yaml) 保持主仓默认的 2 并发、4 题和 4500 秒单题总预算，默认 Ray Compose 的两个 worker 各提供 1 个槽位。20 题、20 并发场景单独保存在 [测试 YAML](../../tests/fixtures/workbuddy-office-ray-20/experiment.yaml)，其构建预算倍率为 20，单题总预算为 9000 秒。配置单元测试会加载此夹具，自动测试不启动真实评测。

需要手动运行 20 并发测试时，先设置 `MODEL_NAME`、`MODEL_ENDPOINT`、`MODEL_API_KEY`，在仓库根目录执行：

```bash
ember-evaluator run tests/fixtures/workbuddy-office-ray-20/experiment.yaml --dry-run
pnpm ray:ensure
docker compose -f scripts/ray-smoke/compose.yaml -f scripts/ray-smoke/jobs.yaml -f tests/fixtures/workbuddy-office-ray-20/compose.yaml up -d --no-deps --no-build worker-a worker-b
ember-evaluator run tests/fixtures/workbuddy-office-ray-20/experiment.yaml
```

[测试槽位覆盖文件](../../tests/fixtures/workbuddy-office-ray-20/compose.yaml) 将两个 worker 各设为 10 槽位。测试 YAML 用 `managedLocal: false` 复用显式准备的集群，避免运行时自动准备恢复默认槽位；已有评测结束后再调整 worker。测试结束后，可通过省略覆盖文件恢复默认槽位：

```bash
docker compose -f scripts/ray-smoke/compose.yaml -f scripts/ray-smoke/jobs.yaml up -d --no-deps --no-build worker-a worker-b
```

## AgentX 桥接与指标检查

开发验证可设置 `AGENTX_TEST_PYTHON` 指向已经安装 Harness 和桥接扩展的隔离 Python，执行 `pnpm test --run tests/integration/agentx-bridge.test.ts`；该检查使用本地受控 SSE 和 Prometheus 服务，覆盖 Counter 重置，不代表真实模型性能。默认测试中的 `agentx-telemetry.test.ts` 验证配置、报告、设备查询、过期快照及退出行为，不使用 NPU。

## 检查结果的记录方式

受控 SSE、Prometheus 或 fixture 测试只证明相应协议和失败路径；真实模型吞吐、NPU 指标和大规模冷缓存容量需要分别运行并记录环境、配置及结果。正式实验放在 `docs/experiments/`，临时日志和探针放在 `.scratch/`，不要追加到用户指南。
