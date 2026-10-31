#!/usr/bin/env bash
# Software Factory SF-007 demo: the operator console in this terminal against a
# throwaway mediator, a throwaway app repository, a fake `claude`, a stub
# OpenClaw receiver and its own session gate. Touches no real job, app,
# OpenClaw or Claude Code. Removed again when the console ends (q).
#
#   scripts/sf007-demo.sh [--keep]
set -euo pipefail
cli=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/bridge/dist/src/operator/demo.js
[[ -f $cli ]] || { echo "build the bridge first: (cd bridge && npm run build)" >&2; exit 1; }
exec node "$cli" "$@"
