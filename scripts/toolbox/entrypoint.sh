#!/usr/bin/env bash
set -euo pipefail
export PNPM_HOME="${PNPM_HOME:-$HOME/.local/share/pnpm}"
export PATH="$PNPM_HOME/bin:$PNPM_HOME:$PATH"
mkdir -p "$PNPM_HOME"
exec "$@"
