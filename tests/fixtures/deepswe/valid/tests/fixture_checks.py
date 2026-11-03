"""Fixture hidden check executed by tests/test.sh inside the verify container."""
from pathlib import Path

target = Path("/app/fixture_feature.py")
print(f"[verifier] checking {target}")
raise SystemExit(0 if target.exists() else 1)
