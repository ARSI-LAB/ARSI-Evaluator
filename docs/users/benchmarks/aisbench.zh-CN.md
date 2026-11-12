# AISBench SSH 插件

> [English](./aisbench.md) | 中文

AISBench 随 Evaluator 发布，CLI 和 SDK 默认注册。

安装、配置、执行、离线报告与限制统一见 [AISBench 插件说明](../../../plugins/aisbench/README.md)。

## 固定长度合成工作负载

设置 `benchmark.config.workload.dataset: synthetic` 使用 AISBench 原生
SyntheticDataset；通过 `inputLength`、`outputLength`、`dataCount`、
`concurrency`、`requestRate` 和 `warmups`（默认 0）配置负载。例如
4096/2048 token、1320 请求、并发 330、8 次预热。此模式使用流式请求，
不生成共享前缀；这不等于关闭服务端前缀缓存，也不证明实际缓存命中率。

SSH solver 检查成功请求数、零失败、实际输入输出 token 总量及毫秒时延。
合成性能结果不代表精度验证。省略 `dataset`
时，原有 GSM8K/前缀负载不变。远程失败即使未触发本地取消也会尝试停止任务；
取消未确认会留下 `cleanup-unconfirmed.json`，调用方必须先核对再重启。

合成负载使用 `aisbench:synthetic` 来源标识。内置指标和报告支持该标识并保留实际测量行，不要求数据集实现哈希。RSI 调用方也需支持合成负载字段与来源标识。
