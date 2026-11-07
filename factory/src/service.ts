// sf service install|uninstall|status (SF-101): sf serve as a systemd user service,
// software-factory.service in ~/.config/systemd/user. The unit runs the installed sf with
// KillMode=process: the job runners are detached processes that outlive a restart of sf serve
// (SF-042), and systemd's default control-group mode would kill them on every stop, restart or crash
// restart. Its environment is the PATH of the shell that ran the install (node, git, gh, claude and
// codex are found as there) and the directory settings set in that shell; every other setting comes
// from auth.env, which sf serve reads. Logs go to journald. On a machine without systemd user
// services sf service says so, and sf serve works as before.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileAtomic } from './atomic.js';
import { FactoryError } from './errors.js';

export const SERVICE_NAME = 'software-factory';
export const UNIT_FILE = `${SERVICE_NAME}.service`;
export const JOURNAL_HINT = `journalctl --user -u ${SERVICE_NAME}`;
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
  run?: RunCommand;
  // Whether an sf serve answers on the state directory's socket.
  serveAnswers: () => Promise<boolean>;
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

// The unit's text: ExecStart of the installed sf, Restart=on-failure, KillMode=process, the PATH and
// the directory settings of the shell (COPIED_SETTINGS that are set), nothing else.
export function unitText(sf: string, env: NodeJS.ProcessEnv): string {
  const environment = [['PATH', env.PATH ?? ''] as const, ...COPIED_SETTINGS.flatMap((name) => (env[name] ? [[name, env[name]!] as const] : []))];
  return [
    '# Written by sf service install (Software Factory); sf service uninstall removes it.',
    '[Unit]',
    'Description=Software Factory (sf serve)',
    '',
    '[Service]',
    'Type=simple',
    `ExecStart=${quoted(sf)} serve`,
    'Restart=on-failure',
    'RestartSec=5',
    // The job runners are detached and must outlive a stop or restart of sf serve (SF-042).
    'KillMode=process',
    ...environment.map(([name, value]) => `Environment=${quoted(`${name}=${value}`)}`),
    '',
    '[Install]',
    'WantedBy=default.target',
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

  constructor(options: ServiceOptions) {
    this.#o = options;
    this.#run = options.run ?? runCommand;
    this.#print = options.print ?? console.log;
    this.path = unitPath(options.env, options.home ?? homedir());
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

  async install(): Promise<void> {
    await this.refuseWithoutSystemd();
    if (await this.#o.serveAnswers()) {
      throw new FactoryError(
        'serve_running',
        'serve_running: an sf serve started by hand answers on the socket, and the service would fail against it at every start. Stop that sf serve first (its jobs keep running: their runners are detached), then run sf service install again.',
      );
    }
    const sf = this.#o.sf ?? INSTALLED_SF;
    await mkdir(unitDir(this.#o.env, this.#o.home ?? homedir()), { recursive: true });
    await writeFileAtomic(this.path, Buffer.from(unitText(sf, this.#o.env), 'utf8'), 0o644);
    this.#print(`Wrote ${this.path} (ExecStart=${sf} serve, KillMode=process: the job runners outlive a restart).`);
    const uncopied = uncopiedSettings(this.#o.env, this.#o.fromEnvFile);
    if (uncopied.length > 0) {
      this.#print(`Not copied into the unit: ${uncopied.join(', ')}. Put them in auth.env (sf info shows where it is), which the service reads.`);
    }
    await this.#lingerWarning();
    await this.#must('daemon-reload');
    await this.#must('enable', '--now', SERVICE_NAME);
    this.#print(`Enabled and started ${SERVICE_NAME}. Logs: ${JOURNAL_HINT}. sf service status shows it.`);
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
    if (!existsSync(this.path)) {
      this.#print(`The service is not installed (${this.path} does not exist).`);
      return;
    }
    // disable --now stops it too; a unit already stopped or disabled is no failure.
    await this.systemctl('disable', '--now', SERVICE_NAME);
    await rm(this.path, { force: true });
    await this.#must('daemon-reload');
    this.#print(`Stopped, disabled and removed ${SERVICE_NAME} (${this.path}). Running jobs keep running; start sf serve by hand to follow them.`);
  }

  async status(): Promise<void> {
    await this.refuseWithoutSystemd();
    if (!existsSync(this.path)) {
      this.#print(`not installed (${this.path}); sf service install installs it`);
      return;
    }
    const shown = await this.systemctl('show', SERVICE_NAME, '--property=ActiveState,SubState,UnitFileState,MainPID');
    const values = new Map(shown.stdout.split('\n').map((line) => line.split('=', 2) as [string, string]).filter(([key]) => key !== ''));
    this.#print(`unit: ${this.path}`);
    this.#print(`state: ${values.get('ActiveState') ?? 'unknown'} (${values.get('SubState') ?? 'unknown'}), ${values.get('UnitFileState') ?? 'unknown'}`);
    const pid = values.get('MainPID');
    if (pid !== undefined && pid !== '0') {
      this.#print(`pid: ${pid}`);
    }
    this.#print(`logs: ${JOURNAL_HINT}`);
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
