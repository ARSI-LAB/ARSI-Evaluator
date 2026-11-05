# WorkBuddy Evaluation

> English | [中文](./workbuddy.zh-CN.md)

WorkBuddy provides Code, Office, Web, and Security through Harbor task protocols. Select `benchmark.name: workbuddy` and `benchmark.scenario`; defaults are `code`, version `1.0`.

[User documentation](../README.md) · [Benchmarks](README.md) · [Harbor execution rules](harbor.md)

## Choose a Scenario

| Scenario | Requirements | Configuration |
| --- | --- | --- |
| Code | Docker, task tests, Python verifier runtime | [Code](../../../playbook/workbuddy/workbuddy-code.yaml) |
| Office | Docker, file-delivering agent; optional model scoring | [Office](../../../playbook/workbuddy/workbuddy-office.yaml) |
| Web | Docker, judge model; image-capable judge for visual checks | [Web](../../../playbook/workbuddy/workbuddy-web.yaml) |
| Security | Native Linux filesystem, Docker, task networking | [Security](../../../playbook/workbuddy/workbuddy-security.yaml) |

Run `ember-evaluator doctor <config.yaml>` then `ember-evaluator run <config.yaml>` from the root. See [quick start](../quick-start.md) for model variables/global CLI. Office requires SimpleAgent or file-capable AgentBundle; see [Dify limitations](../solvers.md#dify).

## Upstream WorkBuddy CompositeVerifier

Office, Code, and Web use `harbor-python` to call pinned upstream `workbuddy_bench.judge:CompositeVerifier` and shared dataset plugins, without copying scoring rules. Sec retains shell verification. Playbooks declare sources, checksums, task counts, and metadata extensions.

Not every scenario calls a model. The following reflects pinned [Tencent/workbuddy-bench `625b223`](https://github.com/Tencent/workbuddy-bench/blob/625b2233093ae4f23e76be28c1f341d41cc70373/configs/README.md#current-dataset-entry-points) and locked v1.0 datasets:

| Scenario | Default upstream model judge | Native scoring |
| --- | --- | --- |
| Code | Disabled; verifier makes no model calls | Runs pytest, scripts, or structured report rules from `tests/verifier.toml` and uses their scores |
| Office | Optional, disabled by default | Always checks files/business rules; adds `tests/judge.yaml` rubrics only with an explicit judge service |
| Web | Enabled; all 70 tasks contain model checks | Checklist selects rule, LLM, VLM, or agent judges; ordinary failures deduct penalties, fatal failures zero the score |
| Sec | Disabled; no CompositeVerifier model judge | `tests/test.sh` uses task scorers for PoC verification, YARA matching, or ground-truth comparison |

The Code profile uses `environment.config.buildPipConstraints` for confirmed incompatible tasks: `workbuddy/bug_fix-medium-incorrect_linenos_on_fstring` gets `pytest<8`; `workbuddy/feature-medium-add_support_for_dependencies` gets `pytest<8` and `anyio<4.15`. Constraints apply before original Dockerfile installs, without suppressing pytest warnings or changing scoring. Other Code tasks retain requirements, including explicit pytest>=9. Office, Web, and other profiles have no such defaults.

Constraint changes create new task image cache identities; reevaluate old runs in new output directories. An empty task array disables its defaults. Direct `harbor` or custom profiles must configure constraints explicitly. Prebuilt/images from `imageOverrides` skip task Dockerfiles and require compatible images prepared beforehand. See [Docker dependency constraints](../faq/docker.md#constrain-python-dependencies-in-older-tasks).

WorkBuddy profiles do not collect `/logs/artifacts` or `/workspace/output` by default. Only explicit task/integration paths are saved; guessed directories are neither checked nor warned about. Shared graders still read generated files; logs, trajectories, and scores remain saved. Declare accurate `artifacts` for external selectors; `artifacts = []` disables deliverable collection. An archived file proves export only; selectors must inspect tar contents to compare quality.

### Submission Errors and Scoring Infrastructure Failures

Official Code `script_verifier` tasks may throw uncaught exceptions on CSV headers, empty records, encodings, or missing output. Only when official CompositeVerifier, code_lite manifest, native `build_error`, and task verifier traceback all match does Evaluator score recognized submission failures as 0 with `passed:false`, including them in the metric denominator. Reports list reasons under submission errors scored zero; `verdict.details.scoring` is `submission-failure-zero`, retaining native status/reward. This is Evaluator failure handling, not a fully completed native upstream score.

Dependency imports, pytest collection, judge services, transfers, and unexplained `judge_error` remain invalid scores; names or arbitrary KeyError do not imply zero. With `run.onError: continue`, other executable tasks continue and reports include failures. Authentication, storage, or unconfirmed cleanup errors requiring a stop still stop dispatch. Runs containing only normal scores/submission zeros complete with exit 0; actual invalid scores still generate reports but return nonzero.

After Python worker failure, abnormal exit, or scoring timeout, available diagnostics are redacted/saved under attempt `verifier/` using a separate bounded signal. `evaluator-worker.json` contains worker errors, stderr, and cleanup diagnostics. Archive failures are recorded separately from initial scoring errors; do not claim files were saved after archive failure. Custom Python runtimeImage worker updates must include matching `/bridge/workbuddy.py`.

Profile/runtime file changes alter experiment digests. Start a new output directory rather than mixing old/new configurations through resume.

Upstream [Office defaults](https://github.com/Tencent/workbuddy-bench/blob/625b2233093ae4f23e76be28c1f341d41cc70373/configs/bench/wb-bench-office-v1.0.yaml) set `llm_judge.enabled: false`. Office Playbooks bind no judge by default; `judge.yaml` presence does not imply model calls. When enabled, task `score_merge` determines normalized rule/rubric weights. Otherwise retain rule scores, without treating absent model scores as zero or imposing 80%/20%. Upstream optionally supports post-run `host_side` white-box scoring; this integration runs native verifiers without a second scoring round.

[Web defaults](https://github.com/Tencent/workbuddy-bench/blob/625b2233093ae4f23e76be28c1f341d41cc70373/configs/bench/wb-bench-web-v1.0.yaml) enable judges. Missing required judge routes fail rather than falling back to rules. Visual checks need image-capable judges. Native penalties are `max(0, 1 - sum of ordinary failure penalties)`, with fatal failures scoring 0. The framework saves upstream rewards without recalculating.

For Web or Office rubric scoring, add an independent service to existing `services`:

```yaml
judge:
  model: ${JUDGE_MODEL_NAME}
  base_url: ${JUDGE_MODEL_ENDPOINT}
  api: openai-completions
  api_key: ${JUDGE_MODEL_API_KEY}
```

Bind it through `benchmark.verifier`, keeping benchmark name/other settings. User YAML does not accept top-level `verifier`:

```yaml
benchmark:
  name: workbuddy
  scenario: office
  verifier:
    name: harbor-python
    service: judge
    config:
      importPath: workbuddy_bench.judge:CompositeVerifier
      requireService: true
```

Set `JUDGE_MODEL_NAME`, `JUDGE_MODEL_ENDPOINT`, and `JUDGE_MODEL_API_KEY`. Solver credentials are not automatically reused; bind explicitly even for the same service. `requireService: false` permits omission but does not disable a remaining `service: judge`, which still enables Office rubrics. Disable Office judging by removing the binding and unused judge service block so loading no longer requires its variables. Compare saved configurations and `score.json` `llm_judge_enabled`/`score_merge`.

First Python verification builds a runtime image with pinned upstream commit/frozen dependencies; build time counts toward verification limits. Nodes need Docker and network access. Code and Office without model judging also need this image; building it does not imply judge calls. Recipes/workers ship in the build and package digest. Bridge workers use process/file RPC with EnvironmentSession, without Docker socket access. Enabled judge credentials arrive through stdin during verification.

Python verifiers use task `verifier.import_path`, otherwise YAML `importPath`. Supply a pinned `runtimeImage: registry/image@sha256:...` containing the class, Harbor dependencies, `/bridge/worker.py`, and `/bridge/workbuddy.py`. Default builds refresh caches from file contents; explicitly pinned old `runtimeImage` must be rebuilt for new failure handling. `serviceEnv` maps `baseUrl`, `key`, and `model` to variable names; defaults use WorkBuddy `WORKBUDDY_VERIFIER_LLM_*`.

## Sec on Windows / WSL

Sec archives contain security samples. **Do not extract on Windows paths or WSL `/mnt/c`/`/mnt/d` shares.** Playbooks set `source.hostPlatform: linux`, rejecting Windows processes before extraction. Submit to Linux Ray Jobs or run Evaluator in WSL with YAML, cache, and output on Linux filesystems, such as `~/evaluator-experiments/` and `~/.cache/harbor/`. Do not disable Defender.

Sec enumerates all 60 tasks: 51 single-step and nine multi-step. Step instructions/tests are `steps/<name>/instruction.md` and `steps/<name>/tests/test.sh`. Steps share environments and load public `workdir` files incrementally without exposing later materials early. `dotnet-3stage-rat-loader` analyzes three loader stages but has two evaluation steps: `unpack`, `analyze`.

Execution/rewards follow pinned [Harbor `527d50d`](https://github.com/harbor-framework/harbor/blob/527d50deb63a5d279e8c20593c18a2cbc7f61f9e/src/harbor/trial/multi_step.py). Each step runs native verification; failure to meet `min_reward` stops later steps. Default aggregation averages existing verification results by reward key, with missing dimensions zero; steps without results are excluded. `final` uses the last executed step's verdict. After agent timeout/error, remaining files are still verified; valid rewards and original errors are preserved without automatic zeroing. Missing-reward verifier errors remain errors.

Following [official scenario configuration](https://github.com/Tencent/workbuddy-bench/blob/625b2233093ae4f23e76be28c1f341d41cc70373/configs/bench/wb-bench-sec-v1.0.yaml), Sec doubles solve/verify limits and uses `dev` for solving, `root` for verification. The whole-task cap is 36000 seconds, avoiding the old 6000-second premature cutoff. Explicit run phase overrides remain possible; retain actual configuration for comparisons. Official defaults use three independent attempts per task; fault retries are not independent attempts. Execute three complete separate runs and save each. SimpleAgent `services.default.contextWindow: 200000` sets the official context threshold, not reply length; prompts, tools, and compaction remain harness-specific.

Task HTTP/HTTPS allowlists and `no-network` verification are enforced. Before the next solve step, stop verification processes, remove private tests/logs, and restore solve networking. Each step saves trajectories, native sessions, verification output, usage, and errors in `steps/<name>/`. Root trajectories support existing metrics/offline reports. Old 51-task runs differ in source/configuration and cannot resume as 60-task runs.

## Downloads and Troubleshooting

Judge runtime builds and task image builds are separate paths. See [download FAQ](../faq/downloads.md) and [Docker FAQ](../faq/docker.md) for sources, proxies, lockfile URLs, and evidence permissions. See [Harbor](harbor.md) for networking, artifacts, and score aggregation.
