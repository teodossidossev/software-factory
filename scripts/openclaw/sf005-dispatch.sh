#!/usr/bin/env bash
# Software Factory: provision and check the OpenClaw side of the SF-005 dispatch
# channel in the running SF-004 gateway container. Linux hosts only.
#
#   scripts/openclaw/sf005-dispatch.sh <step>
#
# Steps:
#   provision   installs deploy/openclaw/sf-dispatch-receiver.mjs into the state
#               volume and creates the disabled OpenClaw command automation
#               "sf-dispatch-receiver" with a fixed argv; asks first, re-runnable,
#               never replaces a differing automation
#   verify      required checks: receiver file, automation definition, scheduler
#               still disabled, live OpenClaw config matches the offline or the
#               dashboard profile (config/openclaw), doctor and security audit
#   history     read-only: the automation, its OpenClaw run history and the
#               requests the receiver accepted
#
# The bridge (factory_request_dispatch) then only enqueues a validated request
# and runs this automation manually. Nothing here changes the Compose file, the
# OpenClaw config, the Docker daemon or any host path outside the state volume.
set -euo pipefail

# shellcheck source=scripts/openclaw/sf004-docker.sh
source "$(dirname "${BASH_SOURCE[0]}")/sf004-docker.sh"

RECEIVER_SOURCE=$REPO_ROOT/deploy/openclaw/sf-dispatch-receiver.mjs
DISPATCH_DIR=/home/node/.openclaw/sf-dispatch
RECEIVER=$DISPATCH_DIR/receiver.mjs
AUTOMATION=sf-dispatch-receiver
AUTOMATION_ARGV='["node","'$RECEIVER'","accept"]'
# Like sf004-docker.sh, but without stdin: docker compose exec would otherwise
# consume the terminal input meant for confirm.
in_container() { dc exec -T "$SERVICE" sh -c "$1" </dev/null; }

CONFIG_CHECK=$REPO_ROOT/scripts/openclaw/openclaw-config-check.cjs
LIVE_CONFIG=/home/node/.openclaw/openclaw.json
DASHBOARD_PROFILE=$REPO_ROOT/config/openclaw/profiles/dashboard.json5

# Required check: the live openclaw.json matches one configuration profile:
# "offline" (config/openclaw/openclaw.json5, SF-004) or "dashboard" (plus
# config/openclaw/profiles/dashboard.json5, SF-005-UI), with only the runtime
# metadata that doctor --fix adds. $1 requires a profile; empty accepts either.
check_config() {
  local profile=${1:-} rc=0
  echo "\$ openclaw-config-check.cjs $LIVE_CONFIG ${profile:-(offline or dashboard)}"
  { cat "$CONFIG_FILE"; printf '\0dashboard\n'; cat "$DASHBOARD_PROFILE"; } |
    dc exec -T "$SERVICE" node -e "$(cat "$CONFIG_CHECK")" "$LIVE_CONFIG" $profile || rc=$?
  if ((rc == 0)); then
    pass "live config matches profile ${profile:-offline or dashboard}; extra keys are doctor metadata only"
  else
    fail "live config does not match profile ${profile:-offline or dashboard} (exit $rc)"
  fi
}

# Required: security audit and audit --deep without critical findings; lists non-info findings.
audit_checks() {
  local flags
  for flags in "" "--deep"; do
    must "security audit $flags: 0 critical" \
      "node openclaw.mjs security audit $flags --json > /tmp/sf-audit.json; node -e 'const a=require(\"/tmp/sf-audit.json\");console.log(JSON.stringify(a.summary));for(const f of a.findings??[])if(f.severity!==\"info\")console.log(f.severity, f.checkId ?? f.id, f.title ?? \"\");process.exit(a.summary.critical===0?0:1)'"
  done
}

# Prints "missing", or the sha256 of the receiver installed in the volume.
installed_receiver() {
  in_container "if [ -e $RECEIVER ]; then sha256sum < $RECEIVER | cut -d' ' -f1; else echo missing; fi"
}

# Prints the receiver automation(s) as JSON lines: {id, enabled, argv, delivery}.
receiver_automations() {
  in_container "node openclaw.mjs cron list --all --json | node -e '
let s = \"\";
process.stdin.on(\"data\", (d) => (s += d)).on(\"end\", () => {
  for (const job of JSON.parse(s).jobs.filter((j) => j.name === \"$AUTOMATION\")) {
    console.log(JSON.stringify({ id: job.id, enabled: job.enabled, argv: job.payload.argv ?? null, delivery: job.delivery?.mode ?? null }));
  }
});'"
}

expected_automation() {
  local line=$1
  [[ $line == '{"id":"'*'","enabled":false,"argv":'"$AUTOMATION_ARGV"',"delivery":"none"}' ]]
}

step_provision() {
  section "provision"
  in_container true >/dev/null || die "the gateway container is not running; run sf004-docker.sh up first"
  local source_sha installed automations
  source_sha=$(sha256sum <"$RECEIVER_SOURCE" | cut -d' ' -f1)
  installed=$(installed_receiver) || die "could not read the installed receiver"
  automations=$(receiver_automations) || die "could not list OpenClaw automations"
  echo "receiver: repo $source_sha, volume $installed"
  echo "automation: ${automations:-none}"

  if [[ -n $automations ]]; then
    [[ $(wc -l <<<"$automations") -eq 1 ]] || die "more than one automation named $AUTOMATION; review and remove the extra ones"
    expected_automation "$automations" ||
      die "automation $AUTOMATION differs from the expected definition; review it with 'openclaw cron get' and remove it manually"
  fi

  local plan=""
  [[ $installed == "$source_sha" ]] || plan+="- copy $RECEIVER_SOURCE into the volume as $RECEIVER (0600, dir 0700)"$'\n'
  [[ $installed == missing || $installed == "$source_sha" ]] || plan+="  (replaces the different receiver currently installed)"$'\n'
  [[ -n $automations ]] || plan+="- openclaw cron add: disabled command automation \"$AUTOMATION\", argv $AUTOMATION_ARGV,
  no delivery, never scheduled (cron 0 0 1 1 * while disabled; the scheduler is disabled too)"$'\n'
  if [[ -z $plan ]]; then
    pass "already provisioned"
    finish
    return
  fi
  confirm "Will change only the OpenClaw state volume:"$'\n'"$plan"

  if [[ $installed != "$source_sha" ]]; then
    dc exec -T "$SERVICE" sh -c "umask 077 && mkdir -p $DISPATCH_DIR && rm -f $RECEIVER.partial && cat > $RECEIVER.partial && sync $RECEIVER.partial && mv -f $RECEIVER.partial $RECEIVER" \
      <"$RECEIVER_SOURCE"
  fi
  if [[ -z $automations ]]; then
    in_container "node openclaw.mjs cron add --name $AUTOMATION --declaration-key software-factory:$AUTOMATION \
      --description 'Software Factory SF-005: records validated dispatch requests; run manually by the bridge' \
      --cron '0 0 1 1 *' --disabled --no-deliver --timeout-seconds 30 --output-max-bytes 65536 \
      --command-argv '$AUTOMATION_ARGV' --json"
  fi
  [[ $(installed_receiver) == "$source_sha" ]] && pass "receiver installed" || fail "receiver not installed"
  expected_automation "$(receiver_automations)" && pass "automation $AUTOMATION present" || fail "automation $AUTOMATION missing"
  finish
}

step_verify() {
  section "verify: dispatch channel"
  local source_sha automations
  source_sha=$(sha256sum <"$RECEIVER_SOURCE" | cut -d' ' -f1)
  [[ $(installed_receiver) == "$source_sha" ]] && pass "receiver in volume matches the repo ($source_sha)" || fail "receiver in volume differs or is missing"
  automations=$(receiver_automations) || fail "could not list automations"
  echo "$automations"
  [[ $(wc -l <<<"$automations") -eq 1 ]] && expected_automation "$automations" &&
    pass "exactly one $AUTOMATION: disabled, fixed argv, no delivery" || fail "automation $AUTOMATION missing or different"
  must "automation scheduler disabled (cron.enabled false)" \
    "node openclaw.mjs cron status --json | node -e 'let s=\"\";process.stdin.on(\"data\",d=>s+=d).on(\"end\",()=>{const j=JSON.parse(s);console.log(\"enabled=\"+j.enabled);process.exit(j.enabled===false?0:1)})'"
  check_config
  info "sha256sum $LIVE_CONFIG"
  must "config validate" 'node openclaw.mjs config validate'
  must "doctor --lint ran" 'node openclaw.mjs doctor --lint; rc=$?; echo "[doctor --lint exit $rc]"; [ $rc -le 1 ]'
  audit_checks
  finish
}

step_history() {
  section "history"
  local automations id
  automations=$(receiver_automations)
  echo "${automations:-no $AUTOMATION automation}"
  id=$(sed -n 's/^{"id":"\([^"]*\)".*/\1/p' <<<"$automations" | head -1)
  [[ -z $id ]] || info "node openclaw.mjs cron runs --id $id --limit 20 --json"
  info "ls -l $DISPATCH_DIR/inbox $DISPATCH_DIR/accepted $DISPATCH_DIR/rejected; cat $DISPATCH_DIR/accepted/*.json 2>/dev/null"
  finish
}

sf005_main() {
  local step=${1:-}
  case $step in
    provision | verify | history) ;;
    *) sed -n '2,20p' "$0"; exit 2 ;;
  esac
  mkdir -p "$LOG_DIR"
  "step_$step" 2>&1 | tee -a "$LOG_DIR/sf005-$step.log"
}

[[ ${BASH_SOURCE[0]} != "$0" ]] || sf005_main "$@"
