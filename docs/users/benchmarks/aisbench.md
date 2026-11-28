# AISBench SSH Plugin

> English | [中文](./aisbench.zh-CN.md)

AISBench ships with Evaluator. The CLI and SDK register it by default.

See the [AISBench plugin guide](../../../plugins/aisbench/README.md) for installation, configuration, execution, offline reports, and limitations.

## Synthetic fixed-length workloads

Set `benchmark.config.workload.dataset: synthetic` to use AISBench's native SyntheticDataset with `inputLength`, `outputLength`, `dataCount`, `concurrency`, `requestRate`, and optional `warmups` (default 0). For example, 4096/2048 tokens, 1320 requests, concurrency 330 and 8 warmups reproduce that load shape. The SyntheticDataset executor currently supports streaming requests without generated shared prefixes; it reports an explicit execution error for unsupported combinations. This does not disable server prefix caching or assert a cache hit rate.

Set `dataset: gsm8k` to explicitly select the bundled GSM8K performance workload. Omitting `dataset` preserves the same legacy GSM8K performance path. `dataset: gsm8k` does not add accuracy scoring, and `warmups`, `testType`, and `prefixCache` remain independent configuration fields.

The SSH solver validates successful requests, zero failures, exact input/output token totals, and millisecond latencies. A synthetic performance result is not an accuracy measurement. Remote failures attempt cancellation even without local abort; unconfirmed cancellation leaves `cleanup-unconfirmed.json`, which callers must reconcile before restarting.

Synthetic results use the `aisbench:synthetic` source identity. The built-in metrics and reporter accept that identity and retain the measured rows; a dataset implementation hash is not required. RSI consumers must support the synthetic workload fields and source identity as well.

The existing `aisbench-performance` metrics result includes each point’s `workload` and normalized scalar `metrics`: metric ID maps to `{ value, unit, source }`, with `null` for unavailable values and a JSON evidence pointer relative to the point. Native `measurement` evidence remains available for reporting. Only completed points with complete artifact collection emit metrics. AISBench parsing, request/token completeness and source validation belong to this plugin; consumers should not reparse CSV rows.
