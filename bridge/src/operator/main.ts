// Operator CLI of the SF-007 local operator component (scripts/sf007-operator.sh):
//
//   console                  the operator console in this terminal: queue, instruction, Approve & Run / Later / Reject
//   status                   print the queue (read-only)
//   render-assets <dir>      write the optional desktop launcher (opens the console in gnome-terminal), for you to install
//
// Nothing here listens on a network port, installs anything, or launches a job
// by itself: only Approve & Run, typed in the console, does, for one job.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { claudeInstallation, localExecutionService } from '../execution/local-service.js';
import type { ExecutionService } from '../execution/service.js';
import { resolveRepoRoot } from '../repo-files.js';
import { describeCoverage, runConsole } from './console.js';
import { scanQueue } from './queue.js';
import { defaultStateHome, isCodedError, OperatorStore } from './store.js';

// Compiled to bridge/dist/src/operator/main.js; the mediator is the checkout that contains it.
const MEDIATOR_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const SAFE_PATH = /^\/[A-Za-z0-9._/-]+$/;

// The production service; Claude Code's login is probed afresh for each preflight.
function service(mediatorRoot: string, base: ExecutionService): Pick<ExecutionService, 'preflight' | 'prepare' | 'run' | 'status'> {
  return {
    status: (appId, jobId) => base.status(appId, jobId),
    prepare: (appId, jobId, expected) => base.prepare(appId, jobId, expected),
    run: (appId, jobId, confirm, expected) => base.run(appId, jobId, confirm, expected),
    preflight: async (appId, jobId) => localExecutionService(mediatorRoot, await claudeInstallation()).preflight(appId, jobId),
  };
}

async function renderAssets(mediatorRoot: string, target: string | undefined): Promise<number> {
  if (target === undefined) {
    console.error('usage: sf007-operator render-assets <new-directory>');
    return 2;
  }
  const root = mediatorRoot.replace(/\/$/, '');
  if (!SAFE_PATH.test(root) || !SAFE_PATH.test(process.execPath)) {
    console.error('The mediator or node path contains characters that need quoting in a launcher; write the launcher by hand.');
    return 1;
  }
  const dir = resolve(target);
  await mkdir(dir, { mode: 0o755 });
  let text = await readFile(join(root, 'deploy', 'operator', 'sf007-operator-console.desktop.in'), 'utf8');
  for (const [key, value] of Object.entries({ '@MEDIATOR@': root, '@NODE@': process.execPath })) text = text.replaceAll(key, value);
  await writeFile(join(dir, 'sf007-operator-console.desktop'), text, { mode: 0o644, flag: 'wx' });
  console.log(`wrote ${join(dir, 'sf007-operator-console.desktop')}`);
  console.log('Nothing was installed. See docs/runbooks/SF-007-local-operator.md, "One-time setup".');
  return 0;
}

async function main(argv: string[]): Promise<number> {
  const [command = 'console', ...rest] = argv;
  const commands = ['console', 'status', 'render-assets'];
  if (!commands.includes(command) || (command !== 'render-assets' && rest.length > 0)) {
    console.error(`usage: sf007-operator <${commands.join('|')}>`);
    return 2;
  }
  const mediatorRoot = await resolveRepoRoot(MEDIATOR_ROOT);
  if (command === 'render-assets') return renderAssets(mediatorRoot, rest[0]);
  const isTTY = process.stdin.isTTY === true && process.stdout.isTTY === true;
  if (command === 'console' && !isTTY) {
    console.log('The operator console needs an interactive terminal; nothing was done.');
    return 1;
  }
  const store = await OperatorStore.open(defaultStateHome(), mediatorRoot);
  const base = localExecutionService(mediatorRoot, await claudeInstallation());
  if (command === 'status') {
    const { entries, truncation } = await scanQueue({ mediatorRoot, store, service: base, now: () => new Date() });
    for (const entry of entries) {
      console.log(`${entry.app_id}/${entry.job_id}: ${entry.status}${entry.problem ? ` (${entry.problem.code})` : ''}${entry.actions.length ? ` [${entry.actions.join(', ')}]` : ''}`);
    }
    for (const line of describeCoverage(truncation)) console.log(line);
    console.log(`${entries.length} job(s).`);
    return 0;
  }
  return runConsole({
    mediatorRoot,
    store,
    service: service(mediatorRoot, base),
    input: process.stdin,
    output: process.stdout,
    isTTY,
    now: () => new Date(),
  });
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    // Only the adapter's own messages are printed; others may carry host paths.
    console.error(`sf007-operator: ${isCodedError(error) ? `${error.code}: ${error.message}` : `unexpected ${(error as Error).name ?? 'error'}`}`);
    process.exitCode = 1;
  },
);
