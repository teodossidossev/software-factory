#!/usr/bin/env bash
# Software Factory: run and verify the locked-down OpenClaw Gateway container
# defined in deploy/openclaw/compose.yaml. Linux hosts only. Run as a user that
# can use Docker:
#
#   scripts/openclaw/sf004-docker.sh <step>
#
# Steps, in order. Each step that changes something prints it and asks first:
#   preflight   read-only: Docker/Compose prerequisites, compose validation and
#               security findings of this machine (reported only, never fixed)
#   pull        docker pull of the digest-pinned image + label/digest checks
#   init        token + config written inside the state volume (no host files);
#               re-runnable, never replaces or deletes existing state
#   up          start the container and wait until it is healthy
#   verify      required checks: container hardening, health, status, doctor,
#               security audit, listeners; plus a statement of the access paths
#   lifecycle   stop, start, restart with required checks; state must persist
#   tokenscan   the gateway token must not occur in any step log or container log
#   down        stop and remove the container (keeps the state volume)
#
# Settings (environment variables, all optional):
#   SF_OPENCLAW_LOG_DIR   step logs (default: $XDG_STATE_HOME/software-factory/openclaw/logs)
#
# It never mounts host paths, never publishes ports, never touches the Docker
# daemon configuration, and never removes the state volume. It never prints the
# gateway token. A step exits non-zero when any required check fails.
set -euo pipefail

REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
COMPOSE_FILE=$REPO_ROOT/deploy/openclaw/compose.yaml
CONFIG_FILE=$REPO_ROOT/config/openclaw/openclaw.json5
PROJECT=software-factory-openclaw
SERVICE=gateway
OPENCLAW_VERSION=2026.10.7
OPENCLAW_REVISION=157d8c2bc3ea2fa183afdc11088e69690bf8e64e
IMAGE_REPO=ghcr.io/openclaw/openclaw
IMAGE_DIGEST=sha256:fb26f0841659dc757f23feec9adeab51f11d76779a409db5d22e191b43841afa
IMAGE=$IMAGE_REPO:$OPENCLAW_VERSION@$IMAGE_DIGEST
CONTAINER_UID=1000
GATEWAY_PORT=18789

OP_HOME=$(getent passwd "$(id -un)" | cut -d: -f6)
LOG_DIR=${SF_OPENCLAW_LOG_DIR:-${XDG_STATE_HOME:-$OP_HOME/.local/state}/software-factory/openclaw/logs}

die() { echo "ERROR: $*" >&2; exit 1; }
section() { printf '\n===== %s (%s)\n' "$*" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"; }
finding() { echo "FINDING: $*"; }

FAILURES=0
pass() { echo "[PASS] $*"; }
fail() { echo "[FAIL] $*"; FAILURES=$((FAILURES + 1)); }
finish() {
  if ((FAILURES > 0)); then
    echo "STEP FAILED: $FAILURES required check(s) failed"
    return 1
  fi
  echo "STEP OK"
}

confirm() {
  printf '\n%s\nContinue? [y/N] ' "$1"
  local answer
  read -r answer </dev/tty
  [[ $answer == y || $answer == Y ]] || die "aborted by user"
}

dc() { docker compose -f "$COMPOSE_FILE" -p "$PROJECT" "$@"; }

container_id() { dc ps -a -q "$SERVICE"; }

# Runs a shell command line inside the running gateway container as its user.
in_container() { dc exec -T "$SERVICE" sh -c "$1"; }

# Runs a shell command line in a one-off container with the same volume and no network,
# for steps before the gateway runs. The image entrypoint passes non-gateway commands through.
one_off() { dc run --rm -T --no-deps --entrypoint sh "$SERVICE" -c "$1"; }

# Required check inside the container: passes only on exit 0. A docker failure
# also exits non-zero, so a command whose own "good" exit is 1 must translate it.
must() {
  local description=$1 command=$2 rc=0
  echo "\$ $command"
  in_container "$command" || rc=$?
  if ((rc == 0)); then pass "$description"; else fail "$description (exit $rc)"; fi
}

info() {
  local rc=0
  echo "\$ $1"
  in_container "$1" || rc=$?
  echo "[info exit $rc]"
}

inspect() { docker inspect -f "$1" "$(container_id)"; }

expect_inspect() {
  local description=$1 format=$2 expected=$3 actual
  actual=$(inspect "$format" 2>&1 || true)
  if [[ $actual == "$expected" ]]; then pass "$description ($actual)"; else fail "$description: got '$actual', expected '$expected'"; fi
}

wait_until_healthy() {
  local attempt status
  for attempt in $(seq 1 150); do
    status=$(inspect '{{.State.Status}}/{{.State.Health.Status}}' 2>/dev/null || echo missing)
    if [[ $status == running/healthy ]]; then
      pass "container healthy after ~$((attempt * 2))s"
      return 0
    fi
    # A stopped container keeps its last health status, so check the state too.
    [[ $status == running/starting ]] || break
    sleep 2
  done
  fail "container not healthy (status: $status)"
  dc logs --no-color --tail 40 "$SERVICE" || true
}

# Prints "address:port" of every TCP LISTEN socket inside the container (from /proc).
container_listeners() {
  in_container 'node -e '\''
const fs = require("fs");
for (const [file, v6] of [["/proc/net/tcp", false], ["/proc/net/tcp6", true]]) {
  let lines = [];
  try { lines = fs.readFileSync(file, "utf8").trim().split("\n").slice(1); } catch {}
  for (const line of lines) {
    const [local, , state] = line.trim().split(/\s+/).slice(1, 4);
    if (state !== "0A") continue;
    const [hex, portHex] = local.split(":");
    const port = parseInt(portHex, 16);
    const v4 = (h) => h.match(/../g).reverse().map((b) => parseInt(b, 16)).join(".");
    let address;
    if (!v6) address = v4(hex);
    else if (hex.startsWith("0000000000000000FFFF0000")) address = "[::ffff:" + v4(hex.slice(24)) + "]";
    else address = "[" + (hex === "00000000000000000000000001000000" ? "::1" : hex === "0".repeat(32) ? "::" : hex) + "]";
    console.log(address + ":" + port);
  }
}'\'''
}

step_preflight() {
  section "preflight (read-only)"
  echo "operator: $(id -un) uid=$(id -u)"
  echo "compose file: $COMPOSE_FILE"
  echo "image: $IMAGE"
  echo "logs: $LOG_DIR"

  section "prerequisites"
  command -v docker >/dev/null && pass "docker CLI $(docker version --format '{{.Client.Version}}' 2>/dev/null)" || { fail "docker CLI missing"; finish; return 1; }
  local server
  server=$(docker version --format '{{.Server.Version}}' 2>/dev/null) && pass "Docker Engine $server reachable" || fail "Docker Engine not reachable for $(id -un)"
  local compose
  compose=$(docker compose version --short 2>/dev/null) && pass "Docker Compose v2 ($compose)" || fail "Docker Compose v2 plugin missing"
  case $(uname -m) in
    x86_64 | aarch64 | arm64) pass "architecture $(uname -m) has an official image" ;;
    *) fail "architecture $(uname -m) has no official image" ;;
  esac
  dc config --quiet && pass "compose file valid" || fail "compose file invalid"
  [[ -f $CONFIG_FILE ]] && pass "config file present" || fail "missing $CONFIG_FILE"
  docker image inspect "$IMAGE" >/dev/null 2>&1 && echo "image present locally" || echo "image not pulled yet"
  docker volume inspect "${PROJECT}_home" >/dev/null 2>&1 && echo "state volume ${PROJECT}_home exists" || echo "state volume not created yet"
  [[ -n $(container_id 2>/dev/null) ]] && echo "container exists: $(container_id)" || echo "no container yet"

  section "machine security findings (reported only, never changed)"
  local security
  security=$(docker info --format '{{join .SecurityOptions " "}}' 2>/dev/null || true)
  echo "daemon security options: $security"
  if [[ $security == *rootless* ]]; then
    echo "rootless Docker: container uid $CONTAINER_UID maps to an unprivileged subordinate uid"
  elif [[ $security == *userns* ]]; then
    echo "userns-remap active: container uid $CONTAINER_UID is remapped on the host"
  else
    local host_user
    host_user=$(getent passwd "$CONTAINER_UID" | cut -d: -f1 || true)
    [[ -n $host_user ]] && finding "container runs as uid $CONTAINER_UID, which is host user '$host_user' (no userns-remap/rootless); after a container escape the process would have that user's file access"
  fi
  [[ " $(id -nG) " == *" docker "* ]] && finding "$(id -un) is in the docker group, which is root-equivalent on this host"
  [[ -z $(ss -Hltn "sport = :$GATEWAY_PORT" 2>/dev/null) ]] || finding "a host process already listens on port $GATEWAY_PORT (not used by this setup, which publishes no ports)"
  finish
}

step_pull() {
  section "pull"
  confirm "Will run:
  docker pull $IMAGE
(downloads the official image; Docker verifies the content against the pinned digest)"
  docker pull "$IMAGE"
  local repo_digests
  repo_digests=$(docker image inspect --format '{{join .RepoDigests " "}}' "$IMAGE")
  [[ $repo_digests == *"$IMAGE_REPO@$IMAGE_DIGEST"* ]] && pass "repo digest $IMAGE_DIGEST" || fail "repo digests: $repo_digests"
  local label
  label=$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.version"}}' "$IMAGE")
  [[ $label == "$OPENCLAW_VERSION" ]] && pass "image version label $label" || fail "image version label '$label'"
  label=$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$IMAGE")
  [[ $label == "$OPENCLAW_REVISION" ]] && pass "image revision label $label" || fail "image revision label '$label'"
  label=$(docker image inspect --format '{{.Config.User}}' "$IMAGE")
  [[ $label == node ]] && pass "image user node" || fail "image user '$label'"
  finish
}

# Prints "token=<missing|ok|invalid> config=<missing|sha256>" for the state volume
# without printing the token. Only call it when the volume already exists.
volume_state() {
  one_off '
    token=missing
    if [ -e ~/.openclaw/secrets/gateway-token ]; then
      token=invalid
      [ "$(stat -c "%a %s" ~/.openclaw/secrets/gateway-token)" = "600 64" ] &&
        grep -qxE "[0-9a-f]{64}" ~/.openclaw/secrets/gateway-token && token=ok
    fi
    config=missing
    [ -e ~/.openclaw/openclaw.json ] && config=$(sha256sum < ~/.openclaw/openclaw.json | cut -d" " -f1)
    echo "token=$token config=$config"'
}

# Safe to re-run after a partial failure: creates only what is missing, writes
# through a fresh ".partial" file (a leftover one is never live state and is
# replaced) and links it into place without replacing anything,
# and stops on an existing token or config it cannot accept. It never deletes state.
step_init() {
  section "init"
  docker image inspect "$IMAGE" >/dev/null 2>&1 || die "run the pull step first"
  local volume=${PROJECT}_home state="token=missing config=missing" wanted
  wanted=$(sha256sum <"$CONFIG_FILE" | cut -d' ' -f1)
  # docker volume inspect never creates the volume; one-off containers would.
  if docker volume inspect "$volume" >/dev/null 2>&1; then
    state=$(volume_state) || die "could not read the existing volume $volume"
    echo "existing volume $volume: $state"
  else
    echo "volume $volume does not exist yet"
  fi
  local token=${state#token=}
  token=${token%% *}
  local config=${state#*config=}
  [[ $token != invalid ]] || die "existing token file is not 64 hex bytes with mode 600; not touching it. Inspect it manually; this step never deletes state."
  if [[ $config != missing && $config != "$wanted" ]]; then
    die "existing openclaw.json differs from config/openclaw/openclaw.json5 (sha256 $config, expected $wanted); not overwriting. The gateway's doctor may rewrite it after up; init is only needed once."
  fi
  if [[ $token == ok && $config == "$wanted" ]]; then
    pass "token and config already in place"
  else
    confirm "Will run one-off containers (no network, same hardening) that:
  create the named volume $volume if missing (Docker volume, not a host path)
  $([[ $token == ok ]] && echo "keep the existing gateway token" || echo "generate /home/node/.openclaw/secrets/gateway-token (32 random bytes as hex, 0600, never printed)")
  $([[ $config == "$wanted" ]] && echo "keep the existing openclaw.json" || echo "write /home/node/.openclaw/openclaw.json (0600) from config/openclaw/openclaw.json5 via stdin")
Existing files are never replaced or deleted."
    one_off 'umask 077 && mkdir -p ~/.openclaw/secrets && chmod 0700 ~/.openclaw ~/.openclaw/secrets'
    if [[ $token != ok ]]; then
      one_off 'umask 077 && cd ~/.openclaw/secrets &&
        rm -f gateway-token.partial && head -c 32 /dev/urandom | od -An -tx1 | tr -d " \n" > gateway-token.partial &&
        ln gateway-token.partial gateway-token && rm gateway-token.partial'
    fi
    if [[ $config != "$wanted" ]]; then
      one_off 'umask 077 && cd ~/.openclaw && rm -f openclaw.json.partial && cat > openclaw.json.partial &&
        ln openclaw.json.partial openclaw.json && rm openclaw.json.partial' <"$CONFIG_FILE"
    fi
  fi
  state=$(volume_state) || die "could not read the volume after init"
  [[ $state == "token=ok config=$wanted" ]] && pass "token (600, 64 hex) and config (sha256 $wanted) in place" || fail "unexpected state: $state"
  local rc=0
  one_off 'test "$(stat -c %a ~/.openclaw/openclaw.json)" = 600' || rc=$?
  ((rc == 0)) && pass "config mode 600" || fail "config mode"
  rc=0
  one_off 'node openclaw.mjs config validate' || rc=$?
  ((rc == 0)) && pass "config validates" || fail "config validate (exit $rc)"
  finish
}

step_up() {
  section "up"
  docker image inspect "$IMAGE" >/dev/null 2>&1 || die "run the pull step first"
  confirm "Will run:
  docker compose -f deploy/openclaw/compose.yaml -p $PROJECT up -d
(starts the gateway container: no network, no published ports, restart: no)"
  dc up -d
  wait_until_healthy
  finish
}

step_verify() {
  section "verify: container hardening"
  [[ -n $(container_id) ]] || die "no container; run the up step first"
  expect_inspect "running" '{{.State.Status}}' running
  expect_inspect "image digest" '{{.Config.Image}}' "$IMAGE"
  expect_inspect "network mode" '{{.HostConfig.NetworkMode}}' none
  expect_inspect "not privileged" '{{.HostConfig.Privileged}}' false
  expect_inspect "read-only root fs" '{{.HostConfig.ReadonlyRootfs}}' true
  expect_inspect "capabilities dropped" '{{json .HostConfig.CapDrop}}' '["ALL"]'
  expect_inspect "no added capabilities" '{{json .HostConfig.CapAdd}}' null
  expect_inspect "no-new-privileges" '{{json .HostConfig.SecurityOpt}}' '["no-new-privileges:true"]'
  expect_inspect "no published ports" '{{json .HostConfig.PortBindings}}' '{}'
  expect_inspect "restart policy" '{{.HostConfig.RestartPolicy.Name}}' no
  expect_inspect "user" '{{.Config.User}}' "$CONTAINER_UID:$CONTAINER_UID"
  expect_inspect "only the state volume is mounted" \
    '{{range .Mounts}}{{.Type}}:{{.Name}}:{{.Destination}} {{end}}' "volume:${PROJECT}_home:/home/node "
  local host_listeners
  if ! host_listeners=$(ss -Hltn "sport = :$GATEWAY_PORT"); then
    fail "ss failed; host listeners unknown"
  elif [[ -z $host_listeners ]]; then
    pass "no host listener on port $GATEWAY_PORT"
  else
    finding "a host process listens on $GATEWAY_PORT (not this container)"
  fi

  section "verify: gateway"
  must "version $OPENCLAW_VERSION" "node openclaw.mjs --version | grep -F 'OpenClaw $OPENCLAW_VERSION '"
  must "/healthz" 'node -e "fetch(\"http://127.0.0.1:18789/healthz\").then(r => { console.log(r.status); process.exit(r.ok ? 0 : 1) }, () => process.exit(1))"'
  must "gateway health" 'node openclaw.mjs gateway health'
  must "gateway status with RPC read check" 'node openclaw.mjs gateway status --require-rpc'
  info 'node openclaw.mjs gateway probe'
  # --lint exits 1 when findings exist; 2 is a command failure.
  must "doctor --lint ran" 'node openclaw.mjs doctor --lint; rc=$?; echo "[doctor --lint exit $rc]"; [ $rc -le 1 ]'
  must "doctor --json (read-only advisory)" 'node openclaw.mjs doctor --json'
  local flags
  for flags in "" "--deep"; do
    must "security audit $flags: 0 critical" \
      "node openclaw.mjs security audit $flags --json > /tmp/sf-audit.json; cat /tmp/sf-audit.json; node -e 'process.exit(require(\"/tmp/sf-audit.json\").summary.critical === 0 ? 0 : 1)'"
  done
  local listeners address found=0
  listeners=$(container_listeners) || fail "could not read container listeners"
  echo "container listeners: $(tr '\n' ' ' <<<"$listeners")"
  while read -r address; do
    [[ -n $address ]] || continue
    found=1
    [[ $address == 127.* || $address == '[::1]:'* || $address == '[::ffff:127.'* ]] && pass "listener $address is loopback" || fail "listener $address is not loopback"
  done <<<"$listeners"
  ((found)) || fail "no listener inside the container"

  section "access paths (statement, not a proof)"
  echo "- network: none; the container has only its own loopback. No host, LAN or internet access from it,"
  echo "  and nothing outside the container can connect to the gateway (no published ports)."
  echo "- filesystem: only the named volume ${PROJECT}_home; no host paths, no Docker socket."
  echo "- management: anyone who can run docker commands on this host can exec into the container,"
  echo "  read the volume and the token. That is the Docker daemon's trust boundary."
  local security
  security=$(docker info --format '{{join .SecurityOptions " "}}' 2>/dev/null || true)
  if [[ $security != *rootless* && $security != *userns* ]]; then
    echo "- uid: the container runs as uid $CONTAINER_UID without user namespace remapping; a kernel or"
    echo "  runtime escape would act as host uid $CONTAINER_UID ($(getent passwd "$CONTAINER_UID" | cut -d: -f1 || echo 'no host user'))."
    echo "ISOLATION NOT GUARANTEED against a container escape (see the uid line above)."
  fi
  finish
}

step_lifecycle() {
  section "lifecycle"
  [[ -n $(container_id) ]] || die "no container; run the up step first"
  confirm "Will run: docker compose stop, start, restart (required checks after each)."
  # The token must survive unchanged. The entrypoint's doctor --fix may legitimately
  # add fields to openclaw.json on start, so the config must only stay present and valid.
  local token_before token_after config_before config_after started_before started_after
  token_before=$(in_container 'stat -c "%i %Y %s" ~/.openclaw/secrets/gateway-token') || true
  config_before=$(in_container 'sha256sum < ~/.openclaw/openclaw.json') || true
  [[ $token_before =~ ^[0-9]+\ [0-9]+\ 64$ ]] || fail "could not read the token file state ('$token_before')"
  dc stop
  expect_inspect "stopped" '{{.State.Status}}' exited
  expect_inspect "clean exit code" '{{.State.ExitCode}}' 0
  dc start
  wait_until_healthy
  must "gateway health after start" 'node openclaw.mjs gateway health'
  started_before=$(inspect '{{.State.StartedAt}}')
  dc restart
  wait_until_healthy
  started_after=$(inspect '{{.State.StartedAt}}')
  [[ $started_after != "$started_before" ]] && pass "restart started a new process ($started_after)" || fail "StartedAt unchanged after restart"
  must "gateway status after restart" 'node openclaw.mjs gateway status --require-rpc'
  token_after=$(in_container 'stat -c "%i %Y %s" ~/.openclaw/secrets/gateway-token') || true
  [[ $token_after == "$token_before" ]] && pass "token persisted unchanged (inode, mtime, size)" || fail "token changed: '$token_before' -> '$token_after'"
  must "config present and valid after restart" 'node openclaw.mjs config validate'
  config_after=$(in_container 'sha256sum < ~/.openclaw/openclaw.json') || true
  echo "config sha256 before=${config_before%% *} after=${config_after%% *}"
  finish
}

step_tokenscan() {
  section "tokenscan"
  [[ -n $(container_id) ]] || die "no container; run the up step first"
  must "token file present and non-empty" 'test -s ~/.openclaw/secrets/gateway-token'
  local logs=() file
  for file in "$LOG_DIR"/*.log; do
    [[ -f $file && $(basename "$file") != tokenscan.log ]] && logs+=("$file")
  done
  ((${#logs[@]} > 0)) || fail "no step logs to scan in $LOG_DIR"
  if ((FAILURES == 0)); then
    # The comparison runs inside the container; the token never leaves the volume.
    # grep's exit code is reported in-band, so a docker failure cannot pass as "no match",
    # and the producer's exit code is appended, so a failed cat or docker logs cannot either.
    local result
    result=$({ cat "${logs[@]}" && dc logs --no-color "$SERVICE"; } |
      in_container 'n=$(grep -c -F -f ~/.openclaw/secrets/gateway-token); echo "grep=$? count=$n"'
      echo "input=${PIPESTATUS[0]}")
    result=$(tr '\n' ' ' <<<"$result")
    case $result in
      'grep=1 count=0 input=0 ') pass "token not found in ${#logs[@]} step log(s) and the container log" ;;
      'grep=0 count='*) local count=${result#*count=}; fail "token found (${count%% *} line(s))" ;;
      *) fail "scan failed (${result:-no result})" ;;
    esac
  fi
  finish
}

step_down() {
  section "down"
  confirm "Will run: docker compose down (removes the container; keeps the image and the state volume ${PROJECT}_home)."
  dc down
  local remaining
  if remaining=$(container_id); then
    [[ -z $remaining ]] && pass "container removed" || fail "container still present"
  else
    fail "docker compose ps failed"
  fi
  docker volume inspect "${PROJECT}_home" >/dev/null 2>&1 && pass "state volume kept" || fail "state volume missing"
  finish
}

main() {
  local step=${1:-}
  case $step in
    preflight | pull | init | up | verify | lifecycle | tokenscan | down) ;;
    *) sed -n '2,26p' "$0"; exit 2 ;;
  esac
  mkdir -p "$LOG_DIR"
  "step_$step" 2>&1 | tee -a "$LOG_DIR/$step.log"
}

[[ ${BASH_SOURCE[0]} != "$0" ]] || main "$@"
