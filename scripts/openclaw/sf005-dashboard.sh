#!/usr/bin/env bash
# Software Factory SF-005-UI: the OpenClaw Dashboard (Control UI) at
# http://127.0.0.1:18789/ on this host, with the gateway container unchanged at
# network_mode: none. Linux hosts only.
#
#   scripts/openclaw/sf005-dashboard.sh <step>
#
# Steps:
#   enable    backs up openclaw.json in the volume, then sets the keys of
#             config/openclaw/profiles/dashboard.json5 with `openclaw config
#             set`; asks first
#   forward   runs the host-loopback forwarder in the foreground (Ctrl+C stops)
#   pair      interactive terminal only: prints a one-time pairing link for
#             this host's browser to the terminal; never logged
#   verify    required checks for the dashboard profile: container isolation,
#             config profile, HTTP, WebSocket auth, loopback-only, no egress
#   status    read-only: profile, forwarder, paired devices
#   disable   rollback: backs up openclaw.json, then removes the dashboard keys
#             again (offline profile = SF-004); asks first; keeps the volume
#
# Never prints the gateway token or a pairing link into a log. No automatic
# start; the forwarder runs only while `forward` runs.
set -euo pipefail

# shellcheck source=scripts/openclaw/sf005-dispatch.sh
source "$(dirname "${BASH_SOURCE[0]}")/sf005-dispatch.sh"

FORWARDER=$REPO_ROOT/scripts/openclaw/dashboard-forward.mjs
WS_CHECK=$REPO_ROOT/scripts/openclaw/dashboard-ws-check.mjs
BACKUP_DIR=/home/node/.openclaw/backups
DASHBOARD_URL=http://127.0.0.1:$GATEWAY_PORT/

# HTTP status of a path on the Gateway's in-container loopback listener (0 = no answer).
in_container_status() {
  in_container "node -e 'fetch(\"http://127.0.0.1:$GATEWAY_PORT$1\").then((r) => console.log(r.status), () => console.log(0))'"
}

ui_enabled() { in_container "node openclaw.mjs config get gateway.controlUi.enabled 2>/dev/null" | tail -1; }

# Copies openclaw.json inside the volume (0600 in a 0700 directory); prints the copy's sha256 and path.
backup_config() {
  local name
  name=openclaw.json.$(date -u +%Y%m%dT%H%M%SZ).$1
  in_container "umask 077 && mkdir -p $BACKUP_DIR && cp $LIVE_CONFIG $BACKUP_DIR/$name && sha256sum $BACKUP_DIR/$name"
}

# The keys of config/openclaw/profiles/dashboard.json5; everything else stays.
# check_config afterwards confirms that the live config matches the profile.
apply_dashboard() {
  in_container "node openclaw.mjs config set --batch-json '[{\"path\":\"gateway.controlUi.enabled\",\"value\":true},{\"path\":\"gateway.controlUi.automaticallyFetchFavicons\",\"value\":false}]'"
}

remove_dashboard() {
  in_container "node openclaw.mjs config set gateway.controlUi.enabled false && node openclaw.mjs config unset gateway.controlUi.automaticallyFetchFavicons"
}

# Waits until GET / inside the container answers $1 (200 with the UI, 404 without);
# restarts the container after confirmation if the change was not applied live.
wait_for_root() {
  local expected=$1 attempt status
  for attempt in $(seq 1 15); do
    # A stopped gateway makes docker exec fail; that is handled by the restart below.
    status=$(in_container_status /) || status=0
    [[ $status == "$expected" ]] && { pass "GET / answers $expected inside the container"; return 0; }
    sleep 2
  done
  echo "GET / still answers $status after the config change."
  confirm "Will restart the gateway container (docker compose restart; the volume, token and automations stay)."
  dc restart "$SERVICE"
  wait_until_healthy
  status=$(in_container_status /) || status=0
  [[ $status == "$expected" ]] && pass "GET / answers $expected after restart" || fail "GET / answers $status, expected $expected"
}

forwarder_listeners() { ss -Hltn "sport = :$GATEWAY_PORT" | awk '{print $4}'; }

step_enable() {
  section "enable dashboard profile"
  in_container true >/dev/null || die "the gateway container is not running; run sf004-docker.sh up first"
  echo "Control UI enabled now: $(ui_enabled)"
  confirm "Will change only $LIVE_CONFIG in the volume:
- back it up to $BACKUP_DIR/openclaw.json.<UTC time>.pre-dashboard (0600)
- openclaw config set gateway.controlUi.enabled true, gateway.controlUi.automaticallyFetchFavicons false
  (config/openclaw/profiles/dashboard.json5)
- restart the container only if the Gateway does not apply the change live (asks again)
The container keeps network_mode: none; no port is published. The Dashboard becomes
reachable on this host through the 'forward' step."
  backup_config pre-dashboard
  apply_dashboard
  wait_for_root 200
  check_config dashboard
  finish
}

step_disable() {
  section "disable dashboard (rollback to the offline profile)"
  in_container true >/dev/null || die "the gateway container is not running"
  echo "Control UI enabled now: $(ui_enabled)"
  confirm "Will change only $LIVE_CONFIG in the volume:
- back it up to $BACKUP_DIR/openclaw.json.<UTC time>.pre-offline (0600)
- openclaw config set gateway.controlUi.enabled false and
  openclaw config unset gateway.controlUi.automaticallyFetchFavicons (back to SF-004)
- restart the container only if the Gateway does not apply the change live (asks again)
Kept: the volume, gateway token, receiver, automations, accepted requests, paired-device
records and earlier backups. Stop a running 'forward' step yourself (Ctrl+C)."
  backup_config pre-offline
  remove_dashboard
  wait_for_root 404
  check_config offline
  if [[ -n $(forwarder_listeners) ]]; then
    finding "a process still listens on $GATEWAY_PORT on this host; stop the 'forward' step (Ctrl+C)"
  fi
  info "node openclaw.mjs devices list"
  finish
}

step_forward() {
  exec node "$FORWARDER"
}

step_pair() {
  [[ -t 0 && -t 1 ]] || die "pair needs an interactive terminal; it never writes the link to a file or pipe"
  [[ -n $(forwarder_listeners) ]] || die "the forwarder is not running; start 'sf005-dashboard.sh forward' in another terminal"
  # Printed to the terminal only: passing it to a browser as an argument would show it in the process list.
  # Plain `openclaw dashboard` only offers the link through a clipboard, which the
  # container does not have, so the link is taken from --json.
  local url
  url=$(dc exec -T "$SERVICE" node openclaw.mjs dashboard --no-open --json </dev/null |
    node -e 'let s="";process.stdin.on("data",(d)=>(s+=d)).on("end",()=>{try{process.stdout.write(JSON.parse(s).browserUrl??"")}catch{}})') || true
  [[ $url == "$DASHBOARD_URL"* ]] || die "openclaw dashboard did not return a pairing link for $DASHBOARD_URL"
  echo "One-time pairing link for this host's browser (valid 10 minutes, single use; do not share or save it):"
  echo
  echo "$url"
  echo
  url=
}

step_status() {
  section "status"
  echo "Control UI enabled: $(ui_enabled)"
  check_config
  local listeners
  listeners=$(forwarder_listeners)
  echo "host listeners on $GATEWAY_PORT: ${listeners:-none}"
  info "node openclaw.mjs devices list"
  finish
}

step_verify() {
  section "verify: container isolation (unchanged from SF-004)"
  [[ -n $(container_id) ]] || die "no container"
  expect_inspect "running" '{{.State.Status}}' running
  expect_inspect "image digest" '{{.Config.Image}}' "$IMAGE"
  expect_inspect "network mode" '{{.HostConfig.NetworkMode}}' none
  expect_inspect "no published ports" '{{json .HostConfig.PortBindings}}' '{}'
  expect_inspect "read-only root fs" '{{.HostConfig.ReadonlyRootfs}}' true
  expect_inspect "capabilities dropped" '{{json .HostConfig.CapDrop}}' '["ALL"]'
  expect_inspect "no-new-privileges" '{{json .HostConfig.SecurityOpt}}' '["no-new-privileges:true"]'
  expect_inspect "restart policy" '{{.HostConfig.RestartPolicy.Name}}' no
  expect_inspect "only the state volume is mounted" \
    '{{range .Mounts}}{{.Type}}:{{.Name}}:{{.Destination}} {{end}}' "volume:${PROJECT}_home:/home/node "
  must "no egress: internet, LAN and Docker host addresses unreachable" 'node -e "
const net = require(\"net\");
const targets = [[\"1.1.1.1\", 443], [\"192.168.0.1\", 80], [\"172.17.0.1\", 445]];
let left = targets.length, reached = 0;
for (const [host, port] of targets) {
  const s = net.connect({ host, port, timeout: 3000 });
  const done = (r) => { console.log(host + \":\" + port + \" \" + r); if (r === \"CONNECTED\") reached++; s.destroy(); if (--left === 0) process.exit(reached ? 1 : 0); };
  s.on(\"connect\", () => done(\"CONNECTED\")); s.on(\"error\", (e) => done(e.code)); s.on(\"timeout\", () => done(\"timeout\"));
}"'

  section "verify: dashboard profile"
  check_config dashboard
  must "/healthz" 'node -e "fetch(\"http://127.0.0.1:18789/healthz\").then((r) => { console.log(r.status); process.exit(r.ok ? 0 : 1) }, () => process.exit(1))"'
  must "GET / serves the Control UI" 'node -e "fetch(\"http://127.0.0.1:18789/\").then(async (r) => { const t = await r.text(); console.log(r.status, r.headers.get(\"content-type\"), t.includes(\"<openclaw-app\")); process.exit(r.status === 200 && t.includes(\"<openclaw-app\") ? 0 : 1) }, () => process.exit(1))"'
  must "runtime config endpoint refuses unauthenticated requests" 'node -e "fetch(\"http://127.0.0.1:18789/control-ui-config.json\").then((r) => { console.log(r.status); process.exit(r.status === 401 || r.status === 403 ? 0 : 1) }, () => process.exit(1))"'
  must "operator terminal, CLI agents, HTTP model endpoints, plugins, hooks, cron, ACP and browser stay off" \
    'for k in gateway.terminal.enabled gateway.cliAgents.enabled gateway.http.endpoints.chatCompletions.enabled gateway.http.endpoints.responses.enabled plugins.enabled hooks.enabled cron.enabled acp.enabled browser.enabled; do v=$(node openclaw.mjs config get $k 2>/dev/null | tail -1); echo "$k=$v"; [ "$v" = false ] || exit 1; done'

  section "verify: host-loopback access"
  local listeners address status
  listeners=$(forwarder_listeners)
  if [[ -z $listeners ]]; then
    fail "nothing listens on $GATEWAY_PORT on this host; start 'sf005-dashboard.sh forward'"
  else
    while read -r address; do
      [[ $address == "127.0.0.1:$GATEWAY_PORT" ]] && pass "host listener $address is loopback only" || fail "host listener $address is not 127.0.0.1"
    done <<<"$listeners"
    status=$(curl -s -o /dev/null -w '%{http_code}' -m 10 "$DASHBOARD_URL" || true)
    [[ $status == 200 ]] && pass "$DASHBOARD_URL answers 200 on this host" || fail "$DASHBOARD_URL answers '$status'"
    for address in $(ip -4 -o addr show scope global | awk '{print $4}' | cut -d/ -f1); do
      curl -s -o /dev/null -m 3 "http://$address:$GATEWAY_PORT/" && fail "reachable via $address" || pass "not reachable via $address"
    done
    local result token
    result=$(node "$WS_CHECK" no-token) || true
    echo "$result"
    [[ $result == *'"ok":false'* ]] && pass "WebSocket without credentials is refused" || fail "WebSocket without credentials was not refused"
    result=$(node "$WS_CHECK" wrong-token) || true
    echo "$result"
    [[ $result == *'"details":"AUTH_TOKEN_MISMATCH"'* ]] && pass "WebSocket with a wrong token is refused" || fail "WebSocket with a wrong token was not refused as a token mismatch"
    # The token goes from the volume into this variable and the probe's environment only:
    # not into the log, not into any argv (environments are readable only by this uid).
    token=$(dc exec -T "$SERVICE" cat /home/node/.openclaw/secrets/gateway-token </dev/null) || token=
    result=$(SF_GATEWAY_TOKEN=$token node "$WS_CHECK" token) || true
    token=
    echo "$result"
    [[ $result != *AUTH_TOKEN_MISMATCH* && $result != *'"error"'* ]] &&
      pass "WebSocket with the gateway token passes token auth (device identity/pairing decides the rest)" ||
      fail "WebSocket with the gateway token failed token auth"
  fi
  audit_checks
  finish
}

sf005_dashboard_main() {
  local step=${1:-}
  case $step in
    enable | disable | verify | status) ;;
    forward) step_forward ;;
    pair) step_pair; exit ;;
    *) sed -n '2,22p' "$0"; exit 2 ;;
  esac
  mkdir -p "$LOG_DIR"
  "step_$step" 2>&1 | tee -a "$LOG_DIR/sf005-dashboard-$step.log"
}

[[ ${BASH_SOURCE[0]} != "$0" ]] || sf005_dashboard_main "$@"
