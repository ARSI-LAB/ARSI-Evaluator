#!/bin/bash
set +e
mkdir -p /logs/verifier
if [ "$(cat /root/submission/output.txt 2>/dev/null)" = "docops-fixture" ]; then
  echo 1 > /logs/verifier/reward.txt
else
  echo 0 > /logs/verifier/reward.txt
fi
exit 0
