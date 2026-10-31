#!/usr/bin/env bash
# Software Factory SF-010: the independent review coordinator (offline foundation; see
# docs/runbooks/SF-010-reviewer-foundation.md). Linux only. Builds nothing, installs nothing,
# opens no network listener and calls no model API. Real operation is disabled: this build has no
# review provider, so provider-enable and run refuse.
#
#   scripts/sf010-reviewer.sh status [--app <id>] [--job <id>]      read-only (creates nothing)
#   scripts/sf010-reviewer.sh dry-run --app <id> --job <id>          read-only: what a coordinator would do now
#   scripts/sf010-reviewer.sh provider-enable --provider <id>        refused: no provider in this build
#   scripts/sf010-reviewer.sh delegate --app <id> --job <id> --provider <id> --max-attempts <n> --max-reviews <n>
#                                      --max-minutes <n> --max-input-kib <n> --attempt-timeout-s <n> --expires-minutes <n>
#   scripts/sf010-reviewer.sh revoke --app <id> --job <id>
#   scripts/sf010-reviewer.sh run                                    refused without an enabled provider of this build
#
# SF010_BRIDGE_DIST selects a build directory inside bridge/ (default: dist), e.g.
# SF010_BRIDGE_DIST=sf010-reviewer-validation-dist for the validation build.
set -euo pipefail
dist=${SF010_BRIDGE_DIST:-dist}
[[ $dist =~ ^[A-Za-z0-9._-]+$ ]] || { echo "SF010_BRIDGE_DIST must be a directory name inside bridge/" >&2; exit 2; }
cli=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/bridge/$dist/src/reviewer/main.js
[[ -f $cli ]] || { echo "build the bridge first (bridge/$dist/src/reviewer/main.js is missing)" >&2; exit 1; }
exec node "$cli" "$@"
