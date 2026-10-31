#!/usr/bin/env bash
# SF-010 MCP Events discovery: the one canonical operator launcher, for one attempt. Prepared by jobs
# sf010-event-probe-launcher-repair-20261030 and sf009-publication-recovery-launcher-20261031, and
# never run for real; see docs/runbooks/SF-010-event-probe.md. Operator only, after approval:
#   bash scripts/sf010-event-probe-live.sh --operator-approved
#
# No retry, no restart, no extension and no probe call after the tunnel starts. The attempt directory
# is claimed once and never reused. Every refusal before the claim leaves nothing behind.
#
# Exit status: 0 window completed and every check passed; 1 failed, nothing of this run is running;
# 128+n interrupted by signal n, nothing is running; 3 work of this run may survive.
set -uo pipefail
umask 077

TUNNEL_ID=tunnel_6ae483b7841c819189072dd173ea821a
PROBE_PORT=8791
HEALTH_PORT=8792
EXPOSURE_SECONDS=600
KILL_GRACE_SECONDS=5
# INT goes out this long before the deadline: the KILL grace plus one second for whole-second clocks.
# The tunnel is therefore gone by the deadline, not five seconds after it.
STOP_MARGIN_SECONDS=$(( KILL_GRACE_SECONDS + 1 ))
INIT_SECONDS=30
BUILD_SECONDS=120
TERM_WAIT_SECONDS=5
KILL_WAIT_SECONDS=3
ROLES='monitor tunnel init build probe'

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)" || exit 1
cd "$REPO" || exit 1
RUNBOOK=docs/runbooks/SF-010-event-probe.md
ACCEPTED=review/SF-010/chatgpt-event-probe-20261030
BINDING=review/SF-009/publication-recovery-launcher-20261031
OUT=review/SF-010/event-probe-live-attempt
DIST=bridge/sf010-event-probe-validation-dist
LIVE="$HOME/.config/tunnel-client/software-factory.yaml"
KEY_REF="file:$HOME/.config/software-factory/tunnel-runtime.key"
USER_NAME="$(id -un)" || exit 1

ERRORS="$OUT/.errors"
CLAIMED=false
CONCLUDED=false
INTERRUPTED=''
RUN=''
LIVE_IDENTITY=''
DEADLINE=''
STOP_AT=''
TUNNEL_STARTED=''
TUNNEL_PID=''
TUNNEL_RC=''
TUNNEL_ENDED_AT=''
TIMER_FIRED=false
DEADLINE_REACHED=false
WINDOW_PROVEN=false
PROBE_UP=false; TUNNEL_UP=false; TUNNEL_READY=false
# Sticky: once false, nothing later can set them back.
CLEANUP_OK=true
POSTCHECKS_OK=true
EVIDENCE_OK=true
QUIESCENT=false
REVIEW_BOUNDARY=false
OUTCOME=''
LIVENESS_JSON='{}'
SURVIVORS=0
UNREADABLE=0
SCAN_COMPLETE=''
SCAN_OWNED=''
SCAN_UNREADABLE=''
RUN_START_TICKS=''

refuse() { echo "refusing: $1" >&2; exit 1; }

sanitize() {
  sed -E -e 's/\x1b\[[0-9;]*[A-Za-z]//g' \
    -e "s#$REPO#<app-repo>#g" -e "s#$HOME#~#g" \
    -e 's#/tmp/sf010-event-probe\.[A-Za-z0-9]{6}#<run>#g' \
    -e "s/\b$USER_NAME\b/<user>/g" \
    -e 's/sk-[A-Za-z0-9_-]+/<redacted>/g' -e 's/(Bearer )[^ "]+/\1<redacted>/g' \
    -e 's/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]+/<redacted>/g' \
    -e 's/\b(org|user)-[A-Za-z0-9]+/<redacted>/g'
}

error() { printf '%s\n' "$1" | sanitize >> "$ERRORS" || EVIDENCE_OK=false; }
fail() { error "$1"; exit 1; }
stop_if_interrupted() { if [ -n "$INTERRUPTED" ]; then exit 1; fi; }

now() {
  local value
  value="$(date +%s)" || return 1
  case "$value" in ''|*[!0-9]*) return 1;; esac
  echo "$value"
}

checkpoint() {
  STATE="$1" OUTCOME_="$OUTCOME" TID="$TUNNEL_ID" DL="$DEADLINE" SA="$STOP_AT" STARTED="$TUNNEL_STARTED" \
  PU="$PROBE_UP" TU="$TUNNEL_UP" TR="$TUNNEL_READY" RB="$REVIEW_BOUNDARY" QU="$QUIESCENT" CO="$CLEANUP_OK" \
  PO="$POSTCHECKS_OK" EO="$EVIDENCE_OK" LJ="$LIVENESS_JSON" SV="$SURVIVORS" RC="$TUNNEL_RC" \
  EA="$TUNNEL_ENDED_AT" DR="$DEADLINE_REACHED" TF="$TIMER_FIRED" SC="$SCAN_COMPLETE" UR="$UNREADABLE" EF="$ERRORS" F="$OUT/checkpoint.json" SELF="$BASHPID" node -e '
    const fs = require("fs"), e = process.env;
    const now = Date.now();
    const number = (value) => (value === "" ? null : Number(value));
    const remaining = e.DL ? Math.max(0, Number(e.DL) - Math.floor(now / 1000)) : null;
    const body = { state: e.STATE, outcome: e.OUTCOME_ || null, review_boundary: e.RB === "true",
      quiescent: e.QU === "true", cleanup_ok: e.CO === "true", postchecks_ok: e.PO === "true",
      evidence_ok: e.EO === "true", discovery: "unverified", time_utc: new Date(now).toISOString(),
      remaining_seconds: remaining, tunnel_id: e.TID, tunnel_started_utc: e.STARTED || null,
      tunnel: { exit_status: number(e.RC), exit_epoch: number(e.EA), stop_at: number(e.SA),
        deadline_epoch: number(e.DL), timer_fired: e.TF === "true", deadline_reached: e.DR === "true" },
      readiness: { probe_listening: e.PU === "true", tunnel_alive: e.TU === "true", tunnel_ready: e.TR === "true" },
      liveness: JSON.parse(e.LJ), unregistered_survivors: Number(e.SV),
      scan_complete: e.SC === "" ? null : e.SC === "true", unreadable_candidates: Number(e.UR),
      errors: fs.readFileSync(e.EF, "utf8").split("\n").filter(Boolean) };
    const tmp = `${e.F}.${e.SELF}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(body, null, 2) + "\n");
    fs.renameSync(tmp, e.F);'
}

# Same identity as bridge/src/execution/process-identity.ts: pid, start time and boot id.
identity() {
  local stat fields
  stat="$(cat "/proc/$1/stat" 2>/dev/null)" || return 1
  fields="${stat##*) }"
  read -r -a fields <<< "$fields"
  echo "$1 ${fields[19]} $(cat /proc/sys/kernel/random/boot_id)"
}

# not_started, gone, reused (the recorded process is gone and another one has its PID), alive, or
# unknown when the record cannot be trusted. Only alive may be signalled. A child whose identity
# could not be read stays unknown until its PID has positively left /proc.
liveness() {
  local file="$RUN/owned/$1.identity" pid start boot extra current stat fields
  [ -e "$file" ] || { echo not_started; return; }
  read -r pid start boot extra < "$file" 2>/dev/null || { echo unknown; return; }
  if [ "$start" = unread ]; then
    if [ -e "/proc/$pid" ]; then echo unknown; else echo gone; fi
    return
  fi
  case "$pid$start" in ''|*[!0-9]*) echo unknown; return;; esac
  if [ -z "$boot" ] || [ -n "$extra" ]; then echo unknown; return; fi
  current="$(cat /proc/sys/kernel/random/boot_id 2>/dev/null)" || { echo unknown; return; }
  if [ "$boot" != "$current" ]; then echo gone; return; fi
  if [ ! -e "/proc/$pid" ]; then echo gone; return; fi
  stat="$(cat "/proc/$pid/stat" 2>/dev/null)" || { [ -e "/proc/$pid" ] && echo unknown || echo gone; return; }
  fields="${stat##*) }"
  read -r -a fields <<< "$fields"
  if [ "${fields[19]}" != "$start" ]; then echo reused; return; fi
  case "${fields[0]}" in Z|X|x) echo gone;; *) echo alive;; esac
}

# Own process group and default SIGINT: a plain & in a script would start the child ignoring it.
launch_owned() {
  local role="$1" recorded
  shift
  # Written first: a role with no record reads as not_started, which would hide a child.
  echo pending > "$RUN/owned/$role.identity" || fail "the $role record could not be written"
  set -m
  "$@" < /dev/null &
  OWNED_PID=$!
  set +m
  recorded="$(identity "$OWNED_PID")" || recorded="$OWNED_PID unread"
  echo "$recorded" > "$RUN/owned/$role.identity" || fail "the $role record could not be written"
}

# A foreground step that a signal can interrupt at once. The caller decides what a failure means.
run_owned() {
  local role="$1" pid
  shift
  launch_owned "$role" "$@"
  pid=$OWNED_PID
  while :; do
    case "$(liveness "$role")" in alive|unknown) ;; *) break;; esac
    if [ -n "$INTERRUPTED" ]; then return 1; fi
    sleep 0.1
  done
  wait "$pid"
}

start_ticks() {
  local stat fields
  { read -r stat < "/proc/$1/stat"; } 2>/dev/null || return 1
  fields="${stat##*) }"
  read -r -a fields <<< "$fields"
  echo "${fields[19]}"
}

# An unreadable environ proves nothing by itself. Ruled out only: a PID that left /proc, another real
# user, or a start before this launcher. Anything else may be ours; it stays uncertain and unsignalled.
potentially_owned() {
  local pid="$1" key real rest found=false ticks
  [ -e "/proc/$pid" ] || return 1
  { while read -r key real rest; do
      if [ "$key" = Uid: ]; then found=true; break; fi
    done < "/proc/$pid/status"; } 2>/dev/null
  if [ "$found" = false ]; then [ -e "/proc/$pid" ]; return; fi
  [ "$real" = "$UID" ] || return 1
  ticks="$(start_ticks "$pid")" || { [ -e "/proc/$pid" ]; return; }
  [ "$ticks" -ge "$RUN_START_TICKS" ]
}

# Everything this run started inherits SF010_OWNER, so a descendant that outlives its parent is found
# here. Sets SCAN_OWNED, SCAN_UNREADABLE and SCAN_COMPLETE; an empty result counts only when the scan
# is complete. The sentinel holds the marker, so a scan that matches nothing at all is seen as failed.
# The subshell drops the marker first: the scan must not find itself.
scan_marked() {
  local output status line pid errors=false
  SCAN_OWNED=''; SCAN_UNREADABLE=''; SCAN_COMPLETE=true
  output="$( unset SF010_OWNER
             grep -lzxF -- "SF010_OWNER=$RUN" "$RUN/scan-sentinel" /proc/[0-9]*/environ 2> "$RUN/scan.err" )"
  status=$?
  case "$status" in 0|1|2) ;; *) SCAN_COMPLETE=false;; esac
  case $'\n'"$output"$'\n' in *$'\n'"$RUN/scan-sentinel"$'\n'*) ;; *) SCAN_COMPLETE=false;; esac
  while IFS= read -r line; do
    case "$line" in
      /proc/*/environ)
        pid="${line#/proc/}"
        SCAN_OWNED="$SCAN_OWNED ${pid%/environ}";;
      "$RUN/scan-sentinel"|'') ;;
      *) SCAN_COMPLETE=false;;
    esac
  done <<< "$output"
  while IFS= read -r line; do
    case "$line" in
      *': /proc/'*'/environ: '*)
        errors=true
        pid="${line#*: /proc/}"
        pid="${pid%%/*}"
        case "$pid" in
          ''|*[!0-9]*) SCAN_COMPLETE=false;;
          *) if potentially_owned "$pid"; then SCAN_UNREADABLE="$SCAN_UNREADABLE $pid"; fi;;
        esac;;
      *) SCAN_COMPLETE=false;;
    esac
  done < "$RUN/scan.err" || SCAN_COMPLETE=false
  if [ "$status" -eq 2 ] && [ "$errors" = false ]; then SCAN_COMPLETE=false; fi
}

# The external kill, not the builtin, so that the fixtures can make a stop fail.
send_signal() { env kill -s "$1" "$2" 2>/dev/null; }

signal_owned() {
  local signal="$1" role pid
  for role in $ROLES; do
    if [ "$(liveness "$role")" = alive ]; then
      read -r pid _ < "$RUN/owned/$role.identity"
      send_signal "$signal" "$pid"
    fi
  done
  scan_marked
  for pid in $SCAN_OWNED; do
    # Read again next to the signal: a PID that was reused since the scan no longer has the marker.
    if grep -qzxF -- "SF010_OWNER=$RUN" "/proc/$pid/environ" 2>/dev/null; then
      send_signal "$signal" "$pid"
    fi
  done
}

all_stopped() {
  local role
  for role in $ROLES; do
    if [ "$(liveness "$role")" = alive ]; then return 1; fi
  done
  scan_marked
  [ "$SCAN_COMPLETE" = true ] && [ -z "$SCAN_OWNED" ] && [ -z "$SCAN_UNREADABLE" ]
}

# Bounded by elapsed time, not by a count: one scan reads every process on the host.
wait_stopped() {
  local until=$(( SECONDS + $1 ))
  while [ "$SECONDS" -lt "$until" ]; do
    if all_stopped; then return 0; fi
    sleep 0.1
  done
  all_stopped
}

ports_free() {
  local listeners
  listeners="$(ss -ltnH "sport = :$PROBE_PORT or sport = :$HEALTH_PORT")" && [ -z "$listeners" ]
}

probe_listens() {
  local pid listeners
  [ "$(liveness probe)" = alive ] || return 1
  read -r pid _ < "$RUN/owned/probe.identity"
  listeners="$(ss -ltnpH "sport = :$PROBE_PORT" 2>/dev/null)" || return 1
  [[ "$listeners" == *"pid=$pid,"* ]]
}

hash_of() { local line; line="$(sha256sum "$1")" && echo "${line%% *}"; }
baseline_hash() { local line; line="$(cat "$ACCEPTED/live-profile-baseline.sha256")" && echo "${line%% *}"; }

# The four accepted probe entries, without the obsolete runbook entry, must hold on their own and be
# bound by the fresh manifest, which adds the launcher, runbook and test.
verify_sources() {
  local entries entry
  entries="$(grep -vF "  $RUNBOOK" "$ACCEPTED/SOURCE-SHA256SUMS")" || return 1
  [ "$(printf '%s\n' "$entries" | wc -l)" -eq 4 ] || return 1
  printf '%s\n' "$entries" | sha256sum --status -c - || return 1
  [ "$(wc -l < "$BINDING/SOURCE-SHA256SUMS")" -eq 7 ] || return 1
  sha256sum --status -c "$BINDING/SOURCE-SHA256SUMS" || return 1
  while IFS= read -r entry; do
    grep -qxF -- "$entry" "$BINDING/SOURCE-SHA256SUMS" || return 1
  done <<< "$entries"
}

unsupported() { echo "unsupported path kind: $1" >&2; return 1; }

# One entry by kind. A symlink is its own target and the kind of its referent, plus the referent's hash
# when that is a file, so a link retargeted to equal content or to another dangling name differs. A
# regular file is queued for hashing as ./path, so that a name like --help or - stays a file operand.
# Anything else (a directory, which is how Git lists a gitlink or a
# nested repository, a FIFO, a socket, a device) has no capture here: it fails before a reader can
# block on it, and the preflight capture refuses before the attempt is used.
capture_path() {
  local dir="$1" path="$2" target hash
  if [ -L "$path" ]; then
    # The x keeps a trailing newline of the target.
    target="$(readlink -n -- "$path" && echo x)" || return 1
    target="${target%x}"
    if [ -f "$path" ]; then
      hash="$(hash_of "./$path")" || return 1
      printf 'symlink %q -> %q file %s\n' "$path" "$target" "$hash"
    elif [ -d "$path" ]; then
      printf 'symlink %q -> %q directory\n' "$path" "$target"
    elif [ ! -e "$path" ]; then
      printf 'symlink %q -> %q dangling\n' "$path" "$target"
    else
      unsupported "$path"
    fi
  elif [ -f "$path" ]; then
    printf '%s\0' "./$path" >> "$dir/present"
  else
    unsupported "$path"
  fi
}

# Every step counts. Only a path that Git itself lists as deleted may lack a hash, so a capture that
# could not read something fails instead of comparing equal to another partial capture.
capture_worktree() {
  local dir="$1" path
  local -A deleted=()
  git --no-optional-locks status --porcelain=v1 --untracked-files=all > "$dir/status" || return 1
  grep -vF " $OUT/" "$dir/status" || [ $? -eq 1 ] || return 1
  git ls-files -z > "$dir/tracked" || return 1
  git ls-files -z -o --exclude-standard > "$dir/others" || return 1
  git ls-files -z --deleted > "$dir/deleted" || return 1
  while IFS= read -r -d '' path; do deleted["$path"]=1; done < "$dir/deleted"
  cat "$dir/tracked" "$dir/others" > "$dir/listed" || return 1
  if [ -d bridge/dist ]; then
    find bridge/dist ! -type d -print0 >> "$dir/listed" || return 1
  fi
  { grep -zv "^$OUT/" "$dir/listed" || [ $? -eq 1 ]; } | sort -zu > "$dir/paths" || return 1
  : > "$dir/present" || return 1
  while IFS= read -r -d '' path; do
    if [ -n "${deleted[$path]:-}" ]; then
      echo "deleted $path"
    else
      capture_path "$dir" "$path" || return 1
    fi
  done < "$dir/paths"
  xargs -0 -r sha256sum < "$dir/present" || return 1
  hash_of "$LIVE"
}

snapshot() {
  local dir status
  dir="$(mktemp -d /tmp/sf010-snapshot.XXXXXX)" || return 1
  capture_worktree "$dir" > "$1" 2> "$dir/errors"
  status=$?
  if [ "$status" -ne 0 ]; then
    grep -F 'unsupported path kind' "$dir/errors" | sanitize >&2
  fi
  rm -rf "$dir" || status=1
  return "$status"
}

# Watches the attempt from outside the probe: /proc, the listener table and the tunnel's own health
# port. It only records; the launcher does the stopping. Ready is published only before the stop time.
monitor() {
  local was_ready=false
  while :; do
    PROBE_UP=false; TUNNEL_UP=false; TUNNEL_READY=false
    if probe_listens; then PROBE_UP=true; fi
    if [ "$(liveness tunnel)" = alive ]; then TUNNEL_UP=true; fi
    if [ "$TUNNEL_UP" = true ] && curl -fsS -m 3 "http://127.0.0.1:$HEALTH_PORT/readyz" > /dev/null 2>&1; then
      TUNNEL_READY=true
    fi
    if [ "$(now)" -ge "$STOP_AT" ]; then exit 0; fi
    # A monitor that survives a failed stop must not publish over the final checkpoint.
    if [ -e "$RUN/concluding" ]; then exit 0; fi
    if [ "$PROBE_UP" = true ] && [ "$TUNNEL_UP" = true ] && [ "$TUNNEL_READY" = true ]; then
      was_ready=true
      touch "$RUN/was-ready"
      checkpoint ready
    elif [ "$was_ready" = true ] || [ "$PROBE_UP" = false ]; then
      error "readiness lost: probe_listening=$PROBE_UP tunnel_alive=$TUNNEL_UP tunnel_ready=$TUNNEL_READY"
      touch "$RUN/monitor-failed"
      exit 1
    else
      checkpoint starting
    fi
    sleep 1
  done
}

# Refuses unless the tunnel still has positive time before the stop and the deadline is sane.
check_remaining() {
  local current
  current="$(now)" || fail 'the clock is unreadable'
  REMAINING=$(( STOP_AT - current ))
  if [ "$REMAINING" -le 0 ] || [ $(( DEADLINE - current )) -gt "$EXPOSURE_SECONDS" ]; then
    fail "the stop time is expired or inconsistent ($REMAINING s)"
  fi
}

copy_sanitized() {
  if [ -f "$RUN/$1" ]; then
    sanitize < "$RUN/$1" > "$OUT/$1" || EVIDENCE_OK=false
  fi
}

# Runs whatever became of the processes, and before anything is removed.
collect_evidence() {
  local started
  copy_sanitized build.log
  copy_sanitized probe.log
  copy_sanitized local-check.json
  copy_sanitized timeout.log
  if [ -f "$RUN/tunnel-client.log" ]; then
    { grep -iE 'error|fail|refus|panic|denied|unauthori|forbidden|invalid|unsupported' "$RUN/tunnel-client.log" \
        || [ $? -eq 1 ]; } | sanitize > "$OUT/tunnel-errors.log" || EVIDENCE_OK=false
    # Only grep's no-match status is benign; pipefail reports every other stage.
    sanitize < "$RUN/tunnel-client.log" \
      | { grep -oE '"?(protocol|method|channel)"?[=:] ?"?[A-Za-z0-9/_.-]+' || [ $? -eq 1 ]; } \
      | sort | uniq -c > "$OUT/tunnel-methods.log" || EVIDENCE_OK=false
  fi
  for started in "$RUN"/tunnel.*/started; do
    if [ -f "$started" ]; then
      cat "$started" > "$OUT/tunnel-started.txt" || EVIDENCE_OK=false
    fi
  done
  if [ "$EVIDENCE_OK" = false ]; then error 'evidence could not be copied; the run directory is kept'; fi
}

rollback() {
  case "$RUN" in
    /tmp/sf010-event-probe.??????) ;;
    *) echo 'not a run directory'; return 1;;
  esac
  [ -f "$RUN/owned-by-this-run" ] || { echo 'not a run directory'; return 1; }
  local status=0
  sha256sum -c "$RUN/live-profile.sha256" || status=1
  if [ -f "$RUN/dist-created" ]; then
    rm -rf "$DIST" || status=1
  fi
  rm -rf "$RUN" || status=1
  return "$status"
}

postcheck() {
  local name="$1"
  shift
  if "$@" > /dev/null 2>&1; then
    echo "pass $name" >> "$OUT/postchecks.txt" || EVIDENCE_OK=false
  else
    echo "fail $name" >> "$OUT/postchecks.txt" || EVIDENCE_OK=false
    POSTCHECKS_OK=false
    error "postcheck failed: $name"
  fi
}

live_hash_matches() { [ "$(hash_of "$LIVE")" = "$(baseline_hash)" ]; }
bridge_active() { [ "$(systemctl --user is-active sf-bridge.service)" = active ]; }
health_ready() { curl -fsS -m 5 http://127.0.0.1:8790/readyz; }
only_live_profile() { [ "$(ls "$HOME/.config/tunnel-client")" = software-factory.yaml ]; }
absent() { [ ! -e "$1" ]; }
live_identity_unchanged() { [ -n "$LIVE_IDENTITY" ] && [ "$(identity "${LIVE_IDENTITY%% *}")" = "$LIVE_IDENTITY" ]; }
worktree_unchanged() {
  snapshot "$OUT/worktree-after.sha256" || return 1
  diff "$OUT/worktree-before.sha256" "$OUT/worktree-after.sha256" > "$OUT/worktree.diff"
}

# Every check runs and every failure counts, whatever ran after it.
run_postchecks() {
  : > "$OUT/postchecks.txt" || EVIDENCE_OK=false
  postcheck 'live profile hash' live_hash_matches
  postcheck 'sf-bridge.service active' bridge_active
  postcheck 'tunnel health 8790' health_ready
  postcheck 'tunnel-client profiles' only_live_profile
  postcheck 'test ports free' ports_free
  postcheck 'validation build removed' absent "$DIST"
  postcheck 'run directory removed' absent "$RUN"
  postcheck 'live tunnel identity' live_identity_unchanged
  postcheck 'worktree unchanged' worktree_unchanged
  postcheck 'source manifests' verify_sources
}

stop_and_assess() {
  local role state json='' uncertain=false
  if ! all_stopped; then
    signal_owned TERM
    if ! wait_stopped "$TERM_WAIT_SECONDS"; then
      signal_owned KILL
      wait_stopped "$KILL_WAIT_SECONDS"
    fi
  fi
  for role in $ROLES; do
    state="$(liveness "$role")"
    json="$json\"$role\":\"$state\","
    case "$state" in alive|unknown) uncertain=true;; esac
  done
  LIVENESS_JSON="{${json%,}}"
  # A process refuses the environ read for a moment while it ends or execs. As the supervisor's
  # settledScan does: read again, bounded. One that stays unreadable counts.
  for _ in {1..10}; do
    scan_marked
    if [ -z "$SCAN_UNREADABLE" ]; then break; fi
    sleep 0.1
  done
  SURVIVORS="$(wc -w <<< "$SCAN_OWNED")"
  UNREADABLE="$(wc -w <<< "$SCAN_UNREADABLE")"
  if [ "$SCAN_COMPLETE" = false ]; then
    uncertain=true
    error 'the process scan did not complete'
  fi
  if [ "$SURVIVORS" -ne 0 ] || [ "$UNREADABLE" -ne 0 ]; then uncertain=true; fi
  if ! ports_free; then
    uncertain=true
    error 'test port 8791 or 8792 is still occupied, or the listener table is unreadable'
  fi
  if [ "$uncertain" = true ]; then
    error "work of this run may be still running: $LIVENESS_JSON, $SURVIVORS other marked, $UNREADABLE unreadable candidates"
  else
    QUIESCENT=true
  fi
}

# EXIT trap: the only place that stops, publishes and picks the exit status. Signals only set
# INTERRUPTED, so it never runs twice and a later signal cannot cut it short.
conclude() {
  local final_state status
  trap - EXIT
  if [ "$CONCLUDED" = true ] || [ "$CLAIMED" = false ]; then return; fi
  CONCLUDED=true
  PROBE_UP=false; TUNNEL_UP=false; TUNNEL_READY=false
  if [ -n "$RUN" ]; then
    touch "$RUN/concluding"
    stop_and_assess
    collect_evidence
    if [ "$QUIESCENT" = true ] && [ "$EVIDENCE_OK" = true ]; then
      rollback > "$OUT/.rollback" 2>&1
      status=$?
      # The private original stays unless its sanitized copy is published.
      if sanitize < "$OUT/.rollback" > "$OUT/rollback.log"; then
        rm -f "$OUT/.rollback" || EVIDENCE_OK=false
      else
        EVIDENCE_OK=false
        error 'the rollback log could not be published; the private original .rollback is kept'
      fi
      if [ "$status" -ne 0 ]; then
        CLEANUP_OK=false
        error "cleanup failed: rollback exit $status"
      fi
    else
      CLEANUP_OK=false
      error "cleanup not attempted; the run directory is kept: $RUN"
    fi
  else
    QUIESCENT=true
  fi
  run_postchecks

  if [ -n "$INTERRUPTED" ]; then
    OUTCOME=interrupted
    error "interrupted by $INTERRUPTED"
  elif [ "$WINDOW_PROVEN" = true ] && [ "$QUIESCENT" = true ] && [ "$CLEANUP_OK" = true ] &&
       [ "$POSTCHECKS_OK" = true ] && [ "$EVIDENCE_OK" = true ]; then
    OUTCOME=window_completed
  else
    OUTCOME=failed
  fi
  # The boundary means nothing of this run is running and the evidence is complete. It says nothing
  # about the outcome, which is reported on its own.
  if [ "$QUIESCENT" = true ] && [ "$EVIDENCE_OK" = true ]; then
    REVIEW_BOUNDARY=true
    final_state=quiescent
  else
    final_state=uncertain
  fi

  if checkpoint "$final_state"; then
    rm -f "$ERRORS"
  else
    echo "the final checkpoint could not be written; see $OUT/.errors" >&2
    exit 3
  fi
  echo "outcome=$OUTCOME state=$final_state review_boundary=$REVIEW_BOUNDARY discovery=unverified"
  if [ "$REVIEW_BOUNDARY" = false ]; then
    echo "no review boundary: work may survive or evidence is incomplete; inspect $RUN and $OUT" >&2
    exit 3
  fi
  case "$INTERRUPTED:$OUTCOME" in
    INT:*) exit 130;;
    HUP:*) exit 129;;
    TERM:*) exit 143;;
    *:window_completed) exit 0;;
    *) exit 1;;
  esac
}

on_signal() { if [ -z "$INTERRUPTED" ]; then INTERRUPTED="$1"; fi; }

if [ "$#" -ne 1 ] || [ "$1" != --operator-approved ]; then
  refuse 'this is the operator step; see docs/runbooks/SF-010-event-probe.md'
fi

# Before anything else: a missing tool must end the attempt before it starts, not half way through.
for tool in cat chmod cmp cut date diff env find git grep head id kill ls mkdir mktemp node npx pgrep readlink rm sed \
            sha256sum sleep sort ss systemctl timeout touch tr tunnel-client curl uniq wc xargs; do
  type -P "$tool" > /dev/null || refuse "missing command: $tool"
done
[ -r /proc/self/stat ] && [ -r /proc/sys/kernel/random/boot_id ] || refuse 'this needs Linux /proc'
[ -d bridge/src/event-probe ] || refuse 'run this from a checkout with the probe source'
[ ! -e "$OUT" ] || refuse "the one attempt was already used: $OUT exists"
verify_sources || refuse 'source hash mismatch'
[ -f "$LIVE" ] || refuse 'the live tunnel profile is missing'
grep -qF "$TUNNEL_ID" "$LIVE"
case $? in
  1) ;;
  0) refuse 'that is the live tunnel';;
  *) refuse 'the live tunnel profile is unreadable';;
esac
[ "$(hash_of "$LIVE")" = "$(baseline_hash)" ] || refuse 'the live tunnel profile differs from the accepted baseline'
ports_free || refuse 'port 8791 or 8792 is occupied, or the listener table is unreadable'
[ ! -e "$DIST" ] || refuse 'validation build output exists'
LIVE_PIDS="$(pgrep -f 'tunnel-client run --profile software-factory')" || refuse 'the live tunnel is not running'
[ "$(printf '%s\n' "$LIVE_PIDS" | wc -l)" -eq 1 ] && [ -n "$LIVE_PIDS" ] || refuse 'expected one live tunnel process'
LIVE_IDENTITY="$(identity "$LIVE_PIDS")" || refuse 'the live tunnel process is unreadable'
bridge_active || refuse 'sf-bridge.service is not active'
health_ready > /dev/null 2>&1 || refuse 'the live tunnel health endpoint is not ready'
[[ "$(timeout --help)" == *--verbose* ]] || refuse 'this timeout cannot witness its own timer'
# A worktree that cannot be captured must not use up the attempt.
snapshot /dev/null || refuse 'the worktree snapshot failed'

RUN_START_TICKS="$(start_ticks "$$")" || refuse 'the start time of this launcher is unreadable'
trap conclude EXIT
trap 'on_signal INT' INT
trap 'on_signal TERM' TERM
trap 'on_signal HUP' HUP
# A closed terminal must not end the cleanup.
trap '' PIPE

mkdir "$OUT" || refuse "the one attempt was already used: $OUT exists"
CLAIMED=true
: > "$ERRORS"
checkpoint starting || fail 'the checkpoint could not be written'
snapshot "$OUT/worktree-before.sha256" || fail 'the worktree snapshot failed'

RUN="$(mktemp -d /tmp/sf010-event-probe.XXXXXX)" || { RUN=''; fail 'the run directory could not be created'; }
export SF010_OWNER="$RUN"
mkdir "$RUN/owned" || fail 'the run directory could not be prepared'
touch "$RUN/owned-by-this-run" || fail 'the run directory could not be prepared'
printf 'SF010_OWNER=%s\0' "$RUN" > "$RUN/scan-sentinel" || fail 'the run directory could not be prepared'
echo "SF010_RUN=$RUN"
sha256sum "$LIVE" > "$RUN/live-profile.sha256" || fail 'the live profile could not be hashed'

touch "$RUN/dist-created" || fail 'the run directory could not be prepared'
run_owned build timeout -k "$KILL_GRACE_SECONDS" "$BUILD_SECONDS" env -C bridge npx tsc -p tsconfig.event-probe.json \
  > "$RUN/build.log" 2>&1 || fail 'the probe build failed'
stop_if_interrupted

# Counts from before the launch, so the deadline never passes the probe's own ten-minute limit.
started="$(now)" || fail 'the clock is unreadable'
launch_owned probe env "SF010_PROBE_PORT=$PROBE_PORT" node "$DIST/src/event-probe/main.js" > "$RUN/probe.log" 2>&1
for _ in {1..50}; do
  if { grep -q 'listening on' "$RUN/probe.log" && probe_listens; } || [ "$(liveness probe)" != alive ]; then break; fi
  stop_if_interrupted
  sleep 0.1
done
stop_if_interrupted
if ! grep -q 'listening on' "$RUN/probe.log" || ! probe_listens; then fail 'the probe did not start'; fi
DEADLINE=$(( started + EXPOSURE_SECONDS ))
STOP_AT=$(( DEADLINE - STOP_MARGIN_SECONDS ))
PROBE_UP=true
checkpoint starting

# The one local probe call, before the tunnel.
curl -fsS -m 5 "http://127.0.0.1:$PROBE_PORT/mcp" \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -H 'mcp-protocol-version: 2026-07-28' -H 'mcp-method: events/list' \
  -d '{"jsonrpc":"2.0","id":1,"method":"events/list","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{},"io.modelcontextprotocol/clientInfo":{"name":"operator","version":"1"}}}}' \
  > "$RUN/local-check.json" 2> "$RUN/local-check.err"
catalog_rc=$?
if [ "$catalog_rc" -ne 0 ] || ! grep -q 'probe\.test' "$RUN/local-check.json"; then
  fail "local catalog check failed (curl exit $catalog_rc): $(cat "$RUN/local-check.err")"
fi
stop_if_interrupted

check_remaining
PROFILE="$(mktemp -d "$RUN/tunnel.XXXXXX")" || fail 'the profile directory could not be created'
run_owned init timeout -k "$KILL_GRACE_SECONDS" "$INIT_SECONDS" tunnel-client init \
  --sample sample_mcp_remote_no_auth \
  --profile sf010-event-probe \
  --profile-dir "$PROFILE" \
  --tunnel-id "$TUNNEL_ID" \
  --mcp-server-url "http://127.0.0.1:$PROBE_PORT/mcp" \
  --health-listen-addr "127.0.0.1:$HEALTH_PORT" \
  --control-plane-api-key-ref "$KEY_REF" \
  >> "$RUN/tunnel-client.log" 2>&1 || fail 'tunnel-client init failed'
stop_if_interrupted
check_remaining

TUNNEL_STARTED="$(date -u +%Y-%m-%dT%H:%M:%SZ)" || fail 'the clock is unreadable'
echo "$TUNNEL_STARTED" > "$PROFILE/started" || fail 'the start time could not be recorded'
# With -v, timeout itself writes one line just before it signals, and only if its timer fired. The
# tunnel never holds that file: bash moves its output to the tunnel log before the exec. The timer is
# relative, so a wall-clock jump does not move it. LC_ALL keeps the line in English.
launch_owned tunnel env LC_ALL=C timeout -v -k "$KILL_GRACE_SECONDS" --signal=INT "$REMAINING" \
  bash -c 'exec "$@" >> "$0" 2>&1' "$RUN/tunnel-client.log" \
  tunnel-client run --profile sf010-event-probe --profile-dir "$PROFILE" > "$RUN/timeout.log" 2>&1
TUNNEL_PID=$OWNED_PID
launch_owned monitor monitor > /dev/null 2>&1

while [ "$(liveness tunnel)" = alive ]; do
  stop_if_interrupted
  if [ -f "$RUN/monitor-failed" ]; then break; fi
  if [ "$(liveness monitor)" != alive ] && [ "$(now)" -lt "$STOP_AT" ]; then
    error 'the monitor ended before the stop time'
    touch "$RUN/monitor-failed"
    break
  fi
  sleep 0.2
done
case "$(liveness tunnel)" in gone|reused) ;; *) exit 1;; esac
wait "$TUNNEL_PID"
TUNNEL_RC=$?
TUNNEL_ENDED_AT="$(now)" || fail 'the clock is unreadable'
stop_if_interrupted

# The tunnel can end with 124 or 137 by itself, and the launcher may see that only after the stop
# time. The status and the observation time are therefore not enough: timeout's own line must show
# that the configured timer fired while the tunnel was still running.
if grep -q 'sending signal INT' "$RUN/timeout.log"; then TIMER_FIRED=true; fi
if { [ "$TUNNEL_RC" -eq 124 ] || [ "$TUNNEL_RC" -eq 137 ]; } && [ "$TIMER_FIRED" = true ] &&
   [ "$TUNNEL_ENDED_AT" -ge "$STOP_AT" ]; then
  DEADLINE_REACHED=true
else
  { grep -iE 'error|fail|refus|panic|denied|unauthori|forbidden|invalid|unsupported' "$RUN/tunnel-client.log" \
      || [ $? -eq 1 ]; } | tail -n 10 | sanitize >> "$ERRORS" || EVIDENCE_OK=false
  fail "not a deadline stop: tunnel exit $TUNNEL_RC at epoch $TUNNEL_ENDED_AT, timer_fired=$TIMER_FIRED, stop time $STOP_AT"
fi
if [ -f "$RUN/monitor-failed" ]; then exit 1; fi
if [ ! -f "$RUN/was-ready" ]; then fail 'the tunnel never reported ready before the stop time'; fi
WINDOW_PROVEN=true
exit 0
