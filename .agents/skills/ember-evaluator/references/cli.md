# CLI 速查

先运行 `ember-evaluator --help`，用 `ember-evaluator <命令> --help` 核对当前版本参数。嵌套命令也可直接查看帮助，例如 `ember-evaluator benchmark info --help`。

| 用途 | 示例 | 行为 |
| --- | --- | --- |
| 查 Benchmark | `ember-evaluator benchmark list` | 列出注册的 Benchmark、版本与场景。 |
| 查 Benchmark 细节 | `ember-evaluator benchmark info <name>` | 查看版本和解析后的设置。 |
| 生成 YAML | `ember-evaluator init --benchmark <name> --output experiment.yaml` | 从默认配置生成文件，已有文件会保留。 |
| 解析配置 | `ember-evaluator inspect experiment.yaml` | 展示生效配置，无下载探测。 |
| 检查环境 | `ember-evaluator doctor experiment.yaml` | 检查配置、运行前置条件与网络。 |
| 枚举选题 | `ember-evaluator run experiment.yaml --dry-run` | 解析数据集，可下载数据，输出所选任务 ID。 |
| 预热 | `ember-evaluator warmup experiment.yaml` | 准备镜像和运行时，跳过求解。 |
| 正式评测 | `ember-evaluator run experiment.yaml` | 执行选题并保存结果。 |
| 续跑 | `ember-evaluator run experiment.yaml --resume <run-id>` | 在原 run 执行未完成或无效任务。 |
| 网络补测 | `ember-evaluator retry --run <run-id-or-directory>` | 在原 run 定向补测有明确网络故障证据的无效题。 |
| 重建报告 | `ember-evaluator report <run-dir>` | 从保存的结果重建指标和 Markdown 报告，无需模型 API key。 |
| 清理镜像 | `ember-evaluator cleanup images experiment.yaml` | 默认预览，`--yes` 执行删除。仅在用户要求清理时执行删除。 |
| Kernel 性能 | `ember-evaluator kernel bench --help` | 先验证 Kernel，再测性能。 |
| Kernel 精度 | `ember-evaluator kernel precision --help` | 按指定随机种子验证正确性。 |
| Kernel Profiling | `ember-evaluator kernel profile --help` | 单独采集 profiling 数据。 |

`benchmark list/info`、`init`、`inspect`、`doctor`、`warmup` 和 `run` 支持显式 `--patch`。inspect、doctor、warmup、run 和 retry 支持 `--network`。retry 从保存的 run 恢复插件，传参时省略 `--patch`。report 重建时仍需要能访问 run 记录的外部报告插件。

参阅 [CLI 使用指南](../../../../docs/users/usage.zh-CN.md)。
