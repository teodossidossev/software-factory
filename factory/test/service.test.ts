// sf service (SF-101) with a fake systemctl and loginctl: the unit file sf service install writes
// (KillMode=process, the CPU cap and Nice=10 of SF-116, the shell's PATH and directory settings,
// nothing else), the refusal while a hand-started sf serve answers, the reinstall while the
// service's own sf serve answers (SF-120: rewrite and restart, refused while it is busy), the
// machine without systemd user services, the linger warning, uninstall and status; then the CLI
// with fake systemctl and loginctl on PATH.
import assert from 'node:assert/strict';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { FactoryError } from '../src/errors.js';
import { type CommandOutput, type RunCommand, serviceCommand, type ServiceOptions, unitPath, unitText } from '../src/service.js';
import { callSocket } from '../src/ipc.js';
import { newEnv, runCli, serve, stop, temp } from './support/harness.js';

interface Fake {
  calls: string[];
  run: RunCommand;
}

// systemctl and loginctl as answers by command line; every call logged.
function fakeCommands(answers: Record<string, Partial<CommandOutput>> = {}): Fake {
  const calls: string[] = [];
  return {
    calls,
    run: async (file, args) => {
      const line = [file, ...args].join(' ');
      calls.push(line);
      const answer = answers[line] ?? (file === 'loginctl' ? { stdout: 'Linger=yes\n' } : {});
      return { code: 0, stdout: '', stderr: '', ...answer };
    },
  };
}

function options(home: string, fake: Fake, extra: Partial<ServiceOptions> = {}): ServiceOptions & { lines: string[] } {
  const lines: string[] = [];
  return {
    env: { PATH: '/opt/node/bin:/home/u/.local/bin', HOME: home, SF_STATE_DIR: '/state dir/sf', XDG_CONFIG_HOME: join(home, 'cfg'), SF_GATE: 'off', SF_GITHUB_TOKEN: 'secret', OTHER: 'x' },
    sf: '/opt/sf/factory/bin/sf', cores: 20, run: fake.run, serveAnswers: async () => false, print: (line) => lines.push(line), home, user: 'u', lines, ...extra,
  };
}

test('sf service install writes the unit with KillMode=process, the PATH and the directory settings, and enables it', async () => {
  const home = join(temp, 'service-install');
  const fake = fakeCommands();
  const opts = options(home, fake, { fromEnvFile: ['SF_GITHUB_TOKEN'] });
  await serviceCommand('install', opts);
  const path = unitPath(opts.env, home);
  assert.equal(path, join(home, 'cfg', 'systemd', 'user', 'software-factory.service'));
  const unit = await readFile(path, 'utf8');
  assert.match(unit, /^KillMode=process$/m);
  assert.match(unit, /^Restart=on-failure$/m);
  assert.match(unit, /^ExecStart="\/opt\/sf\/factory\/bin\/sf" serve$/m);
  // The limits right after KillMode=process, under the comment that says why.
  const lines = unit.split('\n');
  const kill = lines.indexOf('KillMode=process');
  assert.match(lines[kill + 1]!, /^# .*responsive.*software-factory\.service\.d\//);
  assert.deepEqual(lines.slice(kill + 2, kill + 4), ['CPUQuota=800%', 'Nice=10']);
  const environment = unit.split('\n').filter((line) => line.startsWith('Environment='));
  assert.deepEqual(environment, [
    'Environment="PATH=/opt/node/bin:/home/u/.local/bin"',
    `Environment="XDG_CONFIG_HOME=${join(home, 'cfg')}"`,
    'Environment="SF_STATE_DIR=/state dir/sf"',
  ]);
  // Nothing secret, nothing else.
  assert.doesNotMatch(unit, /secret|SF_GATE|OTHER/);
  assert.deepEqual(fake.calls, ['systemctl --user show-environment', 'loginctl show-user u --property=Linger', 'systemctl --user daemon-reload', 'systemctl --user enable --now software-factory']);
  // SF_GATE is the shell's own, not auth.env's: named; SF_GITHUB_TOKEN came from auth.env: not.
  assert.ok(opts.lines.some((line) => line.includes('Not copied into the unit: SF_GATE.') && line.includes('auth.env')), opts.lines.join('\n'));
  assert.ok(!opts.lines.some((line) => line.includes('SF_GITHUB_TOKEN')));
  assert.ok(opts.lines.some((line) => line.includes('journalctl --user -u software-factory')));
  assert.ok(opts.lines.some((line) => line.startsWith(`Wrote ${path} `) && line.includes('CPUQuota=800%, Nice=10')), opts.lines.join('\n'));
});

test('the unit caps the CPU at half the cores, at least one and at most eight, at Nice=10, in [Service]', () => {
  for (const [cores, quota] of [[20, '800%'], [32, '800%'], [7, '300%'], [1, '100%']] as const) {
    const lines = unitText('/opt/sf', { PATH: '/bin' }, cores).split('\n');
    const service = lines.indexOf('[Service]');
    const install = lines.indexOf('[Install]');
    const kill = lines.indexOf('KillMode=process');
    const cpu = lines.indexOf(`CPUQuota=${quota}`);
    const nice = lines.indexOf('Nice=10');
    assert.ok(service < kill && kill < cpu && cpu < nice && nice < install, `${cores} cores:\n${lines.join('\n')}`);
    assert.equal(lines.filter((line) => line.startsWith('CPUQuota=')).length, 1);
    assert.equal(lines.filter((line) => line.startsWith('Nice=')).length, 1);
  }
});

test('the unit text escapes specifiers and quotes', () => {
  const unit = unitText('/a b/sf', { PATH: '/x%y:/q"z' }, 20);
  assert.match(unit, /^ExecStart="\/a b\/sf" serve$/m);
  assert.match(unit, /^Environment="PATH=\/x%%y:\/q\\"z"$/m);
});

test('sf service install warns when lingering is off and does not turn it on', async () => {
  const home = join(temp, 'service-linger');
  const fake = fakeCommands({ 'loginctl show-user u --property=Linger': { stdout: 'Linger=no\n' } });
  const opts = options(home, fake);
  await serviceCommand('install', opts);
  assert.ok(opts.lines.some((line) => /lingering is off/.test(line) && line.includes('loginctl enable-linger u')), opts.lines.join('\n'));
  assert.ok(!fake.calls.some((call) => call.includes('enable-linger')));
});

test('sf service install refuses with serve_running while a hand-started sf serve answers, before it writes anything', async () => {
  const home = join(temp, 'service-running');
  const fake = fakeCommands();
  const opts = options(home, fake, { serveAnswers: async () => true });
  await assert.rejects(serviceCommand('install', opts), (error: unknown) => {
    assert.ok(error instanceof FactoryError);
    assert.equal(error.code, 'serve_running');
    assert.match(error.message, /Stop that sf serve first/);
    assert.match(error.message, /keep running/);
    return true;
  });
  assert.equal(existsSync(unitPath(opts.env, home)), false);
  assert.ok(!fake.calls.some((call) => call.includes('enable') || call.includes('daemon-reload')));
});

const MAIN_PID = 'systemctl --user show software-factory --property=MainPID --value';
const RELOADS_OR_RESTARTS = (call: string): boolean => call.includes('daemon-reload') || call.includes('enable') || call.includes('restart');

// The service's own sf serve answers: its pid from ping is the service's MainPID (SF-120).
function ownServe(answers: Record<string, Partial<CommandOutput>> = {}): Fake {
  return fakeCommands({ [MAIN_PID]: { stdout: '4242\n' }, ...answers });
}
const own: Partial<ServiceOptions> = { serveAnswers: async () => true, servePid: async () => 4242, serveBusy: async () => [] };

test('sf service install, while the service\'s own sf serve answers and is idle, rewrites the unit and restarts the service without enable --now', async () => {
  const home = join(temp, 'service-reinstall');
  const fake = ownServe();
  const opts = options(home, fake, own);
  await serviceCommand('install', opts);
  assert.match(await readFile(unitPath(opts.env, home), 'utf8'), /^KillMode=process$/m);
  assert.deepEqual(fake.calls, [
    'systemctl --user show-environment',
    MAIN_PID,
    'loginctl show-user u --property=Linger',
    'systemctl --user daemon-reload',
    'systemctl --user enable software-factory',
    'systemctl --user restart software-factory',
  ]);
  assert.ok(opts.lines.some((line) => line.includes('restarted software-factory') && line.includes('pid 4242') && line.includes('KillMode=process')), opts.lines.join('\n'));
  assert.ok(opts.lines.some((line) => line.startsWith('Wrote ')));
  assert.ok(!fake.calls.some((call) => call.includes('--now')));
});

test('sf service install refuses with serve_running when the answering sf serve is not the service\'s own, or that is in doubt', async () => {
  const cases: Array<[string, Fake, Partial<ServiceOptions>]> = [
    ['another pid', ownServe({ [MAIN_PID]: { stdout: '4243\n' } }), own],
    ['no main pid', ownServe({ [MAIN_PID]: { stdout: '0\n' } }), own],
    ['show fails', ownServe({ [MAIN_PID]: { code: 1, stdout: '4242\n', stderr: 'no such unit' } }), own],
    ['no pid in ping', ownServe(), { ...own, servePid: async () => undefined }],
  ];
  for (const [name, fake, extra] of cases) {
    const home = join(temp, `service-by-hand-${name.replaceAll(' ', '-')}`);
    const opts = options(home, fake, extra);
    await assert.rejects(serviceCommand('install', opts), (error: unknown) => {
      assert.ok(error instanceof FactoryError, name);
      assert.equal(error.code, 'serve_running', name);
      assert.match(error.message, /Stop that sf serve first/);
      assert.match(error.message, /keep running/);
      return true;
    });
    assert.equal(existsSync(unitPath(opts.env, home)), false, name);
    assert.ok(!fake.calls.some(RELOADS_OR_RESTARTS), `${name}: ${fake.calls.join(', ')}`);
  }
});

test('sf service install refuses with serve_busy while a Task check or a hand-over runs in the service\'s own sf serve, and passes on serveBusy\'s error, writing nothing', async () => {
  const home = join(temp, 'service-busy');
  const fake = ownServe();
  const opts = options(home, fake, { ...own, serveBusy: async () => ['the Task check of app/T-1'] });
  await assert.rejects(serviceCommand('install', opts), (error: unknown) => {
    assert.ok(error instanceof FactoryError);
    assert.equal(error.code, 'serve_busy');
    assert.match(error.message, /pid 4242/);
    assert.match(error.message, /the Task check of app\/T-1/);
    return true;
  });
  assert.equal(existsSync(unitPath(opts.env, home)), false);
  assert.ok(!fake.calls.some(RELOADS_OR_RESTARTS), fake.calls.join(', '));

  const failing = ownServe();
  const updating = options(home, failing, { ...own, serveBusy: async () => { throw new FactoryError('update_in_progress', 'update_in_progress: sf update is running.'); } });
  await assert.rejects(serviceCommand('install', updating), (error: unknown) => error instanceof FactoryError && error.code === 'update_in_progress');
  assert.equal(existsSync(unitPath(updating.env, home)), false);
  assert.ok(!failing.calls.some(RELOADS_OR_RESTARTS), failing.calls.join(', '));
});

test('sf service install fails with systemctl_failed when the restart of the service\'s own sf serve fails', async () => {
  const home = join(temp, 'service-restart-fails');
  const fake = ownServe({ 'systemctl --user restart software-factory': { code: 1, stderr: 'boom' } });
  await assert.rejects(serviceCommand('install', options(home, fake, own)), (error: unknown) => error instanceof FactoryError && error.code === 'systemctl_failed' && /restart/.test(error.message) && /boom/.test(error.message));
});

test('without systemd user services, sf service says so', async () => {
  const home = join(temp, 'service-none');
  const fake = fakeCommands({ 'systemctl --user show-environment': { code: 1, stderr: 'Failed to connect to bus: No medium found\n' } });
  for (const command of ['install', 'status', 'uninstall']) {
    await assert.rejects(serviceCommand(command, options(home, fake)), (error: unknown) => error instanceof FactoryError && error.code === 'systemd_unavailable' && /sf serve as before/.test(error.message));
  }
  assert.equal(existsSync(join(home, 'cfg', 'systemd')), false);
});

test('sf service status shows the unit state and the journal; uninstall stops, disables and removes it', async () => {
  const home = join(temp, 'service-status');
  const fake = fakeCommands({
    'systemctl --user show software-factory --property=ActiveState,SubState,UnitFileState,MainPID': { stdout: 'ActiveState=active\nSubState=running\nUnitFileState=enabled\nMainPID=4242\n' },
  });
  const notYet = options(home, fake);
  await serviceCommand('status', notYet);
  assert.match(notYet.lines.join('\n'), /not installed/);
  await serviceCommand('install', options(home, fake));
  const shown = options(home, fake);
  await serviceCommand('status', shown);
  assert.match(shown.lines.join('\n'), /state: active \(running\), enabled/);
  assert.match(shown.lines.join('\n'), /pid: 4242/);
  assert.match(shown.lines.join('\n'), /logs: journalctl --user -u software-factory/);
  fake.calls.length = 0;
  const removed = options(home, fake);
  await serviceCommand('uninstall', removed);
  assert.deepEqual(fake.calls, ['systemctl --user show-environment', 'systemctl --user disable --now software-factory', 'systemctl --user daemon-reload']);
  assert.equal(existsSync(unitPath(removed.env, home)), false);
});

// A fake systemctl and loginctl on PATH, logging their arguments; with mainPid, systemctl prints it
// for a call that asks for the MainPID.
async function fakeBin(dir: string, systemctlExit = 0, mainPid?: number): Promise<string> {
  await mkdir(dir, { recursive: true });
  const systemctl = `${mainPid === undefined ? '' : `case "$*" in *MainPID*) echo ${mainPid};; esac\n`}exit ${systemctlExit}`;
  for (const [name, body] of [['systemctl', systemctl], ['loginctl', 'echo Linger=yes']] as const) {
    const file = join(dir, name);
    await writeFile(file, `#!/bin/sh\necho "${name} $*" >> "${join(dir, 'calls.log')}"\n${body}\n`);
    await chmod(file, 0o755);
  }
  return dir;
}

test('the CLI: sf service install writes the unit under the user config, refuses while sf serve answers; without systemd it says so', async () => {
  const bin = await fakeBin(join(temp, 'service-cli-bin'));
  const env = await newEnv('service-cli');
  env.extra = { PATH: `${bin}:${process.env.PATH}`, XDG_CONFIG_HOME: join(env.home, '.config') };
  const served = await serve(env);
  try {
    const refused = await runCli(env, ['service', 'install']);
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /serve_running/);
    assert.equal(existsSync(join(env.home, '.config', 'systemd', 'user', 'software-factory.service')), false);
  } finally {
    await stop(served);
  }
  const installed = await runCli(env, ['service', 'install']);
  assert.equal(installed.code, 0, installed.stderr);
  const unit = await readFile(join(env.home, '.config', 'systemd', 'user', 'software-factory.service'), 'utf8');
  assert.match(unit, /^KillMode=process$/m);
  assert.match(unit, /bin\/sf" serve$/m);
  assert.match(unit, /^CPUQuota=\d+00%$/m);
  assert.match(unit, /^Nice=10$/m);
  assert.match(unit, new RegExp(`^Environment="SF_STATE_DIR=${env.state}"$`, 'm'));
  assert.match(await readFile(join(bin, 'calls.log'), 'utf8'), /systemctl --user enable --now software-factory/);
  // Usage errors.
  assert.equal((await runCli(env, ['service'])).code, 2);
  const none = await fakeBin(join(temp, 'service-cli-none'), 1);
  env.extra = { PATH: `${none}:${process.env.PATH}` };
  const missing = await runCli(env, ['service', 'status']);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /systemd_unavailable/);
});

test('the CLI: sf service install, while the service\'s own sf serve answers (its pid is the MainPID), rewrites the unit and restarts the service', async () => {
  const env = await newEnv('service-cli-own');
  const served = await serve(env);
  try {
    const pid = served.child.pid!;
    const bin = await fakeBin(join(temp, 'service-cli-own-bin'), 0, pid);
    env.extra = { PATH: `${bin}:${process.env.PATH}`, XDG_CONFIG_HOME: join(env.home, '.config') };
    const installed = await runCli(env, ['service', 'install']);
    assert.equal(installed.code, 0, installed.stderr);
    assert.match(installed.stdout, new RegExp(`restarted software-factory .*pid ${pid}`));
    assert.equal(existsSync(join(env.home, '.config', 'systemd', 'user', 'software-factory.service')), true);
    const calls = await readFile(join(bin, 'calls.log'), 'utf8');
    assert.match(calls, /systemctl --user restart software-factory/);
    assert.doesNotMatch(calls, /enable --now/);
    const ping = await callSocket(env.state, { command: 'ping', args: [] });
    assert.ok(ping.ok);
    assert.equal((ping.result as { pid?: number }).pid, pid);
  } finally {
    await stop(served);
  }
});
