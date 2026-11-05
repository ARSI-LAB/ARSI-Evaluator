# Check network and download failures

> English | [中文](network.zh-CN.md)

[Network configuration](../network.md)

Use the same experiment and network file as evaluation:

```bash
# Show effective settings without downloading
ember-evaluator inspect experiment.yaml --network network.yaml
# Check tools and connectivity, including temporary downloads
ember-evaluator doctor experiment.yaml --network network.yaml
```

## Read diagnostic results

`inspect` shows the network file path and settings after environment overrides. If editing YAML has no effect, check these effective values first.

`doctor` shows each check's location, destination, duration, and failure cause. Ray experiments run checks on execution nodes and report unreachable nodes separately. It does not call models or install missing Python, pip, uv, npm, pnpm, or Git tools.

| Status | Meaning |
| --- | --- |
| `passed` | This check passed |
| `failed` | This check failed; follow the reported cause |
| `not-checked` | This check is incomplete and needs follow-up |
| `not-applicable` | This experiment does not need the check |

Reading cached content without completing an actual download check does not count as a download pass. Incomplete checks exit with code `1`.

## Address failures

1. Check `network.configPath` to confirm which file to edit.
2. Use `guidance.yamlFields` to locate settings and `guidance.action` for the next step. Missing tools, authentication failures, and Docker connectivity need their own fixes; changing mirrors cannot solve every failure.
3. Recheck with the reported `retryCommand`. If using the mirror configuration in `recommendedCommand`, first confirm its addresses suit your environment. Evaluator does not change sources automatically.

For Docker proxy and daemon connection issues, see [deployment networking](../deployment/network.md).

## Prepare real tasks

`doctor` checks a selection of downloads and builds; it does not establish that every task image, dependency, or model call will work. Prepare the selected tasks next:

```bash
ember-evaluator warmup experiment.yaml --network network.yaml
```

`warmup` prepares images and dependencies without model calls. See [image warmup](../usage.md#warm-images-without-evaluation) for prerequisites and options. For eligible network failures in an existing run, see [network recovery](../network-retry.md).
