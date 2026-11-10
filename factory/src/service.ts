// sf service install|uninstall|status: sf serve as a systemd user service,
// software-factory.service in ~/.config/systemd/user. The unit runs the installed sf with
// KillMode=process: the job runners are detached processes that outlive a restart of sf serve
// and systemd's default control-group mode would kill them on every stop, restart or crash
// restart. The unit caps the CPU of its whole control group (sf serve, the runners and everything
// they run) at half the cores and runs it at Nice=10, so the factory leaves the user's
// machine responsive; a drop-in overrides them. Its environment is the PATH of the shell that ran
// the install (node, git, gh, claude and codex are found as there) and the directory settings set
// in that shell; every other setting comes from auth.env, which sf serve reads. Logs go to
// journald. On a machine without systemd user services sf service says so, and sf serve works
// without it. Run while the service's own sf serve answers, install rewrites the unit and restarts the
// service; an sf serve started by hand refuses it. Next to it install writes the watchdog (sf health
// --notify, src/watchdog.ts): software-factory-watchdog.timer runs software-factory-watchdog.service
// every five minutes, and after five failed starts in five minutes systemd stops restarting the
// service and runs software-factory-alert.service (OnFailure=), which sends the alert once.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { availableParallelism, homedir, userInfo } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileAtomic } from './atomic.js';
import { FactoryError } from './errors.js';

export const SERVICE_NAME = 'software-factory';
export const UNIT_FILE = `${SERVICE_NAME}.service`;
export const JOURNAL_HINT = `journalctl --user -u ${SERVICE_NAME}`;
export const ALERT_UNIT = `${SERVICE_NAME}-alert.service`;
export const WATCHDOG_UNIT = `${SERVICE_NAME}-watchdog.service`;
export const WATCHDOG_TIMER = `${SERVICE_NAME}-watchdog.timer`;
// The files sf service install writes, the service first.
export const UNIT_FILES = [UNIT_FILE, ALERT_UNIT, WATCHDOG_UNIT, WATCHDOG_TIMER] as const;
// The restart limit: after this many failed starts within this many seconds, systemd stops
// restarting the service and runs the alert unit.
export const START_LIMIT_BURST = 5;
export const START_LIMIT_INTERVAL_S = 300;
const HEADER = '# Written by sf service install (Software Factory); sf service uninstall removes it.';
// The settings copied from the shell into the unit, when set there: where the factory's files are.
export const COPIED_SETTINGS = ['XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'SF_CONFIG_DIR', 'SF_STATE_DIR', 'SF_ENV_FILE', 'SF_WORKTREE_ROOT'] as const;

// The installed sf: bin/sf of this package (dist/src/service.js is two levels below it).
export const INSTALLED_SF = fileURLToPath(new URL('../../bin/sf', import.meta.url));

export interface CommandOutput {
  code: number | null;
  stdout: string;
  stderr: string;
}

export type RunCommand = (file: string, args: string[]) => Promise<CommandOutput>;

export const runCommand: RunCommand = (file, args) => new Promise((resolve) => {
  const child = spawn(file, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
  child.once('error', (error) => resolve({ code: null, stdout, stderr: `${stderr}${error.message}` }));
  child.once('close', (code) => resolve({ code, stdout, stderr }));
});

export interface ServiceOptions {
  // The environment of the shell that runs sf service, without what auth.env added.
  env: NodeJS.ProcessEnv;
  // The settings that auth.env set (loadEnvFile): not the shell's, never copied nor named.
  fromEnvFile?: readonly string[];
  // The absolute path of the installed sf.
  sf?: string;
  // The machine's cores, for the unit's CPUQuota; by default os.availableParallelism().
  cores?: number;
  run?: RunCommand;
  // Whether an sf serve answers on the state directory's socket.
  serveAnswers: () => Promise<boolean>;
  // The pid the answering sf serve reports; by default none.
  servePid?: () => Promise<number | undefined>;
  // What runs inside that sf serve and a restart would cut off, one line each, empty when idle;
  // by default nothing.
  serveBusy?: () => Promise<string[]>;
  print?: (line: string) => void;
  home?: string;
  user?: string;
}

// The directory of the user's units: $XDG_CONFIG_HOME/systemd/user, by default ~/.config/systemd/user.
export function unitDir(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  return join(env.XDG_CONFIG_HOME || join(home, '.config'), 'systemd', 'user');
}

export const unitPath = (env: NodeJS.ProcessEnv = process.env, home = homedir()): string => join(unitDir(env, home), UNIT_FILE);

// A value in a unit file: % is a specifier there (%%), and one quoted word holds spaces, quotes
// and backslashes.
function quoted(value: string): string {
  return `"${value.replaceAll('%', '%%').replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

// The unit's CPUQuota in percent of one core: half the cores, at least one and at most eight.
export function cpuQuota(cores: number): number {
  return Math.min(800, Math.max(100, Math.floor(cores / 2) * 100));
}

// The unit's limit settings for these cores, in the unit's order.
function limitSettings(cores: number): string[] {
  return [`CPUQuota=${cpuQuota(cores)}%`, 'Nice=10'];
}

// The Environment= lines of the units: the PATH and the directory settings of the shell
// (COPIED_SETTINGS that are set).
function environmentLines(env: NodeJS.ProcessEnv): string[] {
  const environment = [['PATH', env.PATH ?? ''] as const, ...COPIED_SETTINGS.flatMap((name) => (env[name] ? [[name, env[name]!] as const] : []))];
  return environment.map(([name, value]) => `Environment=${quoted(`${name}=${value}`)}`);
}

// The unit's text: ExecStart of the installed sf, Restart=on-failure within the start limit and the
// alert unit on failure, KillMode=process, the CPU cap for these cores and Nice=10, the PATH and the
// directory settings of the shell, nothing else.
export function unitText(sf: string, env: NodeJS.ProcessEnv, cores: number): string {
  return [
    HEADER,
    '[Unit]',
    'Description=Software Factory (sf serve)',
    `StartLimitIntervalSec=${START_LIMIT_INTERVAL_S}`,
    `StartLimitBurst=${START_LIMIT_BURST}`,
    `OnFailure=${ALERT_UNIT}`,
    '',
    '[Service]',
    'Type=simple',
    `ExecStart=${quoted(sf)} serve`,
    'Restart=on-failure',
    'RestartSec=5',
    // The job runners are detached and must outlive a stop or restart of sf serve.
    'KillMode=process',
    `# The factory must leave the user's machine responsive; a drop-in in ${UNIT_FILE}.d/ overrides these.`,
    ...limitSettings(cores),
    ...environmentLines(env),
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

// A oneshot unit that runs sf health with these arguments, in the service's environment; no
// [Install]: the timer or OnFailure= starts it.
function oneshotText(description: string, sf: string, args: string, env: NodeJS.ProcessEnv): string {
  return [HEADER, '[Unit]', `Description=${description}`, '', '[Service]', 'Type=oneshot', `ExecStart=${quoted(sf)} health ${args}`, ...environmentLines(env), ''].join('\n');
}

// The alert unit: OnFailure= of the service runs it once systemd gave up restarting it.
export function alertUnitText(sf: string, env: NodeJS.ProcessEnv): string {
  return oneshotText('Software Factory alert: systemd gave up restarting sf serve', sf, '--notify --force', env);
}

// The watchdog's unit, run by its timer.
export function watchdogUnitText(sf: string, env: NodeJS.ProcessEnv): string {
  return oneshotText('Software Factory watchdog (sf health --notify)', sf, '--notify', env);
}

// The watchdog's timer: five minutes after boot, then five minutes after each run.
export function watchdogTimerText(): string {
  return [
    HEADER,
    '[Unit]',
    'Description=Software Factory watchdog every five minutes',
    '',
    '[Timer]',
    'OnBootSec=5min',
    'OnUnitActiveSec=5min',
    `Unit=${WATCHDOG_UNIT}`,
    '',
    '[Install]',
    'WantedBy=timers.target',
    '',
  ].join('\n');
}

// The SF_* settings of the shell that the unit does not take: they belong in auth.env.
export function uncopiedSettings(env: NodeJS.ProcessEnv, fromEnvFile: readonly string[] = []): string[] {
  return Object.keys(env).filter((name) => name.startsWith('SF_') && env[name] !== undefined && !(COPIED_SETTINGS as readonly string[]).includes(name) && !fromEnvFile.includes(name)).sort();
}

class Service {
  readonly #o: ServiceOptions;
  readonly #run: RunCommand;
  readonly #print: (line: string) => void;
  readonly path: string;
  readonly dir: string;

  constructor(options: ServiceOptions) {
    this.#o = options;
    this.#run = options.run ?? runCommand;
    this.#print = options.print ?? console.log;
    this.path = unitPath(options.env, options.home ?? homedir());
    this.dir = unitDir(options.env, options.home ?? homedir());
  }

  systemctl(...args: string[]): Promise<CommandOutput> {
    return this.#run('systemctl', ['--user', ...args]);
  }

  // systemctl --user answers: the user's service manager runs.
  async refuseWithoutSystemd(): Promise<void> {
    const answer = await this.systemctl('show-environment');
    if (answer.code !== 0) {
      throw new FactoryError(
        'systemd_unavailable',
        `systemd_unavailable: this machine has no systemd user services (systemctl --user does not answer${answer.stderr.trim() !== '' ? `: ${answer.stderr.trim().split('\n')[0]}` : ''}); run sf serve as before (sf up, or sf serve in a terminal of its own).`,
      );
    }
  }

  async #must(...args: string[]): Promise<void> {
    const result = await this.systemctl(...args);
    if (result.code !== 0) {
      throw new FactoryError('systemctl_failed', `systemctl_failed: systemctl --user ${args.join(' ')} failed: ${(result.stderr || result.stdout).trim().slice(0, 500)}`);
    }
  }

  // The service's main pid: systemd's MainPID when show answers with a positive integer.
  async #mainPid(): Promise<number | undefined> {
    const shown = await this.systemctl('show', SERVICE_NAME, '--property=MainPID', '--value');
    const pid = Number(shown.stdout.trim());
    return shown.code === 0 && Number.isInteger(pid) && pid > 0 ? pid : undefined;
  }

  // While an sf serve answers, install goes on only when it is the service's own (its pid from
  // ping is the service's MainPID) and nothing runs inside it that a restart would cut off.
  // Every doubt about the pid is a hand-started sf serve. Returns that pid, or undefined when no
  // sf serve answers.
  async #ownServe(): Promise<number | undefined> {
    if (!(await this.#o.serveAnswers())) {
      return undefined;
    }
    const pid = await (this.#o.servePid ?? (async () => undefined))();
    const mainPid = await this.#mainPid();
    if (pid === undefined || mainPid === undefined || pid !== mainPid) {
      throw new FactoryError(
        'serve_running',
        'serve_running: an sf serve started by hand answers on the socket, and the service would fail against it at every start. Stop that sf serve first (its jobs keep running: their runners are detached), then run sf service install again.',
      );
    }
    const busy = await (this.#o.serveBusy ?? (async () => []))();
    if (busy.length > 0) {
      throw new FactoryError('serve_busy', `serve_busy: the service's sf serve (pid ${pid}) is running ${busy.join(', ')}; a restart now would cut it off. Run sf service install again when it has ended.`);
    }
    return pid;
  }

  async install(): Promise<void> {
    await this.refuseWithoutSystemd();
    const running = await this.#ownServe();
    const sf = this.#o.sf ?? INSTALLED_SF;
    const cores = this.#o.cores ?? availableParallelism();
    const texts: Record<(typeof UNIT_FILES)[number], string> = {
      [UNIT_FILE]: unitText(sf, this.#o.env, cores),
      [ALERT_UNIT]: alertUnitText(sf, this.#o.env),
      [WATCHDOG_UNIT]: watchdogUnitText(sf, this.#o.env),
      [WATCHDOG_TIMER]: watchdogTimerText(),
    };
    await mkdir(this.dir, { recursive: true });
    for (const name of UNIT_FILES) {
      await writeFileAtomic(join(this.dir, name), Buffer.from(texts[name], 'utf8'), 0o644);
    }
    this.#print(`Wrote ${this.path} (ExecStart=${sf} serve, KillMode=process: the job runners outlive a restart; ${limitSettings(cores).join(', ')}).`);
    this.#print(`Wrote the watchdog next to it: ${WATCHDOG_TIMER} runs sf health --notify every five minutes, and after ${START_LIMIT_BURST} failed starts in ${START_LIMIT_INTERVAL_S / 60} minutes systemd stops restarting the service and runs ${ALERT_UNIT}, which notifies you once.`);
    const uncopied = uncopiedSettings(this.#o.env, this.#o.fromEnvFile);
    if (uncopied.length > 0) {
      this.#print(`Not copied into the unit: ${uncopied.join(', ')}. Put them in auth.env (sf info shows where it is), which the service reads.`);
    }
    await this.#lingerWarning();
    await this.#must('daemon-reload');
    if (running === undefined) {
      await this.#must('enable', '--now', UNIT_FILE, WATCHDOG_TIMER);
      this.#print(`Enabled and started ${SERVICE_NAME} and its watchdog timer. Logs: ${JOURNAL_HINT}. sf service status shows it.`);
      return;
    }
    // enable --now would not restart a unit that runs; enable keeps it enabled at login.
    await this.#must('enable', UNIT_FILE);
    await this.#must('enable', '--now', WATCHDOG_TIMER);
    await this.#must('restart', UNIT_FILE);
    this.#print(`Rewrote the unit and restarted ${SERVICE_NAME} (its sf serve, pid ${running}, answered on the socket); running jobs keep running (KillMode=process). Logs: ${JOURNAL_HINT}. sf service status shows it.`);
  }

  // A logout stops the user's services unless lingering is on; the user turns it on.
  async #lingerWarning(): Promise<void> {
    const user = this.#o.user ?? userInfo().username;
    const answer = await this.#run('loginctl', ['show-user', user, '--property=Linger']);
    if (answer.code === 0 && /^Linger=yes$/m.test(answer.stdout)) {
      return;
    }
    this.#print(`warning: user lingering is off for ${user}, so a logout stops the service. Turn it on with: loginctl enable-linger ${user}`);
  }

  async uninstall(): Promise<void> {
    await this.refuseWithoutSystemd();
    const paths = UNIT_FILES.map((name) => join(this.dir, name));
    if (!paths.some((path) => existsSync(path))) {
      this.#print(`The service is not installed (${this.path} does not exist).`);
      return;
    }
    // disable --now stops them too; a unit already stopped or disabled is no failure. systemctl
    // changes nothing when one of them has no file (an install from before the watchdog), so then
    // each on its own.
    if ((await this.systemctl('disable', '--now', WATCHDOG_TIMER, UNIT_FILE)).code !== 0) {
      for (const unit of [WATCHDOG_TIMER, UNIT_FILE]) {
        await this.systemctl('disable', '--now', unit);
      }
    }
    for (const path of paths) {
      await rm(path, { force: true });
    }
    await this.#must('daemon-reload');
    this.#print(`Stopped, disabled and removed ${SERVICE_NAME} and its watchdog (${UNIT_FILES.join(', ')} in ${this.dir}). Running jobs keep running; start sf serve by hand to follow them.`);
  }

  async status(): Promise<void> {
    await this.refuseWithoutSystemd();
    if (!existsSync(this.path)) {
      this.#print(`not installed (${this.path}); sf service install installs it`);
      return;
    }
    const values = await this.#shown(SERVICE_NAME, 'ActiveState,SubState,UnitFileState,MainPID');
    this.#print(`unit: ${this.path}`);
    this.#print(`state: ${values.get('ActiveState') ?? 'unknown'} (${values.get('SubState') ?? 'unknown'}), ${values.get('UnitFileState') ?? 'unknown'}`);
    const pid = values.get('MainPID');
    if (pid !== undefined && pid !== '0') {
      this.#print(`pid: ${pid}`);
    }
    this.#print(`watchdog: ${await this.#timerLine()}`);
    this.#print(`logs: ${JOURNAL_HINT}`);
  }

  // The properties systemctl show prints for a unit, by name.
  async #shown(unit: string, properties: string): Promise<Map<string, string>> {
    const shown = await this.systemctl('show', unit, `--property=${properties}`);
    return new Map(shown.stdout.split('\n').filter((line) => line.includes('=')).map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
  }

  // The watchdog timer: active or not, and its last run.
  async #timerLine(): Promise<string> {
    if (!existsSync(join(this.dir, WATCHDOG_TIMER))) {
      return `not installed; run sf service install again to write ${WATCHDOG_TIMER}`;
    }
    const values = await this.#shown(WATCHDOG_TIMER, 'ActiveState,LastTriggerUSec');
    const last = values.get('LastTriggerUSec')?.trim();
    return `${WATCHDOG_TIMER} ${values.get('ActiveState') ?? 'unknown'}, last run ${last === undefined || last === '' || last === 'n/a' || last === '0' ? 'never' : last}`;
  }

  installed(): boolean {
    return existsSync(this.path);
  }

  async active(): Promise<boolean> {
    return (await this.systemctl('is-active', SERVICE_NAME)).stdout.trim() === 'active';
  }

  restart(): Promise<void> {
    return this.#must('restart', SERVICE_NAME);
  }

  start(): Promise<void> {
    return this.#must('start', SERVICE_NAME);
  }
}

// sf service install|uninstall|status.
export async function serviceCommand(command: string | undefined, options: ServiceOptions): Promise<void> {
  const service = new Service(options);
  if (command === 'install') {
    return service.install();
  }
  if (command === 'uninstall') {
    return service.uninstall();
  }
  if (command === 'status') {
    return service.status();
  }
  throw new FactoryError('bad_request', 'sf service needs install, uninstall or status.');
}

// The service as sf update uses it (src/update.ts): installed means its unit file exists.
export function updateService(options: ServiceOptions): { installed(): Promise<boolean>; active(): Promise<boolean>; restart(): Promise<void>; start(): Promise<void> } {
  const service = new Service(options);
  return {
    installed: async () => service.installed(),
    active: () => service.active(),
    restart: () => service.restart(),
    start: () => service.start(),
  };
}
