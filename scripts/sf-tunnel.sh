#!/usr/bin/env bash
# Software Factory: Secure MCP Tunnel helper for the local bridge (SF-002).
# Wraps the official tunnel-client with fixed settings; it never prints the runtime key.
#
#   scripts/sf-tunnel.sh init <tunnel_id>   create/replace the "software-factory" profile
#   scripts/sf-tunnel.sh set-key            store the runtime key from a hidden prompt (0600 file)
#   scripts/sf-tunnel.sh check              verify client, profile, key file and bridge (no network calls to OpenAI)
#   scripts/sf-tunnel.sh doctor             tunnel-client doctor --explain for the profile
#   scripts/sf-tunnel.sh run                check, then run the tunnel daemon in the foreground (Ctrl+C stops it)
#
# Exit codes: 0 ok, 1 check failed, 2 usage error.
set -euo pipefail

PROFILE=software-factory
PROFILE_DIR="${TUNNEL_CLIENT_PROFILE_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/tunnel-client}"
PROFILE_FILE="$PROFILE_DIR/$PROFILE.yaml"
KEY_FILE="${SF_TUNNEL_KEY_FILE:-${XDG_CONFIG_HOME:-$HOME/.config}/software-factory/tunnel-runtime.key}"
MCP_URL=http://127.0.0.1:8787/mcp
HEALTH_ADDR=127.0.0.1:8790
PLACEHOLDER_ID=tunnel_0123456789abcdef0123456789abcdef

fail() {
  echo "sf-tunnel: FAIL: $*" >&2
  exit 1
}

ok() {
  echo "sf-tunnel: ok: $*"
}

cmd_init() {
  local tunnel_id="${1:-}"
  if [[ ! "$tunnel_id" =~ ^tunnel_[A-Za-z0-9_]+$ ]]; then
    echo "usage: $0 init <tunnel_id>   (tunnel_id starts with tunnel_)" >&2
    exit 2
  fi
  command -v tunnel-client >/dev/null || fail "tunnel-client not found on PATH"
  tunnel-client init \
    --sample sample_mcp_remote_no_auth \
    --profile "$PROFILE" \
    --profile-dir "$PROFILE_DIR" \
    --tunnel-id "$tunnel_id" \
    --mcp-server-url "$MCP_URL" \
    --health-listen-addr "$HEALTH_ADDR" \
    --control-plane-api-key-ref "file:$KEY_FILE" \
    --force
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

cmd_check() {
  command -v tunnel-client >/dev/null || fail "tunnel-client not found on PATH"
  ok "tunnel-client $(tunnel-client --version | head -n 1 | cut -d+ -f1)"

  [[ -f "$PROFILE_FILE" ]] || fail "profile missing: $PROFILE_FILE (run: $0 init <tunnel_id>)"
  grep -q "tunnel_id: \"tunnel_" "$PROFILE_FILE" || fail "profile has no tunnel_id"
  grep -q "$PLACEHOLDER_ID" "$PROFILE_FILE" && fail "profile still has the placeholder tunnel_id"
  grep -q "url: \"$MCP_URL\"" "$PROFILE_FILE" || fail "profile MCP url is not $MCP_URL"
  grep -q "api_key: \"file:$KEY_FILE\"" "$PROFILE_FILE" || fail "profile api_key is not file:$KEY_FILE"
  ok "profile $PROFILE_FILE"

  [[ -s "$KEY_FILE" ]] || fail "runtime key file missing or empty: $KEY_FILE (run: $0 set-key)"
  [[ "$(stat -c %a "$KEY_FILE")" == "600" ]] || fail "runtime key file must have mode 600: $KEY_FILE"
  # Only the first bytes are inspected, to catch a tunnel_id stored by mistake.
  [[ "$(head -c 7 "$KEY_FILE")" != "tunnel_" ]] || fail "key file holds a tunnel_id, not the runtime API key (run: $0 set-key)"
  ok "runtime key file present (mode 600; content not read)"

  local status
  status="$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "$MCP_URL" || true)"
  [[ "$status" != "000" ]] || fail "bridge not reachable at $MCP_URL (start it: cd bridge && npm start)"
  ok "bridge answers at $MCP_URL (HTTP $status for a plain GET)"
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
    cmd_check
    ;;
  doctor)
    cmd_check
    exec tunnel-client doctor --profile "$PROFILE" --profile-dir "$PROFILE_DIR" --explain
    ;;
  run)
    cmd_check
    # exec hands SIGINT/SIGTERM straight to tunnel-client.
    exec tunnel-client run --profile "$PROFILE" --profile-dir "$PROFILE_DIR"
    ;;
  *)
    sed -n '2,11p' "$0" >&2
    exit 2
    ;;
esac
