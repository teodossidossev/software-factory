// SF-099, split from test/mcp-auth.test.ts so that no file runs near run-tests' per-file limit:
// scripts/sf-tunnel.sh with a fake tunnel-client and the real sf CLI never holds the MCP token, and
// its tunnel client's output never shows it (init, check, run, doctor). The endpoint, sf mcp-url and
// sf up are test/mcp-auth.test.ts's.
import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import { chmod, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { MCP_TOKEN_FILE } from '../src/server.js';
import { type Env, newEnv, processEnv, serve, type Served, stop, temp } from './support/harness.js';

const SF_BIN = fileURLToPath(new URL('../../bin/sf', import.meta.url));
const TUNNEL_SCRIPT = fileURLToPath(new URL('../../../scripts/sf-tunnel.sh', import.meta.url));

const tokenOf = async (env: Env): Promise<string> => (await readFile(join(env.state, MCP_TOKEN_FILE), 'utf8')).trim();
const portOf = (served: Served): string => served.url.port;

// The tunnel script with a fake tunnel-client on PATH and the real sf CLI (SF_CLI).
interface TunnelSetup {
  env: Env;
  scriptEnv: NodeJS.ProcessEnv;
  profileFile: string;
  clientLog: string;
  pidFile: string;
}

const FAKE_CLIENT = `#!/usr/bin/env bash
echo "$*" >> "$FAKE_TC_LOG"
cmd="$1"; shift
dir=; profile=; url=; tunnel=; key=
while [[ $# -gt 0 ]]; do
  case "$1" in
    --profile-dir) dir="$2"; shift 2 ;;
    --profile) profile="$2"; shift 2 ;;
    --mcp-server-url) url="$2"; shift 2 ;;
    --tunnel-id) tunnel="$2"; shift 2 ;;
    --control-plane-api-key-ref) key="$2"; shift 2 ;;
    *) shift ;;
  esac
done
case "$cmd" in
  --version) echo "tunnel-client 0.0.18+fake" ;;
  init)
    # Wider modes than the factory keeps: the script narrows them (R4).
    mkdir -p "$dir"; chmod 755 "$dir"
    (umask 022; printf 'config_version: 1\\ncontrol_plane:\\n  base_url: "https://api.openai.com"\\n\\n  tunnel_id: "%s"\\n  api_key: "%s"\\nmcp:\\n  server_urls:\\n    - channel: main\\n      url: "%s"\\n' "$tunnel" "$key" "$url" > "$dir/$profile.yaml")
    echo "profile written" ;;
  run|doctor)
    echo $$ > "$FAKE_TC_PID"
    line=$(grep -E '^ +url:' "$dir/$profile.yaml")
    echo "fake out $line"
    echo "fake err $line" >&2
    [[ "$cmd" == doctor ]] && exit 0
    [[ -n "\${FAKE_TC_EXIT:-}" ]] && exit "$FAKE_TC_EXIT"
    trap 'echo "fake last $line"; exit 7' TERM
    while :; do sleep 0.1; done ;;
esac
`;

async function tunnelSetup(name: string, port: string): Promise<TunnelSetup> {
  const env = await newEnv(name);
  const root = join(temp, name);
  const bin = join(root, 'bin');
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, 'tunnel-client'), FAKE_CLIENT);
  await chmod(join(bin, 'tunnel-client'), 0o755);
  const keyFile = join(root, 'keys', 'tunnel-runtime.key');
  await mkdir(dirname(keyFile), { recursive: true, mode: 0o700 });
  await writeFile(keyFile, 'runtime-key-value', { mode: 0o600 });
  const profileDir = join(root, 'profiles');
  const clientLog = join(root, 'client.log');
  const pidFile = join(root, 'client.pid');
  const scriptEnv = {
    ...processEnv(env), SF_PORT: port, PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`, SF_CLI: SF_BIN,
    TUNNEL_CLIENT_PROFILE_DIR: profileDir, SF_TUNNEL_KEY_FILE: keyFile, FAKE_TC_LOG: clientLog, FAKE_TC_PID: pidFile,
  };
  return { env, scriptEnv, profileFile: join(profileDir, 'software-factory.yaml'), clientLog, pidFile };
}

interface ScriptRun {
  child: ChildProcess;
  out(): string;
  err(): string;
  done: Promise<number | null>;
}

// The scripts and fake clients of these tests: a failed assertion must not leave one running.
const scripts = new Set<ChildProcess>();
const pidFiles = new Set<string>();
const states = new Set<string>();
after(async () => {
  for (const child of scripts) {
    child.kill('SIGKILL');
  }
  // The filters hold the scripts' pipes: one left would keep this test file from ending.
  for (const state of states) {
    for (const pid of await filtersAlive(state)) {
      process.kill(pid, 'SIGKILL');
    }
  }
  for (const file of pidFiles) {
    const pid = Number((await readFile(file, 'utf8').catch(() => '')).trim());
    if (pid > 0 && alive(pid)) {
      process.kill(pid, 'SIGKILL');
    }
  }
});

function runScript(setup: TunnelSetup, args: string[], extra: Record<string, string> = {}): ScriptRun {
  const child = spawn(TUNNEL_SCRIPT, args, { env: { ...setup.scriptEnv, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
  scripts.add(child);
  pidFiles.add(setup.pidFile);
  states.add(setup.env.state);
  child.once('exit', () => scripts.delete(child));
  let out = '';
  let err = '';
  child.stdout!.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')));
  child.stderr!.on('data', (chunk: Buffer) => (err += chunk.toString('utf8')));
  // close: the filters, which hold the pipes too, have ended as well.
  const done = new Promise<number | null>((resolve) => child.once('close', (code) => resolve(code)));
  return { child, out: () => out, err: () => err, done };
}

// The sf mcp-url --redact filters of this state directory still alive.
async function filtersAlive(state: string): Promise<number[]> {
  const alive: number[] = [];
  for (const pid of (await readdir('/proc')).filter((entry) => /^\d+$/.test(entry))) {
    const command = await readFile(`/proc/${pid}/cmdline`, 'utf8').catch(() => '');
    const environ = await readFile(`/proc/${pid}/environ`, 'utf8').catch(() => '');
    if (command.includes('mcp-url\0--redact') && environ.includes(`SF_STATE_DIR=${state}\0`)) {
      alive.push(Number(pid));
    }
  }
  return alive;
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// 60 s: before its client starts, the script runs the sf CLI five times, each a Node start, slow
// under the whole suite's load.
async function until(condition: () => boolean, what: string, run: ScriptRun): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (!condition()) {
    assert.ok(Date.now() < deadline, `timed out waiting for ${what}:\n${run.out()}\n${run.err()}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

// The tunnel set up by the first script test, run by the second.
let tunnel: TunnelSetup;

test('scripts/sf-tunnel.sh init and check: the token goes into the profile without being printed or passed on a command line; the check takes only the current token', async () => {
  const setup = await tunnelSetup('mcp-tunnel', '0');
  tunnel = setup;
  // SF_PORT=0 and no sf serve: the port is not known; the script relays why.
  const unknown = runScript(setup, ['init', 'tunnel_abc123']);
  assert.equal(await unknown.done, 1);
  assert.match(unknown.err(), /^sf-tunnel: FAIL: SF_PORT is 0 \(any free port\).*\(mcp_port_unknown\)/m);
  // Without a token file: the script says to start sf serve first.
  const early = runScript(setup, ['init', 'tunnel_abc123'], { SF_PORT: '8787' });
  assert.equal(await early.done, 1);
  assert.match(early.err(), /sf-tunnel: FAIL: no MCP token yet: start sf serve first/);

  const served = await serve(setup.env);
  const port = portOf(served);
  setup.scriptEnv.SF_PORT = port;
  const token = await tokenOf(setup.env);
  const shown = `http://127.0.0.1:${port}/mcp/<token>`;
  try {
    // init: the plain URL on the client's command line, then the token in the file only.
    const init = runScript(setup, ['init', 'tunnel_abc123']);
    assert.equal(await init.done, 0, init.err());
    assert.match(await readFile(setup.clientLog, 'utf8'), new RegExp(`--mcp-server-url http://127\\.0\\.0\\.1:${port}/mcp `));
    assert.match(await readFile(setup.profileFile, 'utf8'), new RegExp(`^ {6}url: "http://127\\.0\\.0\\.1:${port}/mcp/${token}"$`, 'm'));
    assert.equal((await stat(setup.profileFile)).mode & 0o777, 0o600);
    assert.equal((await stat(dirname(setup.profileFile))).mode & 0o777, 0o700);
    assert.match(init.out(), new RegExp(`sf-tunnel: ok: profile MCP url set to ${shown.replace(/[.]/g, '\\.')}`));

    // check: every step passes; a plain /mcp profile fails with the redacted message.
    const check = runScript(setup, ['check']);
    assert.equal(await check.done, 0, check.err());
    assert.match(check.out(), /sf-tunnel: ok: factory answers at http:\/\/127\.0\.0\.1:\d+\/mcp\/<token>/);
    const good = await readFile(setup.profileFile, 'utf8');
    await writeFile(setup.profileFile, good.replace(`/mcp/${token}`, '/mcp'));
    const stale = runScript(setup, ['check']);
    assert.equal(await stale.done, 1);
    assert.match(stale.err(), /^sf-tunnel: FAIL: profile MCP url is not the factory's URL \(\/mcp\/<token>\)$/m);
    await writeFile(setup.profileFile, good);

    const commandLines = await readFile(setup.clientLog, 'utf8');
    for (const text of [commandLines, init.out(), init.err(), check.out(), check.err(), stale.err()]) {
      assert.ok(!text.includes(token), text);
    }
  } finally {
    await stop(served);
  }

  // Nothing answers: the check says so, with the redacted URL.
  const down = runScript(setup, ['check']);
  assert.equal(await down.done, 1);
  assert.match(down.err(), /^sf-tunnel: FAIL: factory not reachable at http:\/\/127\.0\.0\.1:\d+\/mcp\/<token> \(start it: npm run serve\)$/m);
});

test('scripts/sf-tunnel.sh run and doctor: the stale profile rewritten; the output filter hides the token; SIGTERM and SIGINT stop the client and leave no process; its exit status is the script\'s', async () => {
  const setup = tunnel;
  const served = await serve(setup.env);
  setup.scriptEnv.SF_PORT = portOf(served);
  const token = await tokenOf(setup.env);
  const shown = `http://127.0.0.1:${portOf(served)}/mcp/<token>`;
  // A profile of before SF-099: the plain /mcp URL.
  await writeFile(setup.profileFile, (await readFile(setup.profileFile, 'utf8')).replace(`/mcp/${token}`, '/mcp'));
  try {
    // run: the plain profile is rewritten, the client prints the URL on both streams, only <token>
    // comes out; SIGTERM to the script stops the client, its last line comes through, its status is the script's.
    const run = runScript(setup, ['run']);
    await until(() => run.out().includes('fake out') && run.err().includes('fake err'), 'the client\'s lines', run);
    assert.match(await readFile(setup.profileFile, 'utf8'), new RegExp(`/mcp/${token}"`));
    run.child.kill('SIGTERM');
    assert.equal(await run.done, 7, run.err());
    assert.match(run.out(), new RegExp(`^fake out +url: "${shown.replace(/[.]/g, '\\.')}"$`, 'm'));
    assert.match(run.err(), new RegExp(`^fake err +url: "${shown.replace(/[.]/g, '\\.')}"$`, 'm'));
    assert.match(run.out(), /^fake last +url: "http:\/\/127\.0\.0\.1:\d+\/mcp\/<token>"$/m);
    const clientPid = Number((await readFile(setup.pidFile, 'utf8')).trim());
    assert.equal(alive(clientPid), false);
    assert.deepEqual(await filtersAlive(setup.env.state), []);

    // SIGINT (Ctrl+C) stops it the same way.
    const interrupted = runScript(setup, ['run']);
    await until(() => interrupted.out().includes('fake out'), 'the client\'s line', interrupted);
    interrupted.child.kill('SIGINT');
    assert.equal(await interrupted.done, 7, interrupted.err());
    assert.equal(alive(Number((await readFile(setup.pidFile, 'utf8')).trim())), false);
    assert.deepEqual(await filtersAlive(setup.env.state), []);

    // A client that ends by itself: its status, every line through the filters.
    const exits = runScript(setup, ['run'], { FAKE_TC_EXIT: '3' });
    assert.equal(await exits.done, 3, exits.err());
    assert.match(exits.out(), /^fake out +url: "http:\/\/127\.0\.0\.1:\d+\/mcp\/<token>"$/m);
    assert.match(exits.err(), /^fake err +url: "http:\/\/127\.0\.0\.1:\d+\/mcp\/<token>"$/m);

    // doctor: the same filters.
    const doctor = runScript(setup, ['doctor']);
    assert.equal(await doctor.done, 0, doctor.err());
    assert.match(doctor.out(), /^fake out +url: "http:\/\/127\.0\.0\.1:\d+\/mcp\/<token>"$/m);

    // No token on any command line of the client, nor in any output.
    const commandLines = await readFile(setup.clientLog, 'utf8');
    for (const text of [commandLines, run.out(), run.err(), interrupted.out(), interrupted.err(), exits.out(), exits.err(), doctor.out(), doctor.err()]) {
      assert.ok(!text.includes(token), text);
    }
  } finally {
    await stop(served);
  }
});

test('scripts/sf-tunnel.sh: without SF_CLI it uses factory/bin/sf of its repository, and the script holds no token', async () => {
  const text = await readFile(TUNNEL_SCRIPT, 'utf8');
  assert.match(text, /SF="\$ROOT\/factory\/bin\/sf"/);
  assert.match(text, /factory\/dist\/src\/cli\.js" \]\] \|\| fail "the factory is not built .*run npm run setup"/);
  assert.doesNotMatch(text, /mcp-token|8787/);
  assert.doesNotMatch(text, /\bexec tunnel-client/);
});
