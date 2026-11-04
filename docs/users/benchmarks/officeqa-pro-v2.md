# OfficeQA Pro V2

> English | [中文](./officeqa-pro-v2.zh-CN.md)

`officeqa-pro-v2` evaluates evidence retrieval, calculation, and answering across a full corpus: Databricks' official 90 questions and 1,435 US Treasury documents. Tasks use original `uid`; the first two IDs in the pinned CSV are strings `"0"` and `"1"`.

[Official code](https://github.com/databricks/officeqa) · [Dataset and access requests](https://huggingface.co/datasets/databricks/officeqa-pro-v2) · [Configurations](../../../playbook/officeqa-pro-v2/) · [Benchmark guides](README.md)

## Inputs and Evaluation Conditions

Questions are stored in CSV; the corpus downloads separately. Agents receive each question and the complete corpus directory. Answers, relevant-document lists, and answer page numbers remain private for scoring/auditing.

The official dataset provides parsed JSON and original PDFs without requiring exclusively PDFs or images. Two representations are supported; JSON contains parsed documents, not reference answers:

| Input | Setting | Agent-visible content |
| --- | --- | --- |
| Official parsed JSON, default | `corpusFormat: parsed-json` | Searchable text, tables, page structure, coordinates; approximately 794 MB |
| Original PDFs | `corpusFormat: pdf` | Official PDFs, approximately 13.3 GB; original text layers retained, with `pdftotext` and rendering allowed |

**An image-only protocol rendering every PDF and withholding machine-readable text is not implemented.** `pdf` means original files, not image-only input; changing corpusFormat cannot reproduce image-only conditions.

For example, Moonshot's published DeepSeek V4.1 Flash 1017 OfficeQA Pro V2 **40.4%** used fully rendered PDF images without machine-readable text and Claude Code for DeepSeek; tasks obtaining reference answers online received additional zeros. See [Agentic benchmarks footnote 3](https://www.kimi.ai/blog/kimi-k3-1-pro) and the [original chart](https://statics.kimi.ai/kimi-blogs/kimi-k3-1/20261023/finance-productivity-v4.webp). This implementation uses official answer matching but does not reproduce their image input, harness, or additional behavioral zeroing, so results are not directly comparable.

Report document format, solver, data version, tolerance, task range, and budget, for example “OfficeQA Pro V2 / parsed-json / simpleagent / tolerance=0 / 90 questions”. For PDFs, state that text extraction is permitted. Matching scoring scripts does not establish identical evaluation conditions.

## Preparation and Execution

Follow [installation](../installation.md). Requires Docker, a tool-calling model API, and an HF token authorized for the dataset. Keep tokens out of YAML.

Set `HF_TOKEN`, `MODEL_NAME`, `MODEL_ENDPOINT`, and `MODEL_API_KEY` in the execution terminal. HF mirrors are used by default; for gated access, explicitly set `HF_ENDPOINT=https://huggingface.co`. Endpoints must be HTTP(S) origins and match on coordinator/Ray nodes.

Run from the repository root:

```bash
ember-evaluator benchmark info officeqa-pro-v2
ember-evaluator doctor playbook/officeqa-pro-v2/officeqa-pro-v2-parsed-json-simpleagent.yaml
ember-evaluator run playbook/officeqa-pro-v2/officeqa-pro-v2-parsed-json-simpleagent.yaml --dry-run
ember-evaluator run playbook/officeqa-pro-v2/officeqa-pro-v2-parsed-json-simpleagent.yaml
```

`doctor` checks configuration, local dependencies and network access with temporary download/build probes; it does not download the full questions/corpus. `--dry-run` queries sources, reads the question CSV, and prints task IDs under normal CLI rules. It requires access and may download approximately 225KB initially, but does not download corpus, build images, or call models.

JSON/PDF, single-machine, and Ray Playbooks have no task limits and run all 90 questions. These commands use the [full parsed-JSON configuration](../../../playbook/officeqa-pro-v2/officeqa-pro-v2-parsed-json-full.yaml):

```bash
ember-evaluator run playbook/officeqa-pro-v2/officeqa-pro-v2-parsed-json-full.yaml
```

For a small check, add `run.maxTasks: 2`. Select an ID with `run.taskIds: ["0"]`; quote numeric IDs to keep strings. Limiting questions does not shrink the corpus. Start a new run when switching to all tasks.

## Document Formats and Options

```yaml
benchmark:
  name: officeqa-pro-v2
  config:
    hfToken: ${HF_TOKEN}
    corpusFormat: parsed-json
    tolerance: 0
```

| Field | Default and meaning |
| --- | --- |
| `corpusFormat` | `parsed-json`; also `pdf` (original PDFs, text extraction allowed); one format per run; no image-only protocol |
| `revision` | `65a2b315780417bc50d7bfe6e5bdb904e63fda65`; full commit SHA required |
| `cacheDir` | `${EVALUATOR_CACHE_DIR}/officeqa-pro-v2` from the profile; relative paths use the YAML directory |
| `hfToken` | `${HF_TOKEN}`, read from the terminal or SDK `env`; no literal token and no injection into solve containers |
| `dockerExecutable` | `docker`, used by private scoring containers |
| `tolerance` | `0`; relative numerical `tolerance` in `[0, 1]`, e.g. `0.01` means 1% |

Defaults: Docker, simpleagent, local concurrency 1, 3600 seconds per task, and 3600 seconds for batch preparation. Replace agents using [solvers](../solvers.md). Host local environments and extra verifiers/judges are unsupported.

JSON retains official `document.elements` and page structures. Public documents live in `/corpus` with original names; agents work in `/workspace`. Images provide Python 3, ripgrep, `pdftotext`, and `pdftoppm`. See the [original PDF example](../../../playbook/officeqa-pro-v2/officeqa-pro-v2-original-pdf.yaml).

Formats use separate public corpus images with shared layers across tasks and independent attempt workspaces. Initial download, build context preparation, and image builds require more disk space than raw corpus size for caches, snapshots, and layers. Question CSV, answers, relevant-document hints, page numbers, and scoring scripts never enter public build contexts or solve images.

## Scoring and Results

Scoring directly calls `reward.py` from `databricks/officeqa@7b9a3c154ef9fb40215bb67934afc43e6799de16` in a separate offline Python container. Default tolerance is zero; no LLM judge is called.

The prompt requests a short one-line answer inside `<FINAL_ANSWER>…</FINAL_ANSWER>`, with explanation outside. Extraction and number, currency, accounting-negative, unit, percentage, label, and list matching follow the pinned script. `tolerance: 0` means zero numerical tolerance, not literal string equality. Inputs outside official answer rules may score zero.

Each task scores 0 or 1. Reports use existing success-rate, duration, and token metrics. Verification details save script revision, SHA-256, tolerance, and corpus format. Python/Docker startup failures, timeouts, cancellation, or invalid output are not valid zeros. Label different formats/tolerances separately; PDF and parsed JSON have different input conditions.

Reference answers are omitted from results by default. `run.includeTaskAnswer: true` writes them only after solving and never provides them to solvers. `/workspace` is collected as an artifact; trajectories use existing result paths.

Resume and offline reports:

```bash
ember-evaluator run playbook/officeqa-pro-v2/officeqa-pro-v2-parsed-json-simpleagent.yaml --resume
ember-evaluator report /absolute/path/to/run-directory
```

Resume pins the original commit, file manifest, and SHA-256. Complete valid caches require no HF access; missing/corrupt caches redownload original URLs/digests. Explicit YAML `hfToken: ${HF_TOKEN}` still requires that variable at configuration load. Modified public build directories fail explicitly rather than using changed documents. Scoring script/package changes retain plugin-version checks. Offline reporting requires no model key, HF token, or scoring rerun.

## Ray and Acceptance Boundaries

The [parsed JSON + Ray example](../../../playbook/officeqa-pro-v2/officeqa-pro-v2-parsed-json-ray.yaml) uses the same benchmark and explicitly selects JSON. Nodes download all documents in that format from locked sources and build local corpus images; coordinator absolute paths are not transmitted. Each node needs HF_TOKEN credentials, matching endpoint, Docker, and adequate cache space. hfToken is stripped from dispatch and Jobs retry configurations; nodes read their own HF_TOKEN. Coordinator tokens never enter task messages; saved/exported local configuration keeps variable references only.

Controlled tests use neither production datasets nor real models. Independent Docker acceptance uses synthetic CSV/JSON/PDF to check tools, scoring containers, image reuse, persistence, and offline reports:

```bash
EVALUATOR_OFFICEQA_DOCKER_TESTS=1 pnpm test --run tests/integration/officeqa-docker.test.ts
```

In PowerShell, set `$env:EVALUATOR_OFFICEQA_DOCKER_TESTS = "1"` before the test command. Passing controlled tests does not validate production downloads, real model quality, or real Ray clusters; validate each separately.
