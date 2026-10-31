#!/usr/bin/env bash
# Software Factory SF-007: local operator queue (see docs/runbooks/SF-007-local-operator.md).
# Linux only. Builds nothing, installs nothing and opens no network listener.
#
#   scripts/sf007-operator.sh [console]             the operator console in this terminal (approve, later, reject)
#   scripts/sf007-operator.sh status                 read-only queue listing
#   scripts/sf007-operator.sh render-assets <dir>    optional desktop launcher that opens the console, for you to install
set -euo pipefail
cli=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/bridge/dist/src/operator/main.js
[[ -f $cli ]] || { echo "build the bridge first: (cd bridge && npm run build)" >&2; exit 1; }
exec node "$cli" "$@"
