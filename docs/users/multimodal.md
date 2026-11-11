# Image and PDF evaluation

English | [中文](multimodal.zh-CN.md)

Tasks declare public files in `attachments`. Model services declare accepted inputs in `inputModalities`. A file in the workspace alone is not a model image input.

## Image input configuration

The source repository includes a development test fixture. Set `MODEL_NAME`, `MODEL_ENDPOINT`, and `MODEL_API_KEY`, then run from the source repository root:

```bash
pnpm build
node dist/cli.js run tests/fixtures/multimodal/image.yaml --patch tests/fixtures/multimodal/cordis.patch.yaml
```

The [fixture](../../tests/fixtures/multimodal/figure.png) contains no textual answer. The Benchmark stages it in the public workspace; the Solver checks its SHA-256 and sends the image bytes. Output remains a text answer.

```yaml
services:
  default:
    model: ${MODEL_NAME}
    base_url: ${MODEL_ENDPOINT}
    api_key: ${MODEL_API_KEY}
    inputModalities: [text, image]
```

Explicit declarations take priority. Without them, Pi, DSH, DeepAgents, and Hermes consult the pinned offline model catalog. Unknown or ambiguous models default to text. A declaration cannot prove that a custom endpoint actually supports the input; verify the request and the answer.

## PDF modes

| Mode | Sent to the model | Example |
| --- | --- | --- |
| `pages` | Ordered PNGs of explicitly selected pages | [Page images](../../tests/fixtures/multimodal/pdf-pages.yaml) |
| `native` | Original PDF bytes | [Native PDF](../../tests/fixtures/multimodal/pdf-native.yaml) |

Page rendering requires Poppler `pdftoppm` and `pdfinfo` on every execution node. `rendererVersion` must match exactly. The example uses `22.02.0`, 144 DPI, page 1. For Docker, rendering occurs on the execution node and media bytes reach the container Runner. Ray workers use their own prepared files.

The native example requires `DEEPAGENTS_BUNDLE_PATH` and a target service accepting Chat Completions `file.file_data`. Modes never switch automatically. Limits are 32 attachments/rendered inputs and 50 MiB per file and per request, with positive unique page numbers, DPI up to 300, and at most 40 megapixels per rendered page. Oversized, damaged, mismatched, or out-of-range inputs fail instead of being truncated.

## Harness matrix

| Harness | Images / PDF pages | Native PDF | Image tools |
| --- | --- | --- | --- |
| SimpleAgent / Pi | Connected | Rejected | Pi `read` |
| DSH 0.2.2-rc.1 | Structured SDK input | Rejected | Candidate `read_image` |
| DeepAgents 0.7.15 | Image messages | `file.file_data` | Runner `view_image` |
| Pinned Hermes | Native user image messages | Rejected | Candidate native tools |
| Dify | File upload and variable binding | Original PDF bound as `document` | Workflow-defined |
| JiuwenSwarm 0.2.5 (9b3706f) | Native image messages | Rejected | Native `read_file` |
| Codex 0.167.0 | CLI `--image` | Use `pages` mode | Codex `view_image` |
| Claude Code 2.1.322 | Messages `image` blocks | Messages `document` blocks | Claude Code `Read` |
| ZCode 0.17.1 | CLI `--attach` | CLI `--attach` | ZCode `Read` |

External Solvers default to text and must implement and declare their modalities before receiving attachments.

- For Codex, Claude Code, and ZCode, set the selected service's `inputModalities`. Declare `image` for images and PDF pages and `pdf` for native PDFs. Codex requires PDF tasks to use `pages` mode.
- ZCode sends native PDFs as Chat Completions `file.file_data`, Responses `input_file`, or Messages `document`. The endpoint must accept the corresponding format.
- Pi rejects image tasks when `images.blockImages` is enabled.
- Local DSH must resolve `@deepseek-ai/dsh-sdk-client` at the same pinned version. The Docker runtime includes it. The adapter preserves the candidate Profile and replaces its text ingress with SDK ingress.
- DeepAgents currently uses OpenAI-compatible Chat Completions. Declaring image capability enables `view_image`, restricted to the public workspace. Its output reaches the same target model.
- Hermes uses native image routing and rejects an explicit text route. Images currently require `openai-completions`; the adapter does not substitute a separate vision model.
- JiuwenSwarm images require `openai-completions` and an explicit `inputModalities: [text, image]`. The adapter enables `react.enable_read_image_multimodal` and `model_client_config.supports_vision`, rejecting an explicit `false`. Initial attachments and native `read_file` images are preserved together, without a separate vision model. The pinned runtime accepts PNG, JPEG and WebP initial images up to 10 MiB each. Local installations need the matching Python interpreter beside the process entry point.
- Dify requires `solver.config.dify.filesInput` and an accepting start-node file variable bound directly to an LLM file selector or a file reference in its ordinary prompt template. The LLM must lead to an end node and use the declared target model name. Native PDFs are uploaded and bound as `document`, without text extraction or automatic page rendering. Upload and workflow calls use the same user.
- Every Dify multimodal execution needs Console access through `DIFY_ADMIN_API_KEY` or `DIFY_EMAIL` / `DIFY_PASSWORD`. The deployed Provider must advertise `vision` for images and `document` for PDFs; otherwise execution fails before Dify can silently drop files. Configure the Provider and model in the [example Bundle](../../tests/fixtures/multimodal/dify/workflow.yaml). Model credentials remain on the Dify server.

For the native PDF test fixture, set `DIFY_BASE`, `MODEL_NAME` and Console credentials, then run from the source repository root:

```bash
node dist/cli.js run tests/fixtures/multimodal/pdf-native-dify.yaml --patch tests/fixtures/multimodal/cordis.patch.yaml
```

The example uses the Bundle's `files` variable.

## OfficeQA and evidence

`corpusFormat: pdf` retains the complete workspace corpus and permits text extraction. Add `visualInput` to attach explicitly selected public documents:

```yaml
benchmark:
  name: officeqa-pro-v2
  config:
    corpusFormat: pdf
    visualInput:
      documents: [pdfs/public-document.pdf]
      mode: pages
      pages: [1, 2]
      dpi: 144
      rendererVersion: 22.02.0
```

Use real names from the locked corpus. Selection never uses private answer/source columns. This adds visual inputs while retaining the corpus and must be reported as a separate experimental variant.

Results and `agent/input-media/` retain attachment identities, PDF mode, rendering parameters, originals, and page images. Page caches use source digest, renderer version, DPI, and page number; cached output digests are checked before reuse. Dify saves upload receipts within the attempt.

Pi keeps SDK session media during execution, then replaces encoded images in final evidence with independent artifact references. DeepAgents and DSH also avoid duplicating image bytes in ordinary trajectories. Harness runtime caches retain their native lifecycle.

Benchmark authors must lock public attachment files in `SourceLock` and encode input policy in configuration or locked task metadata. Existing configuration/source/plugin consistency checks protect resume; do not change selection under an unchanged source version. See [multimodal development](../development/multimodal.md) for the contract and controlled tests.
