#!/usr/bin/env bash
# Software Factory SF-009: automatic execution of ChatGPT-authorized jobs
# (see docs/runbooks/SF-009-autonomous-session-loop.md). Linux only. Builds nothing,
# installs nothing and opens no network listener.
#
#   scripts/sf009-executor.sh enable --app <app-id> --disposable-pilot [--protect <path>]...
#                                                                            one-time opt-in for one DISPOSABLE pilot app (asks to confirm);
#                                                                            refused without --disposable-pilot (no enforceable sandbox)
#   scripts/sf009-executor.sh enable --app <app-id> --self-hosting [--protect <path>]...
#                                                                            separate opt-in: the app whose APP_REPO is THIS checkout
#                                                                            works on it beside your uncommitted work (unconfined; asks)
#   scripts/sf009-executor.sh disable [--app <app-id>]                       withdraw one app, or everything
#   scripts/sf009-executor.sh status [--app <id>] [--job <id>] [--all]       policy, supervisor and jobs (read-only)
#   scripts/sf009-executor.sh watch [--app <id>] [--job <id>] [--interval <s>]
#                                                                            the same, refreshed until Ctrl+C (read-only)
#   scripts/sf009-executor.sh observe --app <id> --job <id> [--once]        the job's managed Claude session as readable text: recent
#                                                                            history, then new records until Ctrl+C (read-only; --once
#                                                                            prints the history and exits)
#   scripts/sf009-executor.sh accept --app <app-id> --job <job-id>          your final acceptance of the current snapshot
#   scripts/sf009-executor.sh run                                            the supervisor, in this terminal, until Ctrl+C
#   scripts/sf009-executor.sh render-unit <new-dir>                          a systemd user unit for you to install, if you choose
#   scripts/sf009-executor.sh probe-protocol --dir <empty-dir> [--overlap]   one real Claude Code protocol probe (asks to confirm;
#                                                                            only after the managed session ended; see the runbook)
set -euo pipefail
cli=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/bridge/dist/src/executor/main.js
[[ -f $cli ]] || { echo "build the bridge first: (cd bridge && npm run build)" >&2; exit 1; }
exec node "$cli" "$@"
