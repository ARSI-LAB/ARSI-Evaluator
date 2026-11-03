#!/bin/sh
set -eu
mkdir -p /logs/verifier
if [ "$(cat /workspace/answer.txt 2>/dev/null || true)" = "42" ]; then
  printf '1\n' > /logs/verifier/reward.txt
else
  printf '0\n' > /logs/verifier/reward.txt
fi
