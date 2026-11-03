# DeepSWE fixture

Synthetic task mirroring the official DeepSWE-Bench v1.1 `task.toml` shape
(schema 1.3, separate no-network verifier, official collect hook). All content
is synthetic; the pinned real snapshot is `datacurve-ai/deep-swe` commit
`0b9fabbb63b9104d678fe965e1632f2dd9eaa2ea` (113 tasks, see
`playbook/deepswe/deepswe-simpleagent.yaml`).

- `valid/` — a well-formed task with every supported field.
- `solution/` exists only to prove solution material stays private.
