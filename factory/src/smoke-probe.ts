// The sandbox probe of sf smoke: what it tries (SmokeProbe), the script the smoke's Implementer
// runs (PROBE_SCRIPT, placed in the smoke repository as PROBE_SCRIPT_NAME), its command line and the
// probes the Sandbox step expects; and the socket probe of the Gate sandbox step, run inside the
// gate's wrapper.
import { PROBE_SCRIPT_NAME } from './session.js';

// What the smoke's sandbox probe tries, from the run's own directories: the canary env
// file in its config directory (by the SHA-256 of its content, never the value), the dashboard
// token, the jobs/ folder (allowed only when its listing holds the smoke's workspace) and sf.sock of
// its state, and ~/.ssh when it exists outside the sandbox (undefined: absent). The user's session
// bus, docker.sock and ~/.claude/projects, each when it exists outside the sandbox (undefined:
// absent), and a canary file the smoke makes in the home directory, always.
export interface SmokeProbe {
  canary: string;
  canarySha256: string;
  token: string;
  jobs: string;
  job: string;
  socket: string;
  ssh: string | undefined;
  dbus: string | undefined;
  docker: string | undefined;
  claudeProjects: string | undefined;
  homeCanary: string;
}

export const PROBE_OUTPUT = 'probe.json';

// A shell word in single quotes.
const quoted = (text: string): string => `'${text.replace(/'/g, `'\\''`)}'`;

// The probe's command line, run in the worktree.
export function probeCommand(probe: SmokeProbe): string {
  return [
    'node', PROBE_SCRIPT_NAME, '--canary', quoted(probe.canary), '--canary-sha256', probe.canarySha256, '--token', quoted(probe.token),
    '--jobs', quoted(probe.jobs), '--job', probe.job, '--socket', quoted(probe.socket), ...(probe.ssh !== undefined ? ['--ssh', quoted(probe.ssh)] : []),
    ...(probe.dbus !== undefined ? ['--dbus', quoted(probe.dbus)] : []), ...(probe.docker !== undefined ? ['--docker', quoted(probe.docker)] : []),
    ...(probe.claudeProjects !== undefined ? ['--claude-projects', quoted(probe.claudeProjects)] : []), '--home-canary', quoted(probe.homeCanary),
    '>', PROBE_OUTPUT,
  ].join(' ');
}

// The sandbox probe, placed in the smoke repository: it tries each path it is given and
// prints, for each probe, only {name, outcome, code}, never anything it read. The sandbox may hide a
// denied file as empty, a denied folder as an empty listing, or answer ENOENT, so a probe is
// allowed only when it sees what access would show: the canary's content by its SHA-256, a
// non-empty token, the smoke's workspace in jobs/, a connect() to sf.sock, a non-empty ~/.ssh, a
// connect() to the session bus or docker.sock, a non-empty home canary, a non-empty listing of
// ~/.claude/projects. Every other result is refused; an option not given, and SSH_AUTH_SOCK not
// set, are absent.
export const PROBE_SCRIPT = `// The sandbox probe of sf smoke. Prints only whether each access worked.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { connect } from 'node:net';

const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(\`--\${name}\`);
  return index >= 0 ? args[index + 1] : undefined;
};
const results = [];
const attempt = (name, run) => {
  try {
    results.push({ name, outcome: run() ? 'allowed' : 'refused', code: null });
  } catch (error) {
    results.push({ name, outcome: 'refused', code: typeof error?.code === 'string' ? error.code : 'ERROR' });
  }
};
attempt('auth.env', () => createHash('sha256').update(readFileSync(option('canary'))).digest('hex') === option('canary-sha256'));
attempt('dashboard-token', () => readFileSync(option('token'), 'utf8').trim() !== '');
attempt('jobs', () => readdirSync(option('jobs')).includes(option('job')));
const connected = (path) => new Promise((resolve) => {
  let client;
  const timer = setTimeout(() => {
    client?.destroy();
    resolve({ outcome: 'refused', code: 'ETIMEDOUT' });
  }, 5000);
  try {
    client = connect(path);
  } catch (error) {
    clearTimeout(timer);
    resolve({ outcome: 'refused', code: typeof error?.code === 'string' ? error.code : 'ERROR' });
    return;
  }
  client.once('connect', () => {
    clearTimeout(timer);
    client.destroy();
    resolve({ outcome: 'allowed', code: null });
  });
  client.once('error', (error) => {
    clearTimeout(timer);
    resolve({ outcome: 'refused', code: typeof error?.code === 'string' ? error.code : 'ERROR' });
  });
});
results.push({ name: 'sf.sock', ...(await connected(option('socket'))) });
if (option('ssh') === undefined) {
  results.push({ name: '~/.ssh', outcome: 'absent', code: null });
} else {
  attempt('~/.ssh', () => readdirSync(option('ssh')).length > 0);
}
results.push({ name: 'SSH_AUTH_SOCK', outcome: process.env.SSH_AUTH_SOCK ? 'allowed' : 'absent', code: null });
for (const [name, key] of [['dbus', 'dbus'], ['docker.sock', 'docker']]) {
  results.push(option(key) === undefined ? { name, outcome: 'absent', code: null } : { name, ...(await connected(option(key))) });
}
attempt('home-canary', () => readFileSync(option('home-canary'), 'utf8').trim() !== '');
if (option('claude-projects') === undefined) {
  results.push({ name: '~/.claude/projects', outcome: 'absent', code: null });
} else {
  attempt('~/.claude/projects', () => readdirSync(option('claude-projects')).length > 0);
}
process.stdout.write(\`\${JSON.stringify(results, null, 2)}\\n\`);
`;

// The probes the Sandbox step expects, each refused; absent passes for the user's paths that may be
// missing only (the home canary, which the smoke makes, never).
export const PROBES = ['auth.env', 'dashboard-token', 'jobs', 'sf.sock', '~/.ssh', 'SSH_AUTH_SOCK', 'dbus', 'docker.sock', 'home-canary', '~/.claude/projects'] as const;

// The socket probe of the Gate sandbox step, a `node -e` script run inside the gate's wrapper: it
// connects to the abstract Unix socket \0<name> (name: letters, digits and dashes), on which the
// smoke listens outside. It prints EPERM and exits 1 only on an EPERM error (the wrapper's socket
// filter), prints connected and exits 0 on a connect, and prints the error's code and exits 2
// otherwise (ETIMEDOUT after 5 s).
export function socketProbeScript(name: string): string {
  return [
    'const end = (text, code) => { process.stdout.write(`${text}\\n`); process.exit(code); };',
    "setTimeout(() => end('ETIMEDOUT', 2), 5000);",
    "const failed = (error) => (error?.code === 'EPERM' ? end('EPERM', 1) : end(String(error?.code ?? error), 2));",
    'try {',
    `  const client = require('node:net').connect('\\0${name}');`,
    "  client.once('connect', () => end('connected', 0));",
    "  client.once('error', failed);",
    '} catch (error) {',
    '  failed(error);',
    '}',
  ].join('\n');
}
