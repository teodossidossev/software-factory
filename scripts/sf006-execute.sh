#!/usr/bin/env bash
# Software Factory SF-006: one-shot host execution adapter (see docs/runbooks/claude-execution.md).
# Linux only. Builds nothing and changes nothing by itself; every writing step asks first.
#
#   scripts/sf006-execute.sh <preflight|prepare|run|handoff|collect|status> <app-id> <job-id>
set -euo pipefail
cli=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/bridge/dist/src/execution/cli.js
[[ -f $cli ]] || { echo "build the bridge first: (cd bridge && npm run build)" >&2; exit 1; }
exec node "$cli" "$@"
