# Local Datasets

> English | [中文](local-datasets.zh-CN.md)

Point Evaluator at downloaded data to avoid remote dataset requests. Missing files, invalid records and changed content fail without downloading a replacement. Omit the local setting to retain the benchmark's default remote source. CLI and SDK read the same experiment YAML.

## Harbor Tasks: WorkBuddy, Terminal-Bench and Others

Extract the published archive and override `benchmark.config.source` in your existing experiment. Keep the benchmark name, version, scenario, solver and verifier:

```yaml
benchmark:
  name: workbuddy
  scenario: office
  config:
    source:
      kind: local
      path: ./data/wb-bench-office-v1.0
```

The directory must contain `tasks/` and shared verifier assets. Other WorkBuddy scenarios use their own archive root. Terminal-Bench 4.0 scans task folders directly, so point to the extracted `tasks/` directory:

```yaml
benchmark:
  name: terminalbench
  version: "4.0"
  config:
    source:
      kind: local
      path: ./data/terminalbench4/tasks
```

Changing `source.kind` replaces archive-specific fields; omit `url`, `sha256` and archive `root`. Task rules, expected count, scoring and verification remain inherited from the Profile. If intentionally keeping a subset, adjust `tasks.expectedCount`; `run.maxTasks` does not change complete-dataset validation. See [Harbor configuration](benchmarks/harbor.md) for custom layouts.

## Hugging Face Record Datasets

Set `benchmark.config.localPath` to the downloaded dataset root. Preserve the paths and formats below:

```yaml
benchmark:
  name: gsm8k
  config:
    localPath: ./data/gsm8k
```

| Benchmark | Required relative files |
| --- | --- |
| gsm8k | `main/test-*.parquet` |
| mmlu | `all/test-*.parquet`, `all/dev-*.parquet` |
| mmlu_pro | `data/test-*.parquet`, `data/validation-*.parquet` |
| math500 | `test.jsonl` |
| gpqa | `gpqa_diamond.csv` |
| mgsm | `test-*.parquet` under every language directory selected by the built-in definition |
| triviaqa | `rc.nocontext/validation-*.parquet` |
| humaneval | `openai_humaneval/test-*.parquet` |
| simpleqa | `simple_qa_test_set.csv` |
| healthbench | `2025-05-07-06-14-12_oss_eval.jsonl` |

A benchmark with one file selection can also accept a single file in its expected format, such as a math500 JSONL or gsm8k Parquet. Directories load all matching shards. Multiple selections require a directory; one file is not reused across partitions. Record fields, scoring and private answers retain the remote dataset behavior; arbitrary JSON formats are not converted.

## AgentX, OfficeQA, DROP and Kernel

| Benchmark | Local configuration |
| --- | --- |
| AgentX | `benchmark.config.localPath`: `traces.jsonl` or its parent directory; data must match the chosen `variant` |
| OfficeQA Pro V2 | `benchmark.config.localPath`: root containing `officeqa_pro_v2.csv` and the complete corpus. `parsed-json` reads `parsed_corpus/jsons/*.json`; `pdf` reads `pdfs/*.pdf`. Official question/document counts remain enforced |
| DROP | `benchmark.config.localPath`: the published `.zip`, or the extracted parent containing `drop_dataset/drop_dataset_train.json` and `drop_dataset/drop_dataset_dev.json` |
| Kernel | The `benchmark.config.manifest` file lists tasks, references and candidate files; see [Kernel](benchmarks/kernel-npu.md) |

AgentX records a local dataset revision as `local:<content digest>` rather than a fabricated Hub commit. Tokenizer, harness and model configuration remain separate.

## Paths, Validation and Limits

- Relative paths resolve against the experiment YAML directory. Containers need mounted data and container-visible paths.
- Supply actual files, not Git LFS pointers. Selected symlinks are rejected; copy Hub cache symlinks into ordinary files first.
- Files are hashed and checked during reading and resume. Start a new run after changing data.
- Local datasets use local scheduling, with local or Docker environments as supported by the benchmark. Ray rejects coordinator-local paths; it does not upload these directories automatically.
- Local datasets do not make images, packages, tokenizers or model calls offline. See [network configuration](network.md).

```bash
ember-evaluator inspect experiment.yaml
ember-evaluator run experiment.yaml --dry-run
ember-evaluator warmup experiment.yaml
ember-evaluator run experiment.yaml
```

`inspect` displays configuration; `--dry-run` reads sources and enumerates tasks; `warmup` prepares actual data, images and dependencies. `doctor experiment.yaml` explicitly probes networks even when local data is configured.
