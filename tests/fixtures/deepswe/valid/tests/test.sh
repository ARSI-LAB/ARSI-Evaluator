#!/bin/bash
# Fixture verifier entrypoint mirroring the shared DeepSWE test.sh frame.
set -uo pipefail
trap 'if [ ! -f /logs/verifier/reward.json ] && [ ! -f /logs/verifier/reward.txt ]; then mkdir -p /logs/verifier; echo -1 > /logs/verifier/reward.txt; fi' EXIT
log() { echo "[verifier] $*"; }
cd /app || { mkdir -p /logs/verifier; exit 6; }

# Fixture stand-in for grader.py prepare + grade: apply the model patch if
# present, then grade the whitelisted fixture tests.
mkdir -p /logs/verifier /logs/artifacts
if [ -s /logs/artifacts/model.patch ]; then
  git apply --whitespace=nowarn /logs/artifacts/model.patch || { echo -1 > /logs/verifier/reward.txt; exit 0; }
fi
if python3 /tests/fixture_checks.py; then
  echo '{"reward": 1, "f2p": 1.0, "p2p": 1.0, "partial": 1.0, "f2p_total": 1, "f2p_passed": 1, "p2p_total": 1, "p2p_passed": 1}' > /logs/verifier/reward.json
else
  echo '{"reward": 0, "f2p": 0.0, "p2p": 1.0, "partial": 0.5, "f2p_total": 1, "f2p_passed": 0, "p2p_total": 1, "p2p_passed": 1}' > /logs/verifier/reward.json
fi
log "reward.json=$(cat /logs/verifier/reward.json 2>/dev/null)"
