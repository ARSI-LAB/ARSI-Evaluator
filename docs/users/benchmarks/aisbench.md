# AISBench SSH Plugin

> English | [中文](./aisbench.zh-CN.md)

AISBench ships with Evaluator. The CLI and SDK register it by default.

See the [AISBench plugin guide](../../../plugins/aisbench/README.md) for installation, configuration, execution, offline reports, and limitations.

## Synthetic fixed-length workloads

Set `benchmark.config.workload.dataset: synthetic` to use AISBench's native
SyntheticDataset with `inputLength`, `outputLength`, `dataCount`, `concurrency`,
`requestRate`, and `warmups` (default 0). For example, 4096/2048 tokens, 1320
requests, concurrency 330 and 8 warmups reproduce that load shape. Streaming
and no generated shared prefixes are required; this does not disable server
prefix caching or assert a cache hit rate.

The SSH solver validates successful requests, zero failures, exact input/output
token totals, and millisecond latencies. A synthetic performance result is not an accuracy measurement. Existing
GSM8K/prefix workloads are unchanged when `dataset` is omitted. Remote failures
attempt cancellation even without local abort; unconfirmed cancellation leaves
`cleanup-unconfirmed.json`, which callers must reconcile before restarting.

Synthetic results use the `aisbench:synthetic` source identity. The built-in metrics and reporter accept that identity and retain the measured rows; a dataset implementation hash is not required. RSI consumers must support the synthetic workload fields and source identity as well.
