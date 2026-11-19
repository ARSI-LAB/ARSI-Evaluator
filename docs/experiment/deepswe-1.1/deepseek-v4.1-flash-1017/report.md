# DeepSWE 1.1 运行报告

`deepseek-v4.1-flash-1017`。九种 Solver 各运行 20 题，共 180 条最终计分记录，其中 122 条答对，7 条求解超时。[实验设置与三张原图](README.md)

## 各 Solver 的最终成绩

表中求解耗时按分:秒显示，Token 栏以万为单位。最后一列为两项分位数各自采用的题数。

| Solver | 答对 / 题数 | 准确率 | 求解超时 | 耗时中位数 | 耗时 P90 | Token 中位数 | Token P90 | 耗时与用量样本数 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| DeepSeek Harness | 15/20 | 75.00% | 0 | 9:25 | 15:32 | 591 | 1,053 | 20/20 |
| Codex | 15/20 | 75.00% | 0 | 11:07 | 20:28 | 659 | 1,834 | 20/20 |
| Pi | 15/20 | 75.00% | 0 | 9:17 | 15:12 | 442 | 974 | 20/20 |
| Claude Code | 15/20 | 75.00% | 0 | 11:12 | 15:25 | 729 | 1,233 | 20/20 |
| TRAE | 15/20 | 75.00% | 0 | 12:24 | 28:11 | 1,204 | 2,287 | 20/20 |
| ZCode | 13/20 | 65.00% | 0 | 16:39 | 24:42 | 1,395 | 1,836 | 20/20 |
| SimpleAgent | 12/20 | 60.00% | 0 | 9:07 | 16:08 | 437 | 962 | 20/20 |
| JiuwenSwarm | 12/20 | 60.00% | 1 | 9:35 | 17:49 | 872 | 1,426 | 19/20 |
| CodeBuddy | 10/20 | 50.00% | 6 | 31:04 | 48:18 | 1,535 | 2,602 | 14/20 |

准确率以每个 Solver 的全部 20 题为分母。耗时取最终尝试的求解阶段，含已完成的错题，剔除求解超时。Token 取最终尝试上报的总量，缺失值跳过。P90 按排序样本的 `0.9 × (n − 1)` 位置线性插值。

## 运行报告与补测来源

从 `finals.zip` 的 `finals/` 目录按 Solver 和题号读取最终尝试，每个组合恰有一条。

来源文件 SHA-256 为 `b5d18982b0dac3cea6bd84f243d25bb0c20741a6b803b24119da5a7bd7db9611`。

随附的 14 份原始 `report.md` 按 `<solver>/<run-id>/report.md` 存放。每份记录一次运行，可能同时包含后来被补测替换的题。下表列出各次运行最终采用的题号。[下载原始运行报告](run-reports.zip)

<details><summary>查看 14 次运行的入选题号</summary>

| Solver | Run ID | 入选题数 | 入选题号 |
| --- | --- | ---: | --- |
| DeepSeek Harness | `31e49d91-5189-4cbe-a9e5-b1521a6c1650` | 19 | 除 `koota-composite-trait-aspects` 外的全部题目 |
| DeepSeek Harness | `2a1fb10a-41b7-4167-9eb9-9f07e879bdf7` | 1 | `koota-composite-trait-aspects` |
| Codex | `1e3ddec6-6032-4576-9fa0-bc1932783298` | 20 | 全部题目 |
| Pi | `a775ee1d-1463-417b-83e2-3f4679aafe6f` | 19 | 除 `koota-composite-trait-aspects` 外的全部题目 |
| Pi | `92f617d1-fc10-4eaf-afd7-b6bdd52ca3d5` | 1 | `koota-composite-trait-aspects` |
| Claude Code | `da7f7e48-c459-4f6d-a866-af64db2e89c3` | 20 | 全部题目 |
| TRAE | `60200be0-2a5f-4153-aae6-7b3ad2114f23` | 14 | 除 `bandit-structured-nosec-directives`、`csstree-shorthand-expansion-compression`、`effect-sse-httpapi-streaming`、`fastapi-implicit-head-options`、`koota-composite-trait-aspects`、`query-persist-restored-query-state` 外的全部题目 |
| TRAE | `294fd52a-9919-4e24-ac18-b175bcdeaf4d` | 6 | `bandit-structured-nosec-directives`、`csstree-shorthand-expansion-compression`、`effect-sse-httpapi-streaming`、`fastapi-implicit-head-options`、`koota-composite-trait-aspects`、`query-persist-restored-query-state` |
| ZCode | `45d263ea-6857-46c9-9593-746c1e402848` | 20 | 全部题目 |
| SimpleAgent | `635de06f-b902-401d-bbdf-5baab6bf89a8` | 20 | 全部题目 |
| JiuwenSwarm | `c301fbe5-27b8-49de-94d0-e41a667e4044` | 8 | `bandit-structured-nosec-directives`、`csstree-shorthand-expansion-compression`、`effect-sse-httpapi-streaming`、`fastapi-implicit-head-options`、`pest-character-class-coalescing`、`skrub-duration-encoding`、`tengo-callable-instance-isolation`、`textual-richlog-follow-state` |
| JiuwenSwarm | `e002a4b1-0d5f-436a-b336-1316afe93b1b` | 8 | `abs-module-cache-flags`、`anko-typed-variable-bindings`、`httpx-deterministic-cookie-store`、`langchain-request-coalescing`、`opa-rego-rule-profiling`、`query-persist-restored-query-state`、`vitest-duration-sharding`、`ytt-jsonpath-query-api` |
| JiuwenSwarm | `ddc85b1d-b258-4379-99eb-eef8d3c42c6e` | 4 | `goreleaser-retry-publish-auditing`、`katex-multicolumn-array-spans`、`koota-composite-trait-aspects`、`numba-stencil-boundary-modes` |
| CodeBuddy | `dc1f2825-4b97-4be8-8819-4f36b4eb0efe` | 20 | 全部题目 |

</details>
