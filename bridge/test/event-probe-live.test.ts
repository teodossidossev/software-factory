// SF-010 operator launcher: runs a copy of scripts/sf010-event-probe-live.sh in a throwaway repository
// and HOME. PATH holds only the listed tools and inert stubs, so a missing stub fails closed: no real
// tunnel-client, curl or service command is reachable. `date` is a stored clock that the `timeout`
// stub advances, and the real GNU timeout supplies the exit statuses 124 and 137.
//
// Every synthetic helper ends by itself within SF_LIFETIME seconds of real time, whatever happens to
// this runner, and carries SF_FIXTURE_OWNER. Cleanup signals only processes that carry that marker,
// read again right before the signal; it never sweeps the scratch directory. Environments are
// restricted, but keep the enclosing session's SESSION_TAG, so that an orphaned helper stays visible
// to the supervisor's writer guard until it has ended.
import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { SESSION_TAG } from '../src/execution/runner.js';

const REPOSITORY = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const LAUNCHER = 'scripts/sf010-event-probe-live.sh';
const OUT = 'review/SF-010/event-probe-live-attempt';
const BINDING = 'review/SF-009/publication-recovery-launcher-20261031';
const ACCEPTED = 'review/SF-010/chatgpt-event-probe-20261030';
const DIST = 'bridge/sf010-event-probe-validation-dist';
const TUNNEL_ID = 'tunnel_6ae483b7841c819189072dd173ea821a';
const CLOCK_START = 1_900_000_000;
// Longer than the 45-second guard of one launcher run.
const FIXTURE_LIFETIME_SECONDS = 60;
// The interrupted-runner fixture: a helper lifetime, and the bound on everything ending after the kill.
const INTERRUPT_LIFETIME_SECONDS = 6;
const INTERRUPT_BOUND_MS = 30_000;
const RUN_DIRECTORY = /^\/tmp\/sf010-event-probe\.[A-Za-z0-9]{6}$/;
const WAIT = 'while [ "$SECONDS" -lt "$SF_LIFETIME" ]; do sleep 0.1; done';
const PROBE_FILES = [
  'bridge/src/event-probe/server.ts',
  'bridge/src/event-probe/main.ts',
  'bridge/test/event-probe.test.ts',
  'bridge/tsconfig.event-probe.json',
];
const REAL_TOOLS = [
  'chmod', 'cmp', 'cut', 'diff', 'dirname', 'env', 'find', 'head', 'id', 'ls', 'mkdir', 'mktemp',
  'mv', 'readlink', 'sha256sum', 'sleep', 'tail', 'touch', 'tr', 'wc', 'xargs',
];
const STUBS: Record<string, string> = {
  'tunnel-client': String.raw`
echo "$*" >> "$SF_STATE/tunnel-client.log"
if [ "$1" = init ]; then
  case "$SF_SCENARIO" in
    init-hang) trap 'exit 0' TERM; ${WAIT}; exit 0 ;;
    init-fail) echo 'init error: refused' >&2; exit 1 ;;
  esac
  exit 0
fi
echo $$ > "$SF_STATE/tunnel.pid"
touch "$SF_STATE/tunnel-ready"
if [ "$SF_SCENARIO" != quiet-log ]; then
  echo 'level=info method=events/list channel=main'
  echo 'level=error msg="sample failure"'
fi
case "$SF_SCENARIO" in
  early-124) sleep 1.5; exit 124 ;;
  early-137) sleep 1.5; kill -KILL $$ ;;
  early-0) sleep 1.5; exit 0 ;;
  late-124|late-137)
    # The child ends by itself, but the launcher can only see that after the stop time.
    sleep 1.5; echo $(( $(cat "$SF_STATE/clock") + 700 )) > "$SF_STATE/clock.new"
    mv "$SF_STATE/clock.new" "$SF_STATE/clock"
    if [ "$SF_SCENARIO" = late-124 ]; then exit 124; fi
    kill -KILL $$ ;;
  scan-unreadable) ( trap '' INT TERM; exec sleep "$SF_LIFETIME" ) & echo $! > "$SF_STATE/hidden.pid"; trap 'exit 0' INT TERM ;;
  ignores-signals|ignores-deadline-int) trap '' INT TERM ;;
  linger) ( trap '' INT TERM; exec sleep "$SF_LIFETIME" ) & trap 'exit 0' INT TERM ;;
  reused-pid) sleep 1.5; echo "$(cat "$SF_STATE/decoy.pid") 1 $(cat /proc/sys/kernel/random/boot_id)" \
    > "$SF010_OWNER/owned/probe.identity"; trap 'exit 0' INT TERM ;;
  unknown-owner) sleep 1.5; echo garbage > "$SF010_OWNER/owned/probe.identity"; trap 'exit 0' INT TERM ;;
  *) trap 'exit 0' INT TERM ;;
esac
${WAIT}`,
  node: String.raw`
if [ "\${1:-}" = -e ]; then exec "$SF_REAL_NODE" "$@"; fi
echo "$*" >> "$SF_STATE/probe-args.log"
if [ "$SF_SCENARIO" = probe-dies ]; then echo 'probe failed'; exit 1; fi
echo $$ > "$SF_STATE/probe.pid"
if [ "$SF_SCENARIO" = ignores-signals ]; then trap '' INT TERM; else trap 'echo stopped; exit 0' INT TERM; fi
echo "sf010-event-probe listening on http://127.0.0.1:$SF010_PROBE_PORT/mcp (lifetime 600s)"
echo '{"at":"x","era":"modern","method":"events/list","protocol":"2026-07-28","auth":false,"status":200}'
${WAIT}`,
  npx: String.raw`
echo "$*" >> "$SF_STATE/npx.log"
case "$SF_SCENARIO" in build-fail|scan-transient) exit 2 ;; esac
case "$SF_SCENARIO" in identity-unreadable*) touch "$SF_STATE/hide-stat" ;; esac
mkdir -p sf010-event-probe-validation-dist`,
  curl: String.raw`
echo "$*" >> "$SF_STATE/curl.log"
url="\${*: -1}"
case "$*" in *8791/mcp*) url=probe ;; esac
case "$url" in
  probe)
    if [ "$SF_SCENARIO" = bad-catalog ]; then echo '{"result":{"events":[]}}'; else echo '{"result":{"events":[{"name":"probe.test"}]}}'; fi ;;
  *8792/readyz)
    if [ -e "$SF_STATE/tunnel-ready" ] && [ "$SF_SCENARIO" != never-ready ]; then echo ok; else exit 7; fi ;;
  *8790/readyz)
    calls=$(grep -c 8790 "$SF_STATE/curl.log")
    if [ "$SF_SCENARIO" = post-health ] && [ "$calls" -gt 1 ]; then exit 7; fi
    echo ok ;;
  *) exit 99 ;;
esac`,
  ss: String.raw`
if [ "$SF_SCENARIO" = ss-fails ]; then exit 1; fi
case "$*" in *' or '*)
  if [ -e "$SF_STATE/occupied" ]; then echo 'LISTEN 0 1 127.0.0.1:8791 0.0.0.0:*'; fi ;;
esac
if [ -s "$SF_STATE/probe.pid" ] && [ -d "/proc/$(cat "$SF_STATE/probe.pid")" ] && [ "$SF_SCENARIO" != post-listener ]; then
  case "$*" in *8791*) echo "LISTEN 0 1 127.0.0.1:8791 0.0.0.0:* users:((\"node\",pid=$(cat "$SF_STATE/probe.pid"),fd=20))" ;; esac
fi
if [ "$SF_SCENARIO" = post-listener ]; then
  case "$*" in
    *' or '*) if [ -e "$SF_STATE/tunnel-ready" ]; then echo 'LISTEN 0 1 127.0.0.1:8792 0.0.0.0:*'; fi ;;
    *8791*) echo "LISTEN 0 1 127.0.0.1:8791 0.0.0.0:* users:((\"node\",pid=$(cat "$SF_STATE/probe.pid"),fd=20))" ;;
  esac
fi`,
  systemctl: String.raw`
echo "$*" >> "$SF_STATE/systemctl.log"
calls=$(wc -l < "$SF_STATE/systemctl.log")
if [ "$SF_SCENARIO" = post-service ] && [ "$calls" -gt 1 ]; then echo inactive; exit 3; fi
echo active`,
  git: String.raw`
ready=false
if [ -e "$SF_STATE/tunnel-ready" ]; then ready=true; fi
case "$*" in
  *status*)
    echo '?? bridge/src/event-probe/main.ts'
    if [ "$SF_SCENARIO" = post-worktree ] && [ "$ready" = true ]; then echo ' M changed-during-the-run'; fi ;;
  *--deleted*)
    if [ "$SF_SCENARIO" = git-deleted-fails ] && [ "$ready" = true ]; then exit 128; fi
    if [ "$SF_SCENARIO" = known-deleted ]; then printf '%s\0' gone.ts; fi ;;
  *--others*|*' -o '*)
    if [ "$SF_SCENARIO" = git-others-fails ] && [ "$ready" = true ]; then exit 128; fi ;;
  *)
    if [ "$SF_SCENARIO" = git-list-fails ] && [ "$ready" = true ]; then exit 128; fi
    echo x >> "$SF_STATE/git-list-calls"
    if [ "$SF_SCENARIO" = git-partial-both ] && [ "$(wc -l < "$SF_STATE/git-list-calls")" -gt 1 ]; then exit 128; fi
    printf '%s\0' bridge/src/event-probe/main.ts
    if [ -f "$SF_STATE/extra-paths" ]; then "$SF_REAL_CAT" "$SF_STATE/extra-paths"; fi
    if [ "$SF_SCENARIO" = known-deleted ]; then printf '%s\0' gone.ts; fi
    if [ "$SF_SCENARIO" = ghost-at-start ]; then printf '%s\0' ghost.ts; fi
    if [ "$SF_SCENARIO" = ghost-path ] && [ "$ready" = true ]; then printf '%s\0' ghost.ts; fi ;;
esac`,
  pgrep: String.raw`cat "$SF_STATE/live.pid"`,
  date: String.raw`
now="$(cat "$SF_STATE/clock")"
if [ "$*" = +%s ]; then echo "$now"; else "$SF_REAL_DATE" -u -d "@$now" +%Y-%m-%dT%H:%M:%SZ; fi`,
  timeout: String.raw`
if [ "$1" = --help ]; then exec "$SF_REAL_TIMEOUT" --help; fi
echo "$*" >> "$SF_STATE/timeout.log"
args=("$@")
while [[ "\${args[0]}" == -* ]]; do
  if [ "\${args[0]}" = -k ]; then args=("\${args[@]:2}"); else args=("\${args[@]:1}"); fi
done
limit="\${args[0]}"
args=("\${args[@]:1}")
case "$*" in *'tunnel-client run'*) ;; *) exec "\${args[@]}" ;; esac
case "$SF_SCENARIO" in
  deadline|ignores-deadline-int|never-ready|cleanup-failure|post-*|git-*|ghost-path|known-deleted|quiet-log|sort-fails|uniq-fails|scan-unrelated|sanitizer-fails)
    # The clock reaches the time the launcher passed, just before the real timeout fires.
    ( sleep 2.5; echo $(( $(cat "$SF_STATE/clock") + limit )) > "$SF_STATE/clock.new"
      mv "$SF_STATE/clock.new" "$SF_STATE/clock" ) &
    exec "$SF_REAL_TIMEOUT" -v -k 0.3 --signal=INT 3 "\${args[@]}" ;;
esac
exec "$SF_REAL_TIMEOUT" -v -k 0.3 --signal=INT "$SF_LIFETIME" "\${args[@]}"`,
  rm: String.raw`
echo "$*" >> "$SF_STATE/rm.log"
if [ "$SF_SCENARIO" = cleanup-failure ]; then
  case "$*" in *sf010-event-probe-validation-dist*) echo 'rm: stub failure' >&2; exit 1 ;; esac
fi
exec "$SF_REAL_RM" "$@"`,
  cat: String.raw`
# Reads of a child's stat fail once the build is done; the live tunnel stays readable.
if [ -e "$SF_STATE/hide-stat" ] && [[ "$1" == /proc/*/stat ]] && [ "$1" != "/proc/$("$SF_REAL_CAT" "$SF_STATE/live.pid")/stat" ]; then
  exit 1
fi
exec "$SF_REAL_CAT" "$@"`,
  grep: String.raw`
if [ "$1" != -lzxF ]; then exec "$SF_REAL_GREP" "$@"; fi
run="\${3#SF010_OWNER=}"
concluding=false
if [ -e "$run/concluding" ]; then concluding=true; fi
case "$SF_SCENARIO" in
  scan-fails) if [ "$concluding" = true ]; then echo 'grep: write error' >&2; exit 2; fi ;;
  scan-blind) if [ "$concluding" = true ]; then exit 1; fi ;;
  scan-unreadable)
    if [ -s "$SF_STATE/hidden.pid" ]; then
      hidden="$("$SF_REAL_CAT" "$SF_STATE/hidden.pid")"
      "$SF_REAL_GREP" "$@" 2>/dev/null | "$SF_REAL_GREP" -v "^/proc/$hidden/environ$"
      echo "grep: /proc/$hidden/environ: Permission denied" >&2
      exit 2
    fi ;;
  scan-transient)
    # Nothing runs at the conclusion of this scenario, so the first scan ends the stop check and the
    # second is the final assessment, which alone sees a live process that refuses the read.
    if [ -e "$run/concluding" ]; then
      echo x >> "$SF_STATE/scans"
      if [ "$(wc -l < "$SF_STATE/scans")" -eq 2 ]; then
        env -u SF010_OWNER sleep 0.3 > /dev/null 2>&1 &
        "$SF_REAL_GREP" "$@" 2>/dev/null
        echo "grep: /proc/$!/environ: Permission denied" >&2
        exit 2
      fi
    fi ;;
  scan-unrelated)
    "$SF_REAL_GREP" "$@" 2>/dev/null
    # Another user, an older process of this user, and a PID that has left /proc.
    echo 'grep: /proc/1/environ: Permission denied' >&2
    echo "grep: /proc/$("$SF_REAL_CAT" "$SF_STATE/decoy.pid")/environ: Permission denied" >&2
    echo 'grep: /proc/4194000/environ: No such process' >&2
    exit 2 ;;
esac
exec "$SF_REAL_GREP" "$@"`,
  sed: String.raw`
if [ "$SF_SCENARIO" = sanitizer-fails ] && [ -e "$SF010_OWNER/concluding" ]; then exit 4; fi
exec "$SF_REAL_SED" "$@"`,
  sort: String.raw`
if [ "$SF_SCENARIO" = sort-fails ] && [ -e "$SF010_OWNER/concluding" ]; then exit 1; fi
exec "$SF_REAL_SORT" "$@"`,
  uniq: String.raw`
if [ "$SF_SCENARIO" = uniq-fails ]; then exit 1; fi
exec "$SF_REAL_UNIQ" "$@"`,
  kill: String.raw`
echo "$*" >> "$SF_STATE/kill.log"
case "$SF_SCENARIO" in kill-fails|identity-unreadable-stop-fails) exit 1 ;; esac
exec "$SF_REAL_KILL" "$@"`,
};

interface Checkpoint {
  state: string;
  outcome: string | null;
  review_boundary: boolean;
  quiescent: boolean;
  cleanup_ok: boolean;
  postchecks_ok: boolean;
  evidence_ok: boolean;
  discovery: string;
  liveness: Record<string, string>;
  unregistered_survivors: number;
  scan_complete: boolean | null;
  unreadable_candidates: number;
  tunnel: {
    exit_status: number | null;
    exit_epoch: number | null;
    stop_at: number | null;
    timer_fired: boolean;
    deadline_reached: boolean;
  };
  errors: string[];
}

interface Sandbox {
  root: string;
  repo: string;
  home: string;
  state: string;
  env: NodeJS.ProcessEnv;
  decoys: ChildProcess[];
}

const sandboxes: Sandbox[] = [];

function realTool(name: string): string {
  const path = ['/usr/bin', '/bin'].map((dir) => join(dir, name)).find((candidate) => existsSync(candidate));
  assert.ok(path, `${name} must exist`);
  return path;
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function writeFixture(repo: string, path: string, content: string): void {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), content);
}

function manifest(repo: string, paths: string[]): string {
  return paths.map((path) => `${sha256(join(repo, path))}  ${path}\n`).join('');
}

function makeSandbox(scenario: string, options: { omit?: string; lifetime?: number } = {}): Sandbox {
  const lifetime = options.lifetime ?? FIXTURE_LIFETIME_SECONDS;
  const root = mkdtempSync(join(tmpdir(), 'sf010-launcher-test-'));
  const [bin, repo, home, state] = ['bin', 'repo', 'home', 'state'].map((name) => join(root, name)) as [
    string, string, string, string,
  ];
  for (const dir of [bin, repo, home, state]) {
    mkdirSync(dir);
  }
  for (const tool of [...REAL_TOOLS, 'bash']) {
    if (tool !== options.omit) {
      symlinkSync(realTool(tool), join(bin, tool));
    }
  }
  for (const [name, body] of Object.entries(STUBS)) {
    if (name !== options.omit) {
      // String.raw keeps the backslash that stops ${...} from interpolating here.
      writeFileSync(join(bin, name), `#!${realTool('bash')}\n${body.replaceAll('\\${', '${')}\n`);
      chmodSync(join(bin, name), 0o755);
    }
  }
  mkdirSync(join(repo, 'scripts'));
  copyFileSync(join(REPOSITORY, LAUNCHER), join(repo, LAUNCHER));
  const live = `tunnel_id: tunnel_live\n`;
  writeFixture(home, '.config/tunnel-client/software-factory.yaml', live);
  const bound = [...PROBE_FILES, 'docs/runbooks/SF-010-event-probe.md', 'bridge/test/event-probe-live.test.ts'];
  for (const path of bound) {
    writeFixture(repo, path, `fixture ${path}\n`);
  }
  writeFixture(repo, `${ACCEPTED}/SOURCE-SHA256SUMS`,
    `${manifest(repo, PROBE_FILES)}${'0'.repeat(64)}  docs/runbooks/SF-010-event-probe.md\n`);
  writeFixture(repo, `${ACCEPTED}/live-profile-baseline.sha256`,
    `${createHash('sha256').update(live).digest('hex')}  live\n`);
  writeFixture(repo, `${BINDING}/SOURCE-SHA256SUMS`, manifest(repo, [...bound, LAUNCHER]));
  writeFileSync(join(state, 'clock'), `${CLOCK_START}\n`);
  const managedSession = process.env[SESSION_TAG];
  const owner = { SF_FIXTURE_OWNER: root, ...(managedSession ? { [SESSION_TAG]: managedSession } : {}) };
  const liveTunnel = spawn(realTool('sleep'), [String(lifetime)], { stdio: 'ignore', env: owner });
  const decoy = spawn(realTool('bash'), ['-c',
    `trap 'echo signalled >> "$0"' TERM INT; while [ "$SECONDS" -lt "$1" ]; do ${realTool('sleep')} 0.1; done`,
    join(state, 'decoy-signals'), String(lifetime)], { stdio: 'ignore', env: owner });
  liveTunnel.unref();
  decoy.unref();
  writeFileSync(join(state, 'live.pid'), `${liveTunnel.pid}\n`);
  writeFileSync(join(state, 'decoy.pid'), `${decoy.pid}\n`);
  const sandbox: Sandbox = {
    root, repo, home, state, decoys: [liveTunnel, decoy],
    env: {
      ...owner, PATH: bin, HOME: home, LANG: 'C', SF_SANDBOX: root, SF_STATE: state,
      SF_SCENARIO: scenario, SF_LIFETIME: String(lifetime),
      SF_REAL_NODE: process.execPath, SF_REAL_DATE: realTool('date'), SF_REAL_TIMEOUT: realTool('timeout'),
      SF_REAL_RM: realTool('rm'), SF_REAL_KILL: realTool('kill'), SF_REAL_CAT: realTool('cat'),
      SF_REAL_GREP: realTool('grep'), SF_REAL_SED: realTool('sed'), SF_REAL_SORT: realTool('sort'),
      SF_REAL_UNIQ: realTool('uniq'),
    },
  };
  sandboxes.push(sandbox);
  return sandbox;
}

function carries(pid: string, marker: string): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const zombie = stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3) === 'Z';
    return !zombie && readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').includes(marker);
  } catch {
    return false;
  }
}

function parentOf(pid: number): number | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
  } catch {
    return undefined;
  }
}

function processesWith(marker: string): number[] {
  return readdirSync('/proc').filter((entry) => /^\d+$/.test(entry) && carries(entry, marker)).map(Number);
}

function sandboxProcesses(sandbox: Sandbox): number[] {
  return processesWith(`SF_SANDBOX=${sandbox.root}`);
}

// Only processes that carry this sandbox's marker, read again right before the signal.
async function reap(root: string): Promise<void> {
  const marker = `SF_FIXTURE_OWNER=${root}`;
  for (let i = 0; i < 100; i += 1) {
    const owned = processesWith(marker);
    if (owned.length === 0) {
      return;
    }
    for (const pid of owned) {
      if (carries(String(pid), marker)) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // It ended since the check.
        }
      }
    }
    await new Promise((resolve_) => setTimeout(resolve_, 20));
  }
  assert.fail(`processes of ${root} survived SIGKILL`);
}

function runDirectory(root: string): string | undefined {
  const path = join(root, 'state', 'stdout');
  return existsSync(path) ? /^SF010_RUN=(.+)$/m.exec(readFileSync(path, 'utf8'))?.[1] : undefined;
}

// By exact path: the run directory this sandbox's launcher printed, then the sandbox.
async function removeSandbox(root: string): Promise<void> {
  await reap(root);
  const run_ = runDirectory(root);
  if (run_ !== undefined && RUN_DIRECTORY.test(run_) && existsSync(join(run_, 'owned-by-this-run'))) {
    rmSync(run_, { recursive: true, force: true });
  }
  rmSync(root, { recursive: true, force: true });
}

afterEach(async () => {
  for (const sandbox of sandboxes.splice(0)) {
    await removeSandbox(sandbox.root);
  }
});

function start(sandbox: Sandbox, args: string[] = ['--operator-approved']): ChildProcess {
  const child = spawn(realTool('bash'), [join(sandbox.repo, LAUNCHER), ...args], {
    env: sandbox.env, cwd: sandbox.repo, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
    writeFileSync(join(sandbox.state, 'stdout'), stdout);
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    writeFileSync(join(sandbox.state, 'stderr'), chunk, { flag: 'a' });
  });
  return child;
}

async function finished(child: ChildProcess): Promise<number> {
  const guard = setTimeout(() => {
    child.kill('SIGKILL');
  }, 45_000);
  const [code] = (await once(child, 'exit')) as [number | null];
  clearTimeout(guard);
  assert.notEqual(code, null, 'the launcher must not be killed by a signal or the guard');
  return code as number;
}

async function run(scenario: string): Promise<{ sandbox: Sandbox; code: number; checkpoint: Checkpoint }> {
  const sandbox = makeSandbox(scenario);
  const code = await finished(start(sandbox));
  return { sandbox, code, checkpoint: checkpointOf(sandbox) };
}

function checkpointOf(sandbox: Sandbox): Checkpoint {
  return JSON.parse(readFileSync(join(sandbox.repo, OUT, 'checkpoint.json'), 'utf8')) as Checkpoint;
}

async function waitFor(condition: () => boolean, label: string, attempts = 200): Promise<void> {
  for (let i = 0; i < attempts; i += 1) {
    if (condition()) {
      return;
    }
    await new Promise((resolve_) => setTimeout(resolve_, 50));
  }
  assert.fail(`timed out waiting for ${label}`);
}

function isReady(sandbox: Sandbox): boolean {
  try {
    return checkpointOf(sandbox).state === 'ready';
  } catch {
    return false;
  }
}

function stateLog(sandbox: Sandbox, name: string): string {
  const path = join(sandbox.state, name);
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

function evidence(sandbox: Sandbox, name: string): string {
  return readFileSync(join(sandbox.repo, OUT, name), 'utf8');
}

function assertQuiescentFailure(sandbox: Sandbox, code: number, checkpoint: Checkpoint): void {
  assert.equal(code, 1, JSON.stringify({ errors: checkpoint.errors, liveness: checkpoint.liveness, scan_complete: checkpoint.scan_complete, unreadable: checkpoint.unreadable_candidates, survivors: checkpoint.unregistered_survivors, evidence_ok: checkpoint.evidence_ok }));
  assert.equal(checkpoint.outcome, 'failed');
  assert.equal(checkpoint.state, 'quiescent');
  assert.equal(checkpoint.review_boundary, true);
  assert.deepEqual(sandboxProcesses(sandbox), []);
}

test('syntax check and no absolute tool paths or real-network bypass in the launcher', () => {
  execFileSync(realTool('bash'), ['-n', join(REPOSITORY, LAUNCHER)]);
  const source = readFileSync(join(REPOSITORY, LAUNCHER), 'utf8');
  assert.doesNotMatch(source, /(^|[\s"'(])\/(usr\/|s?bin\/)/m);
  assert.doesNotMatch(source, /--foreground/);
});

test('every synthetic helper has a finite lifetime of its own', () => {
  const stubs = Object.values(STUBS).join('\n');
  assert.doesNotMatch(stubs, /while :|sleep \d{2,}/);
  assert.match(STUBS['tunnel-client'] as string, /"\$SECONDS" -lt "\$SF_LIFETIME"/);
  assert.match(STUBS.node as string, /"\$SECONDS" -lt "\$SF_LIFETIME"/);
});

test('the launcher binds only the new seven-entry manifest', () => {
  const source = readFileSync(join(REPOSITORY, LAUNCHER), 'utf8');
  assert.match(source, new RegExp(`^BINDING=${BINDING}$`, 'm'));
  assert.doesNotMatch(source, /review\/SF-010\/event-probe-launcher-repair-20261030\//);
});

test('the runbook points to the one launcher and no longer carries runnable start blocks', () => {
  const runbook = readFileSync(join(REPOSITORY, 'docs/runbooks/SF-010-event-probe.md'), 'utf8');
  assert.match(runbook, /scripts\/sf010-event-probe-live\.sh --operator-approved/);
  assert.doesNotMatch(runbook, /tunnel-client (init|run)\b[^\n]*\\$/m);
  assert.doesNotMatch(runbook, /timeout --foreground/);
});

test('refuses without the operator flag and creates nothing', async () => {
  const sandbox = makeSandbox('deadline');
  assert.equal(await finished(start(sandbox, [])), 1);
  assert.match(stateLog(sandbox, 'stderr'), /this is the operator step/);
  assert.equal(existsSync(join(sandbox.repo, OUT)), false);
  assert.equal(stateLog(sandbox, 'tunnel-client.log'), '');
});

for (const missing of ['tunnel-client', 'curl', 'systemctl', 'ss', 'timeout', 'node', 'npx', 'kill', 'git', 'pgrep', 'date', 'rm', 'sha256sum']) {
  test(`a missing ${missing} fails closed before anything starts`, async () => {
    const sandbox = makeSandbox('deadline', { omit: missing });
    assert.equal(await finished(start(sandbox)), 1);
    assert.match(stateLog(sandbox, 'stderr'), new RegExp(`missing command: ${missing}`));
    assert.equal(existsSync(join(sandbox.repo, OUT)), false);
    for (const log of ['tunnel-client.log', 'curl.log', 'systemctl.log', 'npx.log', 'probe-args.log']) {
      assert.equal(stateLog(sandbox, log), '', log);
    }
  });
}

const REFUSALS: Array<[string, RegExp, (sandbox: Sandbox) => void, string?]> = [
  ['an occupied test port', /occupied/, (sandbox) => {
    writeFileSync(join(sandbox.state, 'occupied'), '');
  }],
  ['an unreadable listener table', /occupied/, () => undefined, 'ss-fails'],
  ['existing build output', /validation build output/, (sandbox) => {
    mkdirSync(join(sandbox.repo, DIST));
  }],
  ['a used attempt directory', /already used/, (sandbox) => {
    mkdirSync(join(sandbox.repo, OUT));
    writeFileSync(join(sandbox.repo, OUT, 'keep'), 'old');
  }],
  ['the live tunnel id', /that is the live tunnel/, (sandbox) => {
    const path = join(sandbox.home, '.config/tunnel-client/software-factory.yaml');
    writeFileSync(path, `tunnel_id: ${TUNNEL_ID}\n`);
  }],
  ['a missing live profile', /profile is missing/, (sandbox) => {
    rmSync(join(sandbox.home, '.config/tunnel-client/software-factory.yaml'));
  }],
  ['a changed probe source', /source hash mismatch/, (sandbox) => {
    writeFileSync(join(sandbox.repo, PROBE_FILES[0] as string), 'tampered\n');
  }],
  ['a changed runbook', /source hash mismatch/, (sandbox) => {
    writeFileSync(join(sandbox.repo, 'docs/runbooks/SF-010-event-probe.md'), 'tampered\n');
  }],
  ['no live tunnel process', /live tunnel/, (sandbox) => {
    writeFileSync(join(sandbox.state, 'live.pid'), '');
  }],
  ['a worktree that cannot be captured', /worktree snapshot/, () => undefined, 'ghost-at-start'],
];

for (const [name, reason, arrange, scenario] of REFUSALS) {
  test(`refuses ${name} before anything starts`, async () => {
    const sandbox = makeSandbox(scenario ?? 'deadline');
    arrange(sandbox);
    assert.equal(await finished(start(sandbox)), 1);
    assert.match(stateLog(sandbox, 'stderr'), reason);
    assert.equal(stateLog(sandbox, 'npx.log'), '');
    assert.equal(stateLog(sandbox, 'tunnel-client.log'), '');
    assert.equal(stateLog(sandbox, 'probe-args.log'), '');
    assert.equal(existsSync(join(sandbox.repo, OUT, 'checkpoint.json')), false);
  });
}

test('genuine expiry: one attempt, bounded stop, full evidence, nothing left', async () => {
  const { sandbox, code, checkpoint } = await run('deadline');
  assert.equal(code, 0, stateLog(sandbox, 'stderr'));
  assert.equal(checkpoint.outcome, 'window_completed');
  assert.equal(checkpoint.state, 'quiescent');
  assert.equal(checkpoint.review_boundary, true);
  assert.equal(checkpoint.cleanup_ok, true);
  assert.equal(checkpoint.postchecks_ok, true);
  assert.equal(checkpoint.discovery, 'unverified');
  assert.equal(checkpoint.tunnel.exit_status, 124);
  assert.equal(checkpoint.tunnel.timer_fired, true);
  assert.equal(checkpoint.tunnel.deadline_reached, true);
  assert.equal(checkpoint.scan_complete, true);
  assert.match(evidence(sandbox, 'timeout.log'), /sending signal INT/);
  assert.ok((checkpoint.tunnel.exit_epoch as number) >= (checkpoint.tunnel.stop_at as number));

  // The tunnel gets at most the deadline minus its kill grace and a second of rounding.
  const launch = stateLog(sandbox, 'timeout.log').split('\n').find((line) => line.includes('tunnel-client run'));
  assert.ok(launch);
  assert.match(launch, /^-v -k 5 --signal=INT \d+ bash -c .* tunnel-client run --profile sf010-event-probe --profile-dir /);
  const limit = Number(launch.split(' ')[4]);
  assert.ok(limit > 0 && limit <= 594, `limit ${limit}`);

  const clientCalls = stateLog(sandbox, 'tunnel-client.log').trim().split('\n');
  assert.equal(clientCalls.length, 2);
  assert.ok(clientCalls[0]?.includes(`--tunnel-id ${TUNNEL_ID}`));
  assert.ok(clientCalls[0]?.includes('--mcp-server-url http://127.0.0.1:8791/mcp'));
  assert.ok(clientCalls[0]?.includes('--health-listen-addr 127.0.0.1:8792'));
  assert.ok(clientCalls[0]?.includes(`--control-plane-api-key-ref file:${sandbox.home}/.config/software-factory/tunnel-runtime.key`));
  const profileDir = /--profile-dir (\S+)/.exec(clientCalls[0] as string)?.[1];
  assert.ok(profileDir?.startsWith('/tmp/sf010-event-probe.'));
  assert.ok(clientCalls[1]?.includes(`--profile-dir ${profileDir}`));

  assert.equal(stateLog(sandbox, 'curl.log').match(/8791\/mcp/g)?.length, 1);
  const run_ = runDirectory(sandbox.root) as string;
  assert.equal(existsSync(run_), false);
  assert.equal(existsSync(join(sandbox.repo, DIST)), false);
  assert.match(evidence(sandbox, 'probe.log'), /events\/list/);
  assert.match(evidence(sandbox, 'tunnel-errors.log'), /sample failure/);
  assert.match(evidence(sandbox, 'postchecks.txt'), /^pass worktree unchanged$/m);
  assert.doesNotMatch(evidence(sandbox, 'postchecks.txt'), /^fail /m);
  assert.equal(existsSync(join(sandbox.repo, OUT, '.errors')), false);
  assert.deepEqual(sandboxProcesses(sandbox), []);
});

test('a second run refuses: the attempt cannot be repeated', async () => {
  const { sandbox } = await run('deadline');
  const before = evidence(sandbox, 'checkpoint.json');
  assert.equal(await finished(start(sandbox)), 1);
  assert.equal(evidence(sandbox, 'checkpoint.json'), before);
  assert.equal(stateLog(sandbox, 'tunnel-client.log').trim().split('\n').length, 2);
});

test('a tunnel that needs KILL at the real deadline is still a deadline stop', async () => {
  const { sandbox, code, checkpoint } = await run('ignores-deadline-int');
  assert.equal(code, 0, stateLog(sandbox, 'stderr'));
  assert.equal(checkpoint.outcome, 'window_completed');
  assert.equal(checkpoint.tunnel.exit_status, 137);
  assert.equal(checkpoint.tunnel.deadline_reached, true);
});

test('processes that ignore TERM are escalated to KILL within the bound', async () => {
  const sandbox = makeSandbox('ignores-signals');
  const child = start(sandbox);
  await waitFor(() => isReady(sandbox), 'ready');
  const stopping = Date.now();
  child.kill('SIGINT');
  assert.equal(await finished(child), 130);
  assert.ok(Date.now() - stopping < 12_000);
  assert.equal(checkpointOf(sandbox).review_boundary, true);
  assert.match(stateLog(sandbox, 'kill.log'), /-s KILL/);
});

for (const [scenario, status] of [['early-124', 124], ['early-137', 137], ['early-0', 0]] as const) {
  test(`${scenario}: an early tunnel exit is a failure, not a deadline stop`, async () => {
    const { sandbox, code, checkpoint } = await run(scenario);
    assertQuiescentFailure(sandbox, code, checkpoint);
    assert.equal(checkpoint.tunnel.exit_status, status);
    assert.equal(checkpoint.tunnel.deadline_reached, false);
    assert.match(checkpoint.errors.join('\n'), /not a deadline stop/);
  });
}

for (const [scenario, status] of [['late-124', 124], ['late-137', 137]] as const) {
  test(`${scenario}: a child's own exit seen after the stop time is not a deadline stop`, async () => {
    const { sandbox, code, checkpoint } = await run(scenario);
    assertQuiescentFailure(sandbox, code, checkpoint);
    assert.equal(checkpoint.tunnel.exit_status, status);
    assert.ok((checkpoint.tunnel.exit_epoch as number) >= (checkpoint.tunnel.stop_at as number));
    assert.equal(checkpoint.tunnel.timer_fired, false);
    assert.equal(checkpoint.tunnel.deadline_reached, false);
    assert.match(checkpoint.errors.join('\n'), /not a deadline stop/);
  });
}

test('a tunnel that is never ready fails even at the real deadline', async () => {
  const { sandbox, code, checkpoint } = await run('never-ready');
  assertQuiescentFailure(sandbox, code, checkpoint);
  assert.equal(checkpoint.tunnel.deadline_reached, true);
  assert.match(checkpoint.errors.join('\n'), /never reported ready/);
});

test('cleanup failure survives the later successful health and listing commands', async () => {
  const { sandbox, code, checkpoint } = await run('cleanup-failure');
  assertQuiescentFailure(sandbox, code, checkpoint);
  assert.equal(checkpoint.cleanup_ok, false);
  assert.equal(checkpoint.tunnel.deadline_reached, true);
  assert.match(checkpoint.errors.join('\n'), /cleanup/);
  assert.match(stateLog(sandbox, 'curl.log'), /8790\/readyz\n?$/m);
  assert.match(evidence(sandbox, 'postchecks.txt'), /^pass tunnel health 8790$/m);
  assert.match(evidence(sandbox, 'rollback.log'), /stub failure/);
});

for (const [scenario, name] of [
  ['post-service', 'sf-bridge.service active'],
  ['post-health', 'tunnel health 8790'],
  ['post-worktree', 'worktree unchanged'],
] as const) {
  test(`${scenario}: a failed postcheck is a quiescent boundary without a successful outcome`, async () => {
    const { sandbox, code, checkpoint } = await run(scenario);
    assertQuiescentFailure(sandbox, code, checkpoint);
    assert.equal(checkpoint.postchecks_ok, false);
    assert.equal(checkpoint.cleanup_ok, true);
    assert.match(evidence(sandbox, 'postchecks.txt'), new RegExp(`^fail ${name}$`, 'm'));
  });
}

test('postchecks on the live profile set and hash are enforced', async () => {
  const sandbox = makeSandbox('deadline');
  const child = start(sandbox);
  await waitFor(() => isReady(sandbox), 'ready');
  writeFileSync(join(sandbox.home, '.config/tunnel-client/extra.yaml'), 'x');
  writeFileSync(join(sandbox.home, '.config/tunnel-client/software-factory.yaml'), 'changed');
  const code = await finished(child);
  const checkpoint = checkpointOf(sandbox);
  assert.equal(code, 1);
  assert.equal(checkpoint.outcome, 'failed');
  assert.equal(checkpoint.postchecks_ok, false);
  assert.equal(checkpoint.cleanup_ok, false, 'the run-time hash check belongs to rollback');
  assert.match(evidence(sandbox, 'postchecks.txt'), /^fail live profile hash$/m);
  assert.match(evidence(sandbox, 'postchecks.txt'), /^fail tunnel-client profiles$/m);
});

test('a test port still occupied afterwards leaves no review boundary', async () => {
  const { checkpoint, code } = await run('post-listener');
  assert.equal(code, 3);
  assert.equal(checkpoint.quiescent, false);
  assert.equal(checkpoint.review_boundary, false);
  assert.equal(checkpoint.state, 'uncertain');
  assert.equal(checkpoint.outcome, 'failed');
});

for (const [signal, status] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]] as const) {
  test(`${signal} at ready stops every owned process and reports an interruption`, async () => {
    const sandbox = makeSandbox('wait');
    const child = start(sandbox);
    await waitFor(() => isReady(sandbox), 'ready');
    child.kill(signal);
    const code = await finished(child);
    const checkpoint = checkpointOf(sandbox);
    assert.equal(code, status);
    assert.equal(checkpoint.outcome, 'interrupted');
    assert.equal(checkpoint.review_boundary, true);
    assert.equal(checkpoint.liveness.probe, 'gone');
    assert.equal(checkpoint.liveness.tunnel, 'gone');
    assert.equal(checkpoint.liveness.monitor, 'gone');
    assert.equal(existsSync(runDirectory(sandbox.root) as string), false);
    assert.deepEqual(sandboxProcesses(sandbox), []);
  });
}

test('Ctrl+C on a real terminal reaches the launcher, and the cleanup completes', async () => {
  const sandbox = makeSandbox('wait');
  const command = `${realTool('bash')} ${join(sandbox.repo, LAUNCHER)} --operator-approved`;
  const child = spawn(realTool('script'), ['-qefc', command, '/dev/null'], {
    env: { ...sandbox.env, SHELL: realTool('bash') }, cwd: sandbox.repo, stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk: Buffer) => {
    writeFileSync(join(sandbox.state, 'stdout'), chunk, { flag: 'a' });
  });
  await waitFor(() => isReady(sandbox), 'ready');
  child.stdin.write('\x03');
  assert.equal(await finished(child), 130);
  const checkpoint = checkpointOf(sandbox);
  assert.equal(checkpoint.outcome, 'interrupted');
  assert.equal(checkpoint.review_boundary, true);
  assert.equal(checkpoint.liveness.tunnel, 'gone');
  assert.deepEqual(sandboxProcesses(sandbox), []);
});

test('an interruption during init stops the bounded init at once', async () => {
  const sandbox = makeSandbox('init-hang');
  const child = start(sandbox);
  await waitFor(() => stateLog(sandbox, 'tunnel-client.log') !== '', 'init');
  child.kill('SIGTERM');
  assert.equal(await finished(child), 143);
  const checkpoint = checkpointOf(sandbox);
  assert.equal(checkpoint.outcome, 'interrupted');
  assert.equal(checkpoint.review_boundary, true);
  assert.equal(stateLog(sandbox, 'timeout.log').includes('tunnel-client run'), false);
});

for (const [scenario, message] of [
  ['bad-catalog', /local catalog/],
  ['init-fail', /init/],
  ['build-fail', /build/],
  ['probe-dies', /probe/],
] as const) {
  test(`${scenario}: the EXIT path cleans up and publishes`, async () => {
    const { sandbox, code, checkpoint } = await run(scenario);
    assertQuiescentFailure(sandbox, code, checkpoint);
    assert.match(checkpoint.errors.join('\n'), message);
    assert.equal(stateLog(sandbox, 'timeout.log').includes('tunnel-client run'), false);
    assert.equal(existsSync(join(sandbox.repo, DIST)), false);
  });
}

test('a lingering descendant is found by its run marker and killed', async () => {
  const sandbox = makeSandbox('linger');
  const child = start(sandbox);
  await waitFor(() => isReady(sandbox), 'ready');
  child.kill('SIGTERM');
  assert.equal(await finished(child), 143);
  const checkpoint = checkpointOf(sandbox);
  assert.equal(checkpoint.unregistered_survivors, 0);
  assert.equal(checkpoint.review_boundary, true);
  assert.match(stateLog(sandbox, 'kill.log'), /-s KILL/);
  assert.deepEqual(sandboxProcesses(sandbox), []);
});

test('a failed stop keeps the evidence and reports real liveness without a boundary', async () => {
  const sandbox = makeSandbox('kill-fails');
  const child = start(sandbox);
  await waitFor(() => isReady(sandbox), 'ready');
  child.kill('SIGTERM');
  const code = await finished(child);
  const checkpoint = checkpointOf(sandbox);
  assert.equal(code, 3);
  assert.equal(checkpoint.state, 'uncertain');
  assert.equal(checkpoint.quiescent, false);
  assert.equal(checkpoint.review_boundary, false);
  assert.equal(checkpoint.outcome, 'interrupted');
  assert.equal(checkpoint.liveness.probe, 'alive');
  assert.equal(checkpoint.liveness.tunnel, 'alive');
  assert.match(checkpoint.errors.join('\n'), /still running/);
  assert.match(evidence(sandbox, 'probe.log'), /events\/list/);
  assert.match(evidence(sandbox, 'tunnel-errors.log'), /sample failure/);
  assert.equal(existsSync(join(runDirectory(sandbox.root) as string, 'probe.log')), true);
  assert.equal(existsSync(join(sandbox.repo, DIST)), true);
  // The surviving monitor must not replace the final checkpoint.
  await new Promise((resolve_) => setTimeout(resolve_, 1_500));
  assert.equal(checkpointOf(sandbox).state, 'uncertain');
});

test('a reused PID is never signalled', async () => {
  const { sandbox, code, checkpoint } = await run('reused-pid');
  assert.equal(code, 1);
  assert.equal(checkpoint.liveness.probe, 'reused');
  assert.equal(checkpoint.review_boundary, true);
  assert.equal(stateLog(sandbox, 'decoy-signals'), '');
  assert.equal(stateLog(sandbox, 'kill.log').split('\n').some((line) => line.endsWith(` ${readFileSync(join(sandbox.state, 'decoy.pid'), 'utf8').trim()}`)), false);
  assert.equal(sandbox.decoys[1]?.exitCode, null);
});

test('unknown ownership is reported and blocks the boundary', async () => {
  const { sandbox, code, checkpoint } = await run('unknown-owner');
  assert.equal(code, 3);
  assert.equal(checkpoint.liveness.probe, 'unknown');
  assert.equal(checkpoint.quiescent, false);
  assert.equal(checkpoint.review_boundary, false);
  assert.equal(checkpoint.state, 'uncertain');
  assert.equal(existsSync(runDirectory(sandbox.root) as string), true);
  assert.equal(existsSync(join(sandbox.repo, OUT, 'probe.log')), true);
});

test('a child whose identity cannot be read at launch is gone only once its exit is observed', async () => {
  const { sandbox, code, checkpoint } = await run('identity-unreadable');
  assert.equal(code, 1);
  assert.equal(checkpoint.liveness.probe, 'gone');
  assert.equal(checkpoint.review_boundary, true);
  assert.deepEqual(sandboxProcesses(sandbox), []);
});

test('an unreadable child that survives stays unknown and authorizes nothing', async () => {
  const { sandbox, code, checkpoint } = await run('identity-unreadable-stop-fails');
  assert.equal(code, 3);
  assert.equal(checkpoint.liveness.probe, 'unknown');
  assert.equal(checkpoint.review_boundary, false);
  assert.equal(checkpoint.cleanup_ok, false);
  assert.equal(existsSync(runDirectory(sandbox.root) as string), true);
  assert.equal(existsSync(join(sandbox.repo, DIST)), true);
});

for (const scenario of ['scan-fails', 'scan-blind']) {
  test(`${scenario}: an incomplete scan is not an empty scan`, async () => {
    const sandbox = makeSandbox(scenario);
    const child = start(sandbox);
    await waitFor(() => isReady(sandbox), 'ready');
    child.kill('SIGTERM');
    const code = await finished(child);
    const checkpoint = checkpointOf(sandbox);
    assert.equal(code, 3);
    assert.equal(checkpoint.scan_complete, false);
    assert.equal(checkpoint.quiescent, false);
    assert.equal(checkpoint.review_boundary, false);
    assert.equal(existsSync(runDirectory(sandbox.root) as string), true);
    assert.match(checkpoint.errors.join('\n'), /scan did not complete/);
  });
}

test('an unreadable surviving descendant blocks the boundary and is never signalled', async () => {
  const sandbox = makeSandbox('scan-unreadable');
  const child = start(sandbox);
  await waitFor(() => isReady(sandbox) && existsSync(join(sandbox.state, 'hidden.pid')), 'ready');
  child.kill('SIGTERM');
  const code = await finished(child);
  const checkpoint = checkpointOf(sandbox);
  const hidden = stateLog(sandbox, 'hidden.pid').trim();
  assert.equal(code, 3);
  assert.equal(checkpoint.scan_complete, true);
  assert.equal(checkpoint.unreadable_candidates, 1);
  assert.equal(checkpoint.unregistered_survivors, 0);
  assert.equal(checkpoint.quiescent, false);
  assert.equal(checkpoint.review_boundary, false);
  assert.equal(existsSync(runDirectory(sandbox.root) as string), true);
  assert.equal(existsSync(`/proc/${hidden}`), true);
  assert.equal(stateLog(sandbox, 'kill.log').split('\n').some((line) => line.endsWith(` ${hidden}`)), false);
});

test('a process that refuses the read only for a moment does not withhold the boundary', async () => {
  const { sandbox, code, checkpoint } = await run('scan-transient');
  assert.ok(Number(stateLog(sandbox, 'scans').trim().split('\n').length) >= 3, 'the final scan was read again');
  assertQuiescentFailure(sandbox, code, checkpoint);
  assert.equal(checkpoint.unreadable_candidates, 0);
});

test('vanished, other-user and older unreadable processes are proven unrelated and left alone', async () => {
  const sandbox = makeSandbox('scan-unrelated');
  await new Promise((resolve_) => setTimeout(resolve_, 100));
  const code = await finished(start(sandbox));
  const checkpoint = checkpointOf(sandbox);
  assert.equal(code, 0, stateLog(sandbox, 'stderr'));
  assert.equal(checkpoint.scan_complete, true);
  assert.equal(checkpoint.unreadable_candidates, 0);
  assert.equal(checkpoint.review_boundary, true);
  assert.equal(stateLog(sandbox, 'decoy-signals'), '');
  const decoy = stateLog(sandbox, 'decoy.pid').trim();
  assert.equal(stateLog(sandbox, 'kill.log').split('\n').some((line) => line.endsWith(` ${decoy}`)), false);
});

for (const scenario of ['git-list-fails', 'git-others-fails', 'git-deleted-fails', 'ghost-path']) {
  test(`${scenario}: a capture that cannot enumerate or hash fails the worktree postcheck`, async () => {
    const { sandbox, code, checkpoint } = await run(scenario);
    assertQuiescentFailure(sandbox, code, checkpoint);
    assert.equal(checkpoint.postchecks_ok, false);
    assert.match(evidence(sandbox, 'postchecks.txt'), /^fail worktree unchanged$/m);
  });
}

test('two equally partial captures cannot compare equal', async () => {
  const { sandbox, code, checkpoint } = await run('git-partial-both');
  assertQuiescentFailure(sandbox, code, checkpoint);
  assert.match(checkpoint.errors.join('\n'), /worktree snapshot failed/);
  assert.equal(stateLog(sandbox, 'npx.log'), '');
});

test('a file that stops being readable fails the capture instead of being skipped', async () => {
  const sandbox = makeSandbox('deadline');
  const child = start(sandbox);
  await waitFor(() => isReady(sandbox), 'ready');
  chmodSync(join(sandbox.repo, PROBE_FILES[1] as string), 0o000);
  const code = await finished(child);
  const checkpoint = checkpointOf(sandbox);
  assert.equal(code, 1);
  assert.equal(checkpoint.outcome, 'failed');
  assert.match(evidence(sandbox, 'postchecks.txt'), /^fail worktree unchanged$/m);
});

test('a path Git lists as deleted is captured explicitly and does not fail the run', async () => {
  const { sandbox, code, checkpoint } = await run('known-deleted');
  assert.equal(code, 0, stateLog(sandbox, 'stderr'));
  assert.equal(checkpoint.outcome, 'window_completed');
  assert.match(evidence(sandbox, 'worktree-after.sha256'), /^deleted gone\.ts$/m);
});

test('grep finding no lines is the one benign evidence status', async () => {
  const { sandbox, code, checkpoint } = await run('quiet-log');
  assert.equal(code, 0, stateLog(sandbox, 'stderr'));
  assert.equal(checkpoint.evidence_ok, true);
  assert.equal(evidence(sandbox, 'tunnel-errors.log'), '');
});

for (const scenario of ['sort-fails', 'uniq-fails', 'sanitizer-fails']) {
  test(`${scenario}: a failing evidence stage keeps the private run and withholds the boundary`, async () => {
    const { sandbox, code, checkpoint } = await run(scenario);
    assert.equal(code, 3);
    assert.equal(checkpoint.evidence_ok, false);
    assert.equal(checkpoint.review_boundary, false);
    assert.equal(checkpoint.outcome, 'failed');
    assert.equal(existsSync(join(runDirectory(sandbox.root) as string, 'tunnel-client.log')), true);
  });
}

test('evidence output that cannot be written keeps the private run', async () => {
  const sandbox = makeSandbox('deadline');
  const child = start(sandbox);
  await waitFor(() => isReady(sandbox), 'ready');
  mkdirSync(join(sandbox.repo, OUT, 'tunnel-methods.log'));
  assert.equal(await finished(child), 3);
  const checkpoint = checkpointOf(sandbox);
  assert.equal(checkpoint.evidence_ok, false);
  assert.equal(checkpoint.review_boundary, false);
  assert.equal(existsSync(runDirectory(sandbox.root) as string), true);
});

test('a rollback log that cannot be published keeps the private original and no boundary', async () => {
  const sandbox = makeSandbox('deadline');
  const child = start(sandbox);
  await waitFor(() => isReady(sandbox), 'ready');
  mkdirSync(join(sandbox.repo, OUT, 'rollback.log'));
  assert.equal(await finished(child), 3);
  const checkpoint = checkpointOf(sandbox);
  assert.equal(checkpoint.evidence_ok, false);
  assert.equal(checkpoint.review_boundary, false);
  assert.equal(checkpoint.outcome, 'failed');
  assert.match(evidence(sandbox, '.rollback'), /OK/);
});

function linkFixture(sandbox: Sandbox, path: string, target: string): void {
  rmSync(join(sandbox.repo, path), { force: true, recursive: true });
  symlinkSync(target, join(sandbox.repo, path));
}

function listPaths(sandbox: Sandbox, paths: string[]): void {
  writeFileSync(join(sandbox.state, 'extra-paths'), paths.map((path) => `${path}\0`).join(''));
}

function equalReferents(sandbox: Sandbox): void {
  writeFixture(sandbox.repo, 'first.txt', 'equal content\n');
  writeFixture(sandbox.repo, 'second.txt', 'equal content\n');
  listPaths(sandbox, ['first.txt', 'second.txt', 'link']);
}

const CHANGES: Array<[string, (sandbox: Sandbox) => void, (sandbox: Sandbox) => void]> = [
  ['a dangling link retargeted', (sandbox) => {
    listPaths(sandbox, ['link']);
    linkFixture(sandbox, 'link', 'missing-one');
  }, (sandbox) => linkFixture(sandbox, 'link', 'missing-two')],
  ['a link retargeted between equal-content files', (sandbox) => {
    equalReferents(sandbox);
    linkFixture(sandbox, 'link', 'first.txt');
  }, (sandbox) => linkFixture(sandbox, 'link', 'second.txt')],
  ['a link replaced by a file with its content', (sandbox) => {
    equalReferents(sandbox);
    linkFixture(sandbox, 'link', 'first.txt');
  }, (sandbox) => {
    rmSync(join(sandbox.repo, 'link'));
    writeFixture(sandbox.repo, 'link', 'equal content\n');
  }],
  ['a link whose referent changes kind', (sandbox) => {
    listPaths(sandbox, ['link']);
    linkFixture(sandbox, 'link', 'referent');
  }, (sandbox) => mkdirSync(join(sandbox.repo, 'referent'))],
  ['a link retargeted between directories', (sandbox) => {
    mkdirSync(join(sandbox.repo, 'one'));
    mkdirSync(join(sandbox.repo, 'two'));
    listPaths(sandbox, ['link']);
    linkFixture(sandbox, 'link', 'one');
  }, (sandbox) => linkFixture(sandbox, 'link', 'two')],
  ['a link in the ignored build retargeted', (sandbox) => {
    writeFixture(sandbox.repo, 'first.txt', 'equal content\n');
    writeFixture(sandbox.repo, 'second.txt', 'equal content\n');
    mkdirSync(join(sandbox.repo, 'bridge/dist'));
    linkFixture(sandbox, 'bridge/dist/link', '../../first.txt');
  }, (sandbox) => linkFixture(sandbox, 'bridge/dist/link', '../../second.txt')],
  ['a file replaced by a directory', (sandbox) => {
    writeFixture(sandbox.repo, 'plain.txt', 'plain\n');
    listPaths(sandbox, ['plain.txt']);
  }, (sandbox) => {
    rmSync(join(sandbox.repo, 'plain.txt'));
    mkdirSync(join(sandbox.repo, 'plain.txt'));
  }],
];

for (const [name, arrange, change] of CHANGES) {
  test(`${name} fails the worktree postcheck`, async () => {
    const sandbox = makeSandbox('deadline');
    arrange(sandbox);
    const child = start(sandbox);
    await waitFor(() => isReady(sandbox), 'ready');
    change(sandbox);
    assertQuiescentFailure(sandbox, await finished(child), checkpointOf(sandbox));
    assert.equal(checkpointOf(sandbox).postchecks_ok, false);
    assert.match(evidence(sandbox, 'postchecks.txt'), /^fail worktree unchanged$/m);
  });
}

test('unchanged links pass, and their targets and kinds are in the capture', async () => {
  const sandbox = makeSandbox('deadline');
  equalReferents(sandbox);
  mkdirSync(join(sandbox.repo, 'folder'));
  listPaths(sandbox, ['first.txt', 'second.txt', 'to-file', 'to-folder', 'to nothing']);
  linkFixture(sandbox, 'to-file', 'first.txt');
  linkFixture(sandbox, 'to-folder', 'folder');
  linkFixture(sandbox, 'to nothing', 'no where');
  const code = await finished(start(sandbox));
  assert.equal(code, 0, checkpointOf(sandbox).errors.join('\n'));
  const capture = evidence(sandbox, 'worktree-after.sha256');
  const equal = createHash('sha256').update('equal content\n').digest('hex');
  assert.match(capture, new RegExp(`^symlink to-file -> first\\.txt file ${equal}$`, 'm'));
  assert.match(capture, /^symlink to-folder -> folder directory$/m);
  assert.match(capture, /^symlink to\\ nothing -> no\\ where dangling$/m);
});

const UNSUPPORTED: Array<[string, (sandbox: Sandbox) => void]> = [
  ['a directory, as Git lists a gitlink or nested repository', (sandbox) => {
    mkdirSync(join(sandbox.repo, 'nested/.git'), { recursive: true });
    listPaths(sandbox, ['nested/']);
  }],
  ['a FIFO', (sandbox) => {
    execFileSync(realTool('mkfifo'), [join(sandbox.repo, 'pipe')]);
    listPaths(sandbox, ['pipe']);
  }],
  ['a link to a FIFO', (sandbox) => {
    execFileSync(realTool('mkfifo'), [join(sandbox.repo, 'pipe')]);
    listPaths(sandbox, ['link']);
    linkFixture(sandbox, 'link', 'pipe');
  }],
];

for (const [name, arrange] of UNSUPPORTED) {
  test(`${name} is refused before an attempt is used`, async () => {
    const sandbox = makeSandbox('deadline');
    arrange(sandbox);
    assert.equal(await finished(start(sandbox)), 1);
    assert.match(stateLog(sandbox, 'stderr'), /unsupported path kind/);
    assert.match(stateLog(sandbox, 'stderr'), /worktree snapshot failed/);
    assert.equal(existsSync(join(sandbox.repo, OUT)), false);
    assert.equal(stateLog(sandbox, 'npx.log'), '');
    assert.equal(stateLog(sandbox, 'tunnel-client.log'), '');
  });
}

for (const name of ['--help', '--version', '-', '-c']) {
  test(`a file named ${name} is hashed as a file, and a change of it or of its neighbour is seen`, async () => {
    for (const changed of [name, 'neighbour.txt']) {
      const sandbox = makeSandbox('deadline');
      writeFixture(sandbox.repo, name, 'before\n');
      writeFixture(sandbox.repo, 'neighbour.txt', 'before\n');
      listPaths(sandbox, [name, 'neighbour.txt']);
      const child = start(sandbox);
      await waitFor(() => isReady(sandbox), 'ready');
      const before = createHash('sha256').update('before\n').digest('hex');
      assert.match(evidence(sandbox, 'worktree-before.sha256'), new RegExp(`^${before}  \\./${name}$`, 'm'));
      writeFixture(sandbox.repo, changed, 'after\n');
      assertQuiescentFailure(sandbox, await finished(child), checkpointOf(sandbox));
      assert.match(evidence(sandbox, 'postchecks.txt'), /^fail worktree unchanged$/m);
    }
  });
}

// The other half of the next test: a runner of its own, which that test kills at ready.
const interruptFile = process.env.SF010_INTERRUPT_FILE;
if (interruptFile !== undefined) {
  test('interrupted fixture child', async () => {
    const sandbox = makeSandbox('ignores-signals', { lifetime: INTERRUPT_LIFETIME_SECONDS });
    writeFileSync(interruptFile, sandbox.root);
    const child = start(sandbox);
    await waitFor(() => isReady(sandbox), 'ready');
    writeFileSync(`${interruptFile}.tmp`, '');
    renameSync(`${interruptFile}.tmp`, `${interruptFile}.ready`);
    await finished(child);
  });
}

test('a test runner killed abruptly leaves nothing running past the fixed bound', async () => {
  // The real tag inside a managed session, which the owning supervisor scans for; only outside one a
  // synthetic tag. The real one is also on enclosing processes, so checks stay on fixture-owned PIDs.
  const enclosing = process.env[SESSION_TAG];
  const session = enclosing || randomUUID();
  if (enclosing) {
    assert.equal(session, enclosing, 'the enclosing managed-session tag is reused');
  }
  const tag = `${SESSION_TAG}=${session}`;
  const scratch = mkdtempSync(join(tmpdir(), 'sf010-interrupt-test-'));
  const file = join(scratch, 'sandbox');
  const env: NodeJS.ProcessEnv = { ...process.env, SF010_INTERRUPT_FILE: file, [SESSION_TAG]: session };
  delete env.NODE_TEST_CONTEXT;
  const runner = spawn(process.execPath, ['--test-name-pattern=interrupted fixture child', fileURLToPath(import.meta.url)], {
    env, stdio: 'ignore',
  });
  let root: string | undefined;
  try {
    await waitFor(() => existsSync(`${file}.ready`), 'the runner to reach ready', 400);
    root = readFileSync(file, 'utf8');
    const marker = `SF_FIXTURE_OWNER=${root}`;
    // The launcher, tunnel, probe, monitor and both decoys.
    assert.ok(processesWith(marker).length >= 6, 'the fixture is running');
    const untagged = (): number[] => processesWith(marker).filter((pid) => !carries(String(pid), tag) && carries(String(pid), marker));
    assert.deepEqual(untagged(), []);
    const killed = Date.now();
    runner.kill('SIGKILL');
    await once(runner, 'exit');
    const orphans = processesWith(marker);
    assert.ok(orphans.length > 0, 'orphaned helpers outlive the runner');
    assert.equal(orphans.some((pid) => parentOf(pid) === runner.pid), false, 'every helper was reparented');
    while (processesWith(marker).length > 0) {
      assert.deepEqual(untagged(), [], 'an orphan stays visible to the writer guard until it has ended');
      assert.ok(Date.now() - killed < INTERRUPT_BOUND_MS, `still running: ${processesWith(marker).join(' ')}`);
      await new Promise((resolve_) => setTimeout(resolve_, 100));
    }
  } finally {
    runner.kill('SIGKILL');
    if (root === undefined && existsSync(file)) {
      root = readFileSync(file, 'utf8');
    }
    if (root !== undefined) {
      await removeSandbox(root);
    }
    rmSync(scratch, { recursive: true, force: true });
  }
});
