#!/usr/bin/env bash
# Software Factory: Secure MCP Tunnel helper for the local factory (sf serve).
# Wraps the official tunnel-client with fixed settings; it never prints the runtime key nor the MCP token.
#
#   scripts/sf-tunnel.sh init <tunnel_id>   create/replace the "software-factory" profile
#   scripts/sf-tunnel.sh set-key            store the runtime key from a hidden prompt (0600 file)
#   scripts/sf-tunnel.sh check              verify client, profile, key file and factory (no network calls to OpenAI)
#   scripts/sf-tunnel.sh doctor             set the profile's MCP url, check, then tunnel-client doctor --explain
#   scripts/sf-tunnel.sh run                set the profile's MCP url, check, then run the tunnel daemon (Ctrl+C stops it)
#
# Exit codes: 0 ok, 1 check failed, 2 usage error; run and doctor: the tunnel client's.
#
# The factory's MCP endpoint needs its token (SF-099). This script never reads or holds it: the sf
# CLI ($SF_CLI, else factory/bin/sf of this repository) reads it from the state directory for every
# step that needs it (sf mcp-url --write-profile, --check-profile, --probe, --redact), and every
# message shows the URL as http://127.0.0.1:<port>/mcp/<token>.
set -euo pipefail

PROFILE=software-factory
PROFILE_DIR="${TUNNEL_CLIENT_PROFILE_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/tunnel-client}"
PROFILE_FILE="$PROFILE_DIR/$PROFILE.yaml"
KEY_FILE="${SF_TUNNEL_KEY_FILE:-${XDG_CONFIG_HOME:-$HOME/.config}/software-factory/tunnel-runtime.key}"
HEALTH_ADDR=127.0.0.1:8790
PLACEHOLDER_ID=tunnel_0123456789abcdef0123456789abcdef
ROOT="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/.." && pwd)"
SF=

fail() {
  echo "sf-tunnel: FAIL: $*" >&2
  exit 1
}

ok() {
  echo "sf-tunnel: ok: $*"
}

# The sf CLI; it loads the env file and resolves the state directory and the port itself.
need_cli() {
  [[ -z "$SF" ]] || return 0
  if [[ -n "${SF_CLI:-}" ]]; then
    SF="$SF_CLI"
    return 0
  fi
  [[ -f "$ROOT/factory/dist/src/cli.js" ]] || fail "the factory is not built ($ROOT/factory/dist/src/cli.js is missing): run npm run setup"
  SF="$ROOT/factory/bin/sf"
}

# One sf mcp-url step; its output (never the token) on success, or the failure with it.
mcp_step() {
  local out
  if out="$("$SF" mcp-url "$@" 2>&1)"; then
    [[ -z "$out" ]] || ok "$out"
    return 0
  fi
  if [[ "$out" == *no_mcp_token* ]]; then
    fail "no MCP token yet: start sf serve first (npm run serve), then run this again"
  fi
  fail "${out#sf: }"
}

# The port sf serve uses: SF_PORT, or with SF_PORT=0 the one the running sf serve bound.
mcp_port() {
  local out
  need_cli
  out="$("$SF" mcp-url --port 2>&1)" || fail "${out#sf: }"
  printf '%s\n' "$out"
}

cmd_init() {
  local tunnel_id="${1:-}"
  if [[ ! "$tunnel_id" =~ ^tunnel_[A-Za-z0-9_]+$ ]]; then
    echo "usage: $0 init <tunnel_id>   (tunnel_id starts with tunnel_)" >&2
    exit 2
  fi
  command -v tunnel-client >/dev/null || fail "tunnel-client not found on PATH"
  need_cli
  local port
  port="$(mcp_port)"
  # The plain URL here; the token goes into the profile file only, by the CLI.
  tunnel-client init \
    --sample sample_mcp_remote_no_auth \
    --profile "$PROFILE" \
    --profile-dir "$PROFILE_DIR" \
    --tunnel-id "$tunnel_id" \
    --mcp-server-url "http://127.0.0.1:$port/mcp" \
    --health-listen-addr "$HEALTH_ADDR" \
    --control-plane-api-key-ref "file:$KEY_FILE" \
    --force
  mcp_step --write-profile "$PROFILE_FILE"
}

cmd_set_key() {
  [[ -t 0 ]] || fail "set-key needs an interactive terminal (hidden prompt)"
  local key
  read -rsp "Runtime API key for the tunnel (input hidden): " key
  echo
  [[ -n "$key" ]] || fail "empty key, nothing stored"
  [[ "$key" != tunnel_* ]] || fail "that is a tunnel_id, not the runtime API key; nothing stored"
  mkdir -p "$(dirname "$KEY_FILE")"
  chmod 700 "$(dirname "$KEY_FILE")"
  (umask 077 && printf '%s' "$key" > "$KEY_FILE")
  unset key
  ok "runtime key stored in $KEY_FILE (mode $(stat -c %a "$KEY_FILE"), $(stat -c %s "$KEY_FILE") bytes)"
}

# The first checks: the tunnel client and the profile file.
check_client_and_profile() {
  command -v tunnel-client >/dev/null || fail "tunnel-client not found on PATH"
  ok "tunnel-client $(tunnel-client --version | head -n 1 | cut -d+ -f1)"
  [[ -f "$PROFILE_FILE" ]] || fail "profile missing: $PROFILE_FILE (run: $0 init <tunnel_id>)"
}

# The rest: the profile's content, the key file and the factory's answer to the token.
check_profile_key_factory() {
  need_cli
  local port shown
  port="$(mcp_port)"
  shown="http://127.0.0.1:$port/mcp/<token>"
  grep -q "tunnel_id: \"tunnel_" "$PROFILE_FILE" || fail "profile has no tunnel_id"
  grep -q "$PLACEHOLDER_ID" "$PROFILE_FILE" && fail "profile still has the placeholder tunnel_id"
  mcp_step --check-profile "$PROFILE_FILE"
  grep -q "api_key: \"file:$KEY_FILE\"" "$PROFILE_FILE" || fail "profile api_key is not file:$KEY_FILE"
  ok "profile $PROFILE_FILE (MCP url $shown)"

  [[ -s "$KEY_FILE" ]] || fail "runtime key file missing or empty: $KEY_FILE (run: $0 set-key)"
  [[ "$(stat -c %a "$KEY_FILE")" == "600" ]] || fail "runtime key file must have mode 600: $KEY_FILE"
  # Only the first bytes are inspected, to catch a tunnel_id stored by mistake.
  [[ "$(head -c 7 "$KEY_FILE")" != "tunnel_" ]] || fail "key file holds a tunnel_id, not the runtime API key (run: $0 set-key)"
  ok "runtime key file present (mode 600; content not read)"

  local out status=0
  out="$("$SF" mcp-url --probe 2>&1)" || status=$?
  case "$status" in
    0) ok "$out" ;;
    2) fail "$out (start it: npm run serve)" ;;
    *) fail "${out#sf: }" ;;
  esac
}

# tunnel-client in the background, its stdout and stderr each through sf mcp-url --redact; SIGINT
# and SIGTERM go to it as SIGTERM (a background child of a non-interactive bash ignores SIGINT).
# The filters end at the end of its output; the script exits with the tunnel client's status.
run_client() {
  local out_filter err_filter child status interrupted
  exec 3> >("$SF" mcp-url --redact)
  out_filter=$!
  exec 4> >("$SF" mcp-url --redact >&2)
  err_filter=$!
  tunnel-client "$@" >&3 2>&4 &
  child=$!
  exec 3>&- 4>&-
  trap 'interrupted=1; kill -TERM "$child" 2>/dev/null || true' INT TERM
  # A trapped signal ends wait early (above 128); wait again for the client's own status (bash
  # keeps it once the client has ended).
  while :; do
    interrupted=0
    status=0
    wait "$child" || status=$?
    ((interrupted)) || break
  done
  trap - INT TERM
  while kill -0 "$out_filter" 2>/dev/null || kill -0 "$err_filter" 2>/dev/null; do
    sleep 0.05
  done
  exit "$status"
}

case "${1:-}" in
  init)
    shift
    cmd_init "$@"
    ;;
  set-key)
    cmd_set_key
    ;;
  check)
    check_client_and_profile
    check_profile_key_factory
    ;;
  doctor)
    check_client_and_profile
    need_cli
    mcp_step --write-profile "$PROFILE_FILE"
    check_profile_key_factory
    run_client doctor --profile "$PROFILE" --profile-dir "$PROFILE_DIR" --explain
    ;;
  run)
    check_client_and_profile
    need_cli
    mcp_step --write-profile "$PROFILE_FILE"
    check_profile_key_factory
    run_client run --profile "$PROFILE" --profile-dir "$PROFILE_DIR"
    ;;
  *)
    sed -n '2,11p' "$0" >&2
    exit 2
    ;;
esac
